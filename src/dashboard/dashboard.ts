import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import {
  getPool, enqueueTask, getMatchProfile, upsertMatchProfile,
  upsertEntity, deleteEntityCascade, applyManualEdits, rerankAllProfileScores,
  insertInnovator, listInnovators, getInnovatorById, deleteInnovator, getInnovatorCounts,
} from '../db/index.js';
import { matchFundersForInnovator, matchInnovatorsForFunder } from '../tools/match-engine.js';
import { DOMAIN_LABELS } from '../utils/innovator-match.js';
import { computeProfileMatch } from '../utils/match.js';
import { scoreCompany, sectorsAreRanked, domainFocusLabel, pickOfficialContact } from '../utils/extractor.js';
import { inferSectorsFromText } from '../utils/inference.js';
import { inferTRL } from '../utils/trl.js';
import { getProgress } from '../utils/enrichment-progress.js';
import { createCompanyBatch, startInnovatorBatch, getBatch, batchTiming, latestBatchIds } from '../utils/reenrich-batch.js';
import { logger } from '../utils/logger.js';

const log = logger;

// Read and JSON-parse a request body (no body-parser middleware in this server).
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 1_000_000) reject(new Error('body too large')); });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// Read a raw request body as a Buffer (file uploads — .xlsx/.csv imports).
function readRawBody(req: http.IncomingMessage, maxBytes = 5_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error('file too large (max 5 MB)')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Zod schema for the targeting profile (all external input is validated).
const matchProfileSchema = z.object({
  technologies: z.array(z.string().trim().min(1)).max(100).default([]),
  target_sectors: z.array(z.string().trim().min(1)).max(50).default([]),
  target_geographies: z.array(z.string().trim().min(1)).max(50).default([]),
  keywords: z.array(z.string().trim().min(1)).max(100).default([]),
});

const createCompanySchema = z.object({
  name: z.string().trim().min(2).max(200),
  category: z.enum(['company', 'foundation', 'psu', 'bank', 'international_funder', 'govt_scheme', 'ngo']).default('company'),
});

const editCompanySchema = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  sectors: z.array(z.string().trim().min(1)).max(20).optional(),
  geographies: z.array(z.string().trim().min(1)).max(40).optional(),
  spend: z.number().nonnegative().nullable().optional(),
  score: z.number().min(0).max(100).nullable().optional(),
});

const createInnovatorSchema = z.object({
  name: z.string().trim().min(2).max(200),
  type: z.enum(['startup', 'individual', 'research_institute']).default('startup'),
  domain: z.enum(['solid_waste', 'plastic', 'wastewater', 'air_pollution', 'e_waste',
    'green_hydrogen', 'circular_economy', 'ai_medtech', 'water_body']),
  trl_current: z.number().int().min(1).max(9).nullable().optional(),
  description: z.string().trim().max(5000).optional(),
  contact_email: z.string().trim().email().optional(),
  geography: z.array(z.string().trim().min(1)).max(40).default([]),
  website: z.string().trim().url().optional(),
  usp: z.string().trim().max(2000).optional(),
  ownership_transfer_open: z.boolean().optional(),
  innovation_stage: z.enum(['ideation', 'prototype', 'pilot', 'scale', 'deployed']).optional(),
});

const bulkActionSchema = z.object({
  action: z.enum(['reenrich', 'delete', 'mark_reviewed']),
  ids: z.array(z.string().uuid()).min(1).max(500),
});

// Build the profile-match input from a flattened company. Coerces fields to
// arrays defensively — some legacy entities stored non-array sector/geo values.
function asArray(x: unknown): string[] {
  if (Array.isArray(x)) return x.map(String);
  if (x === null || x === undefined || x === '') return [];
  return [String(x)];
}
function companyMatchInput(c: any) {
  const sectors = asArray(c.sectorFocus);
  const geographies = asArray(c.geographyFocus);
  const description = [
    c.rawNotes ?? '', c.name ?? '', sectors.join(' '), asArray(c.keyPrograms).join(' '),
  ].join(' ');
  return { sectors, geographies, description, domain_focus: asArray(c.domainFocus) };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to flatten entity from data JSONB column for dashboard compatibility
function flattenCompany(row: any) {
  if (!row) return null;
  const data = row.data || {};
  
  // Extract financial values (handle nested/straight definitions)
  let csrSpendActualCr = 0;
  if (data.csr_spend_cr && data.csr_spend_cr.value) {
    const values = Object.values(data.csr_spend_cr.value) as number[];
    csrSpendActualCr = values.length > 0 ? values[0] : 0;
  }

  return {
    id: row.id,
    name: row.name,
    legalName: data.legal_name || row.name,
    category: row.category,
    status: row.status,
    priority: row.priority,
    cin: row.cin,
    csrSpendActualCr,
    driftScores: row.drift_scores ? {
      sector: row.drift_scores.sector_drift || 0,
      geography: row.drift_scores.geo_drift || 0,
      requirement: row.drift_scores.requirement_drift || 0,
      openness: row.drift_scores.openness_drift || 0,
      composite: row.drift_scores.composite_drift || 0,
    } : null,
    stockTicker: data.stockTicker || null,
    stockMarketData: data.stockMarketData || null,
    newsData: data.newsData || [],
    sectorFocus: data.sector_focus?.value || [],
    geographyFocus: data.geography_focus?.value || [],
    implementingMode: data.implementing_mode?.value || null,
    acceptsProposals: data.accepts_proposals?.value ?? null,
    requiredRegistrations: data.required_registrations?.value || [],
    minTrackRecordYrs: data.min_track_record_yrs?.value || null,
    portalUrl: data.application_url?.value || null,
    // Primary contact: extracted email, else the best OFFICIAL channel from key
    // contacts (Company Secretary → IR → CSR → general) — personal exec emails
    // are rarely public, so an official mailbox beats showing "Not found".
    contactEmail: data.contact_email?.value
      || pickOfficialContact(Array.isArray(data.key_contacts) ? data.key_contacts : [])?.email
      || null,
    // New detailed fields
    keyPrograms: data.key_programs?.value || [],
    foundationName: data.foundation_name?.value || null,
    grantSizeRange: data.grant_size_range_cr?.value || null,
    pastNgoPartners: data.past_ngo_partners?.value || [],
    deadlineInfo: data.deadline_info?.value || null,
    csrCommitteeChair: data.csr_committee_chair?.value || null,
    inferredSectors: data.inferred_sectors || null,
    inferredGeographies: data.inferred_geographies || null,
    estimatedSpend: data.estimated_spend_cr || null,
    // TRL: persisted from enrichment, else inferred on the fly for legacy rows.
    trl: data.trl || inferTRL([
      Array.isArray(data.key_programs?.value) ? data.key_programs.value.join(' ') : '',
      data.raw_notes || '',
      Array.isArray(data.sector_focus?.value) ? data.sector_focus.value.join(' ') : '',
    ].join(' ')),
    profileMatchScore: typeof row.profile_match_score === 'number' ? row.profile_match_score : 0,
    website: data.website || null,
    sectorConfidence: data.sector_confidence ?? null,
    keyContacts: Array.isArray(data.key_contacts) ? data.key_contacts : [],
    domainFocus: Array.isArray(data.domain_focus) ? data.domain_focus : [],
    mouHistory: Array.isArray(data.mou_history) ? data.mou_history : [],
    ownershipTransferOpen: data.ownership_transfer_open ?? null,
    csrSpendByYear: data.csr_spend_cr?.value && typeof data.csr_spend_cr.value === 'object' ? data.csr_spend_cr.value : {},
    // Primary ("Top") sector. Priority:
    //  1. Industry inferred from the NAME ONLY (specific, e.g. Cipla → Healthcare,
    //     ITC → Rural Development, bank → Financial Inclusion). This is the most
    //     industry-appropriate label and avoids the generic-ESG "Environment"
    //     that dominates raw keyword frequency. We feed ONLY the name — extracted
    //     sector words like "Healthcare" would falsely trigger the pharma rule.
    //  2. Highest-confidence EXTRACTED sector — sector_focus[0] WHEN the list is
    //     frequency-ranked (used only when the name carries no industry signal).
    //  3. null → the UI shows "—". We never default to "Education".
    topSector: (function () {
      const inferred = inferSectorsFromText(String(row.name), 3).sectors;
      if (inferred[0]) return inferred[0];
      const sectorsArr: string[] = Array.isArray(data.sector_focus?.value) ? data.sector_focus.value : [];
      if (sectorsAreRanked(sectorsArr)) return sectorsArr[0];
      return null;
    })(),
    manualOverrides: data.manual_overrides || {},
    manualScore: typeof data.manual_score === 'number' ? data.manual_score : null,
    manualAdded: data.manual_added || false,
    autoDiscovered: data.auto_discovered || false,
    discoverySource: data.discovery_source || null,
    enrichedAt: data.enriched_at || null,
    extractionCount: data.extraction_count || 0,
    verifiedAt: data.verified_at || null,
    verificationNote: data.verification_note || null,
    // Column first; legacy rows enriched before the column was kept in sync
    // still carry their documents in data.source_urls — fall back so real
    // documents are never invisible to the UI or the data score.
    sourceUrls: (row.source_urls && row.source_urls.length ? row.source_urls : null)
      || (Array.isArray(data.source_urls) ? data.source_urls : []),
    // Labelled per-source record of the last enrichment run (label, url,
    // success, fetched_at) — powers "which page said this, when" in the UI.
    sources: Array.isArray(data.sources) ? data.sources : [],
    // Per-field extraction provenance (primary source URL + timestamp).
    fieldMeta: {
      sectors: data.sector_focus ? { sourceUrl: data.sector_focus.source_url || null, extractedAt: data.sector_focus.extracted_at || null } : null,
      geographies: data.geography_focus ? { sourceUrl: data.geography_focus.source_url || null, extractedAt: data.geography_focus.extracted_at || null } : null,
      spend: data.csr_spend_cr ? { sourceUrl: data.csr_spend_cr.source_url || null, extractedAt: data.csr_spend_cr.extracted_at || null } : null,
      contactEmail: data.contact_email ? { sourceUrl: data.contact_email.source_url || null, extractedAt: data.contact_email.extracted_at || null } : null,
    },
    missingFields: data.missing_fields || [],
    conflictLog: data.conflict_log || row.conflict_log || [],
    rawNotes: data.raw_notes || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function flattenScheme(row: any) {
  if (!row) return null;
  const data = row.data || {};
  const description = data.description || 'Government Welfare Program details.';
  const eligibilityText = data.eligibility_text || '';
  return {
    id: row.id,
    name: row.name,
    description,
    programType: 'govt_scheme',
    status: data.status || 'active',
    ministry: data.ministry || 'Ministry of Social Justice and Empowerment',
    fundingAmount: data.funding_amount || 'Not specified',
    applicationDeadline: data.application_deadline || 'Rolling',
    eligibilityText: eligibilityText || 'See scheme portal for eligibility criteria.',
    eligibilityRules: data.eligibility_rules?.value || { operator: 'AND', requirements: ['Aadhaar Card', 'Domicile Certificate'] },
    beneficiaryTypes: data.beneficiary_types?.value || ['Low Income Families', 'Rural Citizens'],
    geographyScope: data.geography_focus?.value || ['Pan-India'],
    sectorTags: data.sector_focus?.value || ['Rural Development', 'Livelihoods'],
    trl: data.trl || inferTRL(`${description} ${eligibilityText}`),
    sourceUrl: row.source_urls?.[0] || 'https://www.myscheme.gov.in',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function flattenInnovator(row: any) {
  if (!row) return null;
  const data = row.data || {};
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    domain: row.domain,
    domainLabel: (DOMAIN_LABELS as Record<string, string>)[row.domain] || row.domain,
    description: row.description,
    website: row.website,
    contactEmail: row.contact_email,
    founderName: row.founder_name,
    trlCurrent: row.trl_current,
    trlTarget: row.trl_target,
    geography: row.geography || [],
    usp: row.usp,
    sustainabilityScore: row.sustainability_score ?? 0,
    circularityIndicators: row.circularity_indicators || {},
    ownershipTransferOpen: !!row.ownership_transfer_open,
    mouHistory: Array.isArray(row.mou_history) ? row.mou_history : [],
    keyContacts: Array.isArray(row.key_contacts) ? row.key_contacts : [],
    innovationStage: row.innovation_stage,
    annualRevenueCr: row.annual_revenue_cr != null ? Number(row.annual_revenue_cr) : null,
    fundingRaisedCr: row.funding_raised_cr != null ? Number(row.funding_raised_cr) : null,
    teamSize: row.team_size,
    patentsFiled: row.patents_filed ?? 0,
    status: row.status,
    foundingYear: data.founding_year ?? null,
    founders: data.founders ?? [],
    awards: data.awards ?? [],
    researchSummary: data.research_summary ?? null,
    researchAt: data.research_at ?? null,
    sourceUrls: data.source_urls ?? [],
    createdAt: row.created_at,
    lastUpdatedAt: row.last_updated_at,
  };
}

export function startDashboardServer(port = 3000) {
  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url || '', `http://localhost:${port}`);
    const pathname = urlObj.pathname;
    const method = req.method || 'GET';

    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // 1. Serve HTML Dashboard
      if (pathname === '/' && method === 'GET') {
        const htmlPath = path.join(__dirname, 'dashboard.html');
        if (fs.existsSync(htmlPath)) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(fs.readFileSync(htmlPath));
        } else {
          // Fallback for compiled dist/ runs where the html copy step was skipped
          // (__dirname = dist/dashboard → ../../src/dashboard/dashboard.html).
          const srcHtmlPath = path.resolve(__dirname, '../../src/dashboard/dashboard.html');
          if (fs.existsSync(srcHtmlPath)) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(fs.readFileSync(srcHtmlPath));
          } else {
            res.writeHead(404);
            res.end('Dashboard HTML file not found');
          }
        }
        return;
      }

      // 2. GET /api/stats
      if (pathname === '/api/stats' && method === 'GET') {
        const statusRes = await getPool().query(`
          SELECT status, COUNT(*) as count 
          FROM entities 
          WHERE category != 'govt_scheme' 
          GROUP BY status
        `);

        const companyCounts: Record<string, number> = {};
        let totalCompanies = 0;
        for (const row of statusRes.rows) {
          companyCounts[row.status] = Number(row.count);
          totalCompanies += Number(row.count);
        }

        const schemeRes = await getPool().query(`
          SELECT COUNT(*) as count 
          FROM entities 
          WHERE category = 'govt_scheme'
        `);
        const totalSchemes = Number(schemeRes.rows[0]?.count || 0);

        const reviewRes = await getPool().query(`
          SELECT COUNT(*) as count 
          FROM human_review_queue 
          WHERE resolved = FALSE
        `);
        const pendingReviews = Number(reviewRes.rows[0]?.count || 0);

        // Fetch Postgres queue stats
        const queueRes = await getPool().query(`
          SELECT type, status, COUNT(*) as count 
          FROM task_queue 
          GROUP BY type, status
        `);
        const queueCounts: Record<string, any> = {};
        for (const row of queueRes.rows) {
          if (!queueCounts[row.type]) {
            queueCounts[row.type] = { waiting: 0, active: 0, completed: 0, failed: 0 };
          }
          if (row.status === 'pending') queueCounts[row.type].waiting = Number(row.count);
          if (row.status === 'running') queueCounts[row.type].active = Number(row.count);
          if (row.status === 'done') queueCounts[row.type].completed = Number(row.count);
          if (row.status === 'failed') queueCounts[row.type].failed = Number(row.count);
        }

        const innovatorCounts = await getInnovatorCounts();
        const totalInnovators = Object.values(innovatorCounts).reduce((a, b) => a + b, 0);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          totalCompanies,
          companyCounts,
          totalSchemes,
          totalInnovators,
          innovatorCounts,
          pendingReviews,
          queueStatus: queueCounts
        }));
        return;
      }

      // 2b. GET /api/insights — summary insights computed from real DB data
      if (pathname === '/api/insights' && method === 'GET') {
        const profile = await getMatchProfile();
        const { rows } = await getPool().query(`SELECT name, status, profile_match_score, created_at, data FROM entities WHERE category != 'govt_scheme'`);
        const schemeRow = await getPool().query(`SELECT COUNT(*) AS c FROM entities WHERE category = 'govt_scheme'`);

        const sectorCount: Record<string, number> = {};
        const geoCount: Record<string, number> = {};
        let ready = 0, newAuto = 0, matchSum = 0;
        const weekAgo = Date.now() - 7 * 86400000;
        for (const r of rows) {
          const data = r.data || {};
          const secs: string[] = Array.isArray(data.sector_focus?.value) ? data.sector_focus.value : [];
          const geos: string[] = Array.isArray(data.geography_focus?.value) ? data.geography_focus.value : [];
          secs.forEach(s => { sectorCount[s] = (sectorCount[s] || 0) + 1; });
          geos.forEach(g => { geoCount[g] = (geoCount[g] || 0) + 1; });
          if (r.status === 'complete' || data.accepts_proposals?.value === true) ready++;
          if (data.auto_discovered && r.created_at && new Date(r.created_at).getTime() > weekAgo) newAuto++;
          matchSum += Number(r.profile_match_score) || 0;
        }
        // Best sector: prefer the user's targeted sectors, else the overall top.
        const sectorPool = profile.target_sectors.length ? profile.target_sectors : Object.keys(sectorCount);
        let bestSector: string | null = null, bestSectorN = 0;
        for (const s of sectorPool) { const n = sectorCount[s] || 0; if (n > bestSectorN) { bestSectorN = n; bestSector = s; } }
        let topGeo: string | null = null, topGeoN = 0;
        for (const g of Object.keys(geoCount)) { if (geoCount[g] > topGeoN) { topGeoN = geoCount[g]; topGeo = g; } }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          totalCompanies: rows.length,
          bestSector, bestSectorCount: bestSectorN,
          topGeography: topGeo, topGeographyCount: topGeoN,
          readyToContact: ready,
          autoDiscoveredThisWeek: newAuto,
          schemesOpen: Number(schemeRow.rows[0]?.c || 0),
          averageMatch: rows.length ? Math.round(matchSum / rows.length) : 0,
        }));
        return;
      }

      // GET /api/schemes
      if (pathname === '/api/schemes' && method === 'GET') {
        const schemeRes = await getPool().query(`
          SELECT * FROM entities 
          WHERE category = 'govt_scheme' 
          ORDER BY name
        `);
        const schemes = schemeRes.rows.map(flattenScheme);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(schemes));
        return;
      }

      // GET /api/schemes/:id
      const schemeMatch = pathname.match(/^\/api\/schemes\/([a-f\d-]{36})$/i);
      if (schemeMatch && method === 'GET') {
        const schemeId = schemeMatch[1];
        const schemeRes = await getPool().query(`
          SELECT * FROM entities 
          WHERE id = $1 AND category = 'govt_scheme'
        `, [schemeId]);

        if (schemeRes.rows.length === 0) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Scheme not found' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(flattenScheme(schemeRes.rows[0])));
        return;
      }

      // 3. GET /api/companies
      if (pathname === '/api/companies' && method === 'GET') {
        const companyRes = await getPool().query(`
          SELECT * FROM entities 
          WHERE category != 'govt_scheme' 
          ORDER BY priority ASC, name ASC
        `);
        const profile = await getMatchProfile();
        const companies = companyRes.rows.map(flattenCompany).map((c: any) => ({
          ...c,
          profileMatch: computeProfileMatch(companyMatchInput(c), profile),
        }));
        // Best matches float to the top; ties keep priority then name order.
        companies.sort((a: any, b: any) =>
          (b.profileMatch.score - a.profileMatch.score) ||
          (a.priority - b.priority) ||
          String(a.name).localeCompare(String(b.name)));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(companies));
        return;
      }

      // 3b. POST /api/companies — manually add a company, then enrich it now
      if (pathname === '/api/companies' && method === 'POST') {
        const parsed = createCompanySchema.safeParse(await readJsonBody(req));
        if (!parsed.success) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid company', details: parsed.error.flatten() }));
          return;
        }
        const { name, category } = parsed.data;
        const existing = await getPool().query('SELECT id FROM entities WHERE LOWER(name) = LOWER($1)', [name]);
        if (existing.rows.length) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Company already exists', id: existing.rows[0].id }));
          return;
        }
        const id = await upsertEntity({ name, category, status: 'stub' });
        await getPool().query(`UPDATE entities SET data = data || '{"manual_added":true}'::jsonb WHERE id = $1`, [id]);
        // Enqueue at top priority so the worker picks it up immediately.
        await enqueueTask({ type: 'enrich', entity_id: id, entity_name: name, priority: 0, payload: { category }, max_attempts: 3 });
        log.info('Manual company added + enrichment queued', { name, id });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, id, name }));
        return;
      }

      // 3c. DELETE /api/companies/:id
      const deleteMatch = pathname.match(/^\/api\/companies\/([a-f\d-]{36})$/i);
      if (deleteMatch && method === 'DELETE') {
        const ok = await deleteEntityCascade(deleteMatch[1]);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ok ? { success: true } : { error: 'Company not found' }));
        return;
      }

      // 3d. PUT /api/companies/:id — edit name / manual field overrides
      const editMatch = pathname.match(/^\/api\/companies\/([a-f\d-]{36})$/i);
      if (editMatch && method === 'PUT') {
        const parsed = editCompanySchema.safeParse(await readJsonBody(req));
        if (!parsed.success) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid edit', details: parsed.error.flatten() }));
          return;
        }
        try {
          await applyManualEdits(editMatch[1], parsed.data);
        } catch (err: any) {
          if (String(err.message).includes('duplicate')) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'A company with that name already exists' }));
            return;
          }
          throw err;
        }
        log.info('Manual edit applied', { id: editMatch[1], fields: Object.keys(parsed.data) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // 4. GET /api/companies/:id
      const companyMatch = pathname.match(/^\/api\/companies\/([a-f\d-]{36})$/i);
      if (companyMatch && method === 'GET') {
        const companyId = companyMatch[1];
        const companyRes = await getPool().query(`
          SELECT * FROM entities 
          WHERE id = $1 AND category != 'govt_scheme'
        `, [companyId]);

        if (companyRes.rows.length === 0) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Company not found' }));
          return;
        }

        const rawCompany = companyRes.rows[0];
        const company = flattenCompany(rawCompany);

        const historyRes = await getPool().query(`
          SELECT * FROM change_history 
          WHERE entity_id = $1 
          ORDER BY detected_at DESC
        `, [companyId]);

        // Map change history fields to camelCase for dashboard UI
        const history = historyRes.rows.map((row: any) => ({
          id: row.id,
          entityId: row.entity_id,
          fieldName: row.field_name,
          oldValue: row.old_value,
          newValue: row.new_value,
          financialYear: row.financial_year,
          changeType: row.change_type,
          sourceUrl: row.source_url,
          detectedAt: row.detected_at
        }));

        // Map drift scores column into individual rows expected by the gauge
        const driftObj = rawCompany.drift_scores || {};
        const scores = [
          { dimension: 'sector', score: Number(driftObj.sector_drift || 0), detail: { explanation: 'Drift in focus sectors.' } },
          { dimension: 'geography', score: Number(driftObj.geo_drift || 0), detail: { explanation: 'Drift in focus states.' } },
          { dimension: 'requirement', score: Number(driftObj.requirement_drift || 0), detail: { explanation: 'Drift in requirements.' } },
          { dimension: 'openness', score: Number(driftObj.openness_drift || 0), detail: { explanation: 'Drift in proposal openness.' } }
        ];

        const profile = await getMatchProfile();
        const profileMatch = computeProfileMatch(companyMatchInput(company), profile);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ company, history, scores, profileMatch }));
        return;
      }

      // 5. POST /api/companies/:id/enrich
      const enrichMatch = pathname.match(/^\/api\/companies\/([a-f\d-]{36})\/enrich$/i);
      if (enrichMatch && method === 'POST') {
        const companyId = enrichMatch[1];
        const companyRes = await getPool().query(`
          SELECT name, category FROM entities 
          WHERE id = $1
        `, [companyId]);

        if (companyRes.rows.length === 0) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Company not found' }));
          return;
        }

        const company = companyRes.rows[0];
        const jobId = await enqueueTask({
          type: 'enrich',
          entity_id: companyId,
          entity_name: company.name,
          priority: 1,
          payload: { category: company.category },
          max_attempts: 3
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, jobId }));
        return;
      }

      // 5b. GET /api/companies/:id/enrichment-status — live progress for the
      // polling modal: in-memory run state (same process as the queue worker)
      // + queue position + last persisted enrichment time.
      const enrichStatusMatch = pathname.match(/^\/api\/companies\/([a-f\d-]{36})\/enrichment-status$/i);
      if (enrichStatusMatch && method === 'GET') {
        const id = enrichStatusMatch[1];
        const progress = getProgress(id);
        const queueRes = await getPool().query(
          `SELECT status FROM task_queue
           WHERE entity_id = $1 AND type = 'enrich' AND status IN ('pending', 'running')
           ORDER BY updated_at DESC LIMIT 1`, [id]);
        const entRes = await getPool().query(
          `SELECT data->>'enriched_at' AS enriched_at FROM entities WHERE id = $1`, [id]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          progress,
          queueStatus: queueRes.rows[0]?.status ?? null,
          lastEnrichedAt: entRes.rows[0]?.enriched_at ?? null,
        }));
        return;
      }

      // 5c. POST /api/companies/reenrich-all[?staleOnly=true] — queue a batch
      // re-enrichment of every (or every stale) company. The single background
      // worker drains the queue one company at a time, so sources are never
      // hammered in parallel. Returns immediately with a batch id.
      if (pathname === '/api/companies/reenrich-all' && method === 'POST') {
        const staleOnly = urlObj.searchParams.get('staleOnly') === 'true';
        const staleClause = staleOnly
          ? `AND (data->>'enriched_at' IS NULL OR (data->>'enriched_at')::timestamptz < NOW() - INTERVAL '30 days')`
          : '';
        const { rows } = await getPool().query(
          `SELECT id, name, category FROM entities WHERE category != 'govt_scheme' ${staleClause} ORDER BY name`);
        const taskIds: string[] = [];
        for (const r of rows) {
          // priority 5 (behind single-company re-enrich at 1); max_attempts 1 so
          // each company fetches its sources exactly once per batch.
          taskIds.push(await enqueueTask({
            type: 'enrich', entity_id: r.id, entity_name: r.name,
            priority: 5, payload: { category: r.category }, max_attempts: 1,
          }));
        }
        const batch = createCompanyBatch(taskIds);
        log.info('Re-enrich-all batch queued', { batchId: batch.id, total: batch.total, staleOnly });
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, batchId: batch.id, total: batch.total, staleOnly }));
        return;
      }

      // 5d. GET /api/companies/reenrich-all/:batchId/status — live batch progress
      // with a running-average time estimate.
      const batchStatusMatch = pathname.match(/^\/api\/companies\/reenrich-all\/([a-f\d-]{36})\/status$/i);
      if (batchStatusMatch && method === 'GET') {
        const batch = getBatch(batchStatusMatch[1]);
        if (!batch || batch.kind !== 'company') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Batch not found' }));
          return;
        }
        const { rows } = await getPool().query(
          `SELECT status, COUNT(*)::int AS n FROM task_queue WHERE id = ANY($1::uuid[]) GROUP BY status`,
          [batch.taskIds]);
        const byStatus: Record<string, number> = {};
        for (const r of rows) byStatus[r.status] = r.n;
        const done = byStatus.done ?? 0;
        const failed = byStatus.failed ?? 0;
        const running = byStatus.running ?? 0;
        const queued = (byStatus.pending ?? 0) + running;
        const curRes = running
          ? await getPool().query(
              `SELECT entity_id, entity_name FROM task_queue WHERE id = ANY($1::uuid[]) AND status = 'running' LIMIT 1`,
              [batch.taskIds])
          : { rows: [] as any[] };
        const cur = curRes.rows[0] ?? null;
        const curProgress = cur ? getProgress(cur.entity_id) : null;
        const finished = done + failed >= batch.total;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          total: batch.total, done, queued, failed,
          current_company_name: cur?.entity_name ?? null,
          current_source: curProgress?.stage ?? null,
          state: finished ? 'done' : 'running',
          ...batchTiming(batch.createdAt, done + failed, queued),
        }));
        return;
      }

      // 5e. POST /api/innovators/reenrich-all[?staleOnly=true] — same pattern for
      // innovators; they have no task queue, so a local p-queue (concurrency 1)
      // drains them sequentially in the background.
      if (pathname === '/api/innovators/reenrich-all' && method === 'POST') {
        const staleOnly = urlObj.searchParams.get('staleOnly') === 'true';
        const staleClause = staleOnly
          ? `WHERE data->>'research_at' IS NULL OR (data->>'research_at')::timestamptz < NOW() - INTERVAL '30 days'`
          : '';
        const { rows } = await getPool().query(`SELECT id, name FROM innovators ${staleClause} ORDER BY name`);
        const { enrichInnovator } = await import('../tools/innovator-research.js');
        const batch = startInnovatorBatch(rows.map((r: any) => ({ id: r.id, name: r.name })), enrichInnovator);
        log.info('Innovator re-enrich-all batch started', { batchId: batch.id, total: batch.total, staleOnly });
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, batchId: batch.id, total: batch.total, staleOnly }));
        return;
      }

      // 5f. GET /api/innovators/reenrich-all/:batchId/status
      const innBatchStatusMatch = pathname.match(/^\/api\/innovators\/reenrich-all\/([a-f\d-]{36})\/status$/i);
      if (innBatchStatusMatch && method === 'GET') {
        const batch = getBatch(innBatchStatusMatch[1]);
        if (!batch || batch.kind !== 'innovator') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Batch not found' }));
          return;
        }
        const doneAll = batch.done + batch.failed;
        const queued = batch.total - doneAll;
        const curProgress = batch.currentId ? getProgress(batch.currentId) : null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          total: batch.total, done: batch.done, queued, failed: batch.failed,
          current_company_name: batch.currentName,
          current_source: curProgress?.stage ?? null,
          state: batch.finishedAt ? 'done' : 'running',
          ...batchTiming(batch.createdAt, doneAll, queued, batch.finishedAt),
        }));
        return;
      }

      // 5g. GET /api/reenrich-all/active — most recent batch id per kind, so a
      // fresh page load can attach to an in-flight batch started elsewhere.
      if (pathname === '/api/reenrich-all/active' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(latestBatchIds()));
        return;
      }

      // 6. POST /api/discover
      if (pathname === '/api/discover' && method === 'POST') {
        import('../agents/discovery.agent.js')
          .then(m => m.runDiscoveryAgent())
          .then(() => log.info('Background manual discovery pass finished'))
          .catch(err => log.error('Background manual discovery pass failed', { error: err.message }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Discovery pass initiated' }));
        return;
      }

      // 6b. POST /api/auto-discover — run sector-driven discovery now
      if (pathname === '/api/auto-discover' && method === 'POST') {
        import('../agents/discovery.agent.js')
          .then(m => m.runAutoDiscovery())
          .then(r => log.info('Manual auto-discovery finished', r))
          .catch(err => log.error('Manual auto-discovery failed', { error: err.message }));
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Auto-discovery started' }));
        return;
      }

      // 7. GET /api/reviews
      if (pathname === '/api/reviews' && method === 'GET') {
        const reviewRes = await getPool().query(`
          SELECT h.*, e.name as entity_name 
          FROM human_review_queue h
          JOIN entities e ON h.entity_id = e.id
          WHERE h.resolved = FALSE 
          ORDER BY h.created_at DESC
        `);
        // Map fields to match what dashboard expects
        const reviews = reviewRes.rows.map((r: any) => {
          let flaggedFields: string[] = [];
          if (r.details) {
            if (Array.isArray(r.details.merged_fields)) {
              flaggedFields = r.details.merged_fields;
            } else if (Array.isArray(r.details.conflicts)) {
              flaggedFields = r.details.conflicts.map((c: any) => c.field || c.fieldName || String(c));
            } else if (r.details.field) {
              flaggedFields = [r.details.field];
            } else if (r.details.fields) {
              flaggedFields = Array.isArray(r.details.fields) ? r.details.fields : [r.details.fields];
            } else if (r.details.attempted_urls) {
              flaggedFields = ['source_urls'];
            }
          }
          return {
            id: r.id,
            entityId: r.entity_id,
            entityName: r.entity_name,
            reason: r.reason,
            conflictDetails: r.details,
            flaggedFields,
            status: r.resolved ? 'resolved' : 'pending',
            createdAt: r.created_at
          };
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reviews));
        return;
      }

      // 8. POST /api/reviews/:id/resolve
      const resolveMatch = pathname.match(/^\/api\/reviews\/([a-f\d-]{36})\/resolve$/i);
      if (resolveMatch && method === 'POST') {
        const reviewId = resolveMatch[1];
        await getPool().query(`
          UPDATE human_review_queue 
          SET resolved = TRUE 
          WHERE id = $1
        `, [reviewId]);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // 8b. GET /api/match-profile — the user's targeting profile
      if (pathname === '/api/match-profile' && method === 'GET') {
        const profile = await getMatchProfile();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(profile));
        return;
      }

      // 8c. POST /api/match-profile — save the targeting profile
      if (pathname === '/api/match-profile' && method === 'POST') {
        const parsed = matchProfileSchema.safeParse(await readJsonBody(req));
        if (!parsed.success) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid profile', details: parsed.error.flatten() }));
          return;
        }
        await upsertMatchProfile(parsed.data);
        // Immediately recompute every company's persisted profile_match_score so
        // the dashboard can re-rank best matches to the top right away.
        const reranked = await rerankAllProfileScores();
        log.info('Match profile updated + reranked', {
          sectors: parsed.data.target_sectors.length,
          geographies: parsed.data.target_geographies.length,
          technologies: parsed.data.technologies.length,
          reranked,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, profile: parsed.data, reranked }));
        return;
      }

      // 9. GET /api/export/csv — download companies (all, or ?ids=a,b,c) as CSV
      if (pathname === '/api/export/csv' && method === 'GET') {
        const idsParam = urlObj.searchParams.get('ids');
        const wantIds = idsParam ? idsParam.split(',').map(s => s.trim()).filter(Boolean) : null;
        const companyRes = await getPool().query(`
          SELECT * FROM entities
          WHERE category != 'govt_scheme'
          ORDER BY profile_match_score DESC, priority ASC, name ASC
        `);
        let companies = companyRes.rows.map(flattenCompany) as any[];
        if (wantIds) { const set = new Set(wantIds); companies = companies.filter(c => set.has(c.id)); }

        const headers = [
          'Name', 'CIN', 'Category', 'Status', 'Sectors', 'Geographies', 'Domain Focus',
          'CSR Spend (Cr)', 'Estimated Spend (Cr)', 'Score', 'Profile Match Score',
          'TRL Range', 'Accepts Proposals', 'Contact Email', 'Website',
          'CEO Name', 'CEO Email', 'MD Name', 'MD Email', 'CSR Head Name', 'CSR Head Email',
          'Data Sources', 'Source Confidence', 'Inferred Sectors', 'Inferred Geographies',
          'Auto-discovered', 'Last Enriched', 'Created At',
        ];
        const esc = (v: any): string => {
          const s = v === null || v === undefined ? ''
            : Array.isArray(v) ? v.join('; ')
            : String(v);
          return '"' + s.replace(/"/g, '""') + '"';
        };
        // First extracted contact holding a given title (CEO/MD/CSR Head columns).
        const contactFor = (c: any, title: string) =>
          (c.keyContacts || []).find((k: any) => k && k.title === title) || {};
        const lines = companies.map(c => {
          const dataScore = typeof c.manualScore === 'number' ? c.manualScore : scoreCompany({
            sectors: c.sectorFocus || [], geographies: c.geographyFocus || [],
            spend: Number(c.csrSpendActualCr) > 0 ? Number(c.csrSpendActualCr) : null,
            hasDocument: (c.sourceUrls || []).length > 0, hasContactInfo: !!c.contactEmail,
          });
          const ceo = contactFor(c, 'CEO'), md = contactFor(c, 'Managing Director'), csrHead = contactFor(c, 'CSR Head');
          return [
            c.name, c.cin, c.category, c.status, c.sectorFocus, c.geographyFocus,
            (c.domainFocus || []).map((d: string) => domainFocusLabel(d)),
            Number(c.csrSpendActualCr) > 0 ? c.csrSpendActualCr : '',
            c.estimatedSpend && c.estimatedSpend.value != null ? c.estimatedSpend.value : '',
            dataScore, c.profileMatchScore,
            c.trl && c.trl.label ? c.trl.label : '',
            c.acceptsProposals === null ? '' : (c.acceptsProposals ? 'Yes' : 'No'),
            c.contactEmail, c.website || c.portalUrl,
            ceo.name || '', ceo.email || '', md.name || '', md.email || '', csrHead.name || '', csrHead.email || '',
            (c.sourceUrls || []).length,
            c.sectorConfidence && typeof c.sectorConfidence === 'object'
              ? Object.entries(c.sectorConfidence).map(([k, v]) => `${k}: ${v}`).join('; ')
              : c.sectorConfidence ?? '',
            c.inferredSectors && c.inferredSectors.value ? c.inferredSectors.value : [],
            c.inferredGeographies && c.inferredGeographies.value ? c.inferredGeographies.value : [],
            c.autoDiscovered ? 'Yes' : 'No', c.enrichedAt || '', c.createdAt,
          ].map(esc).join(',');
        });
        const csv = [headers.map(esc).join(','), ...lines].join('\r\n');

        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="csr-companies.csv"',
        });
        res.end(csv);
        return;
      }

      // 9b. GET /api/schemes/export/csv — download welfare schemes as CSV
      if (pathname === '/api/schemes/export/csv' && method === 'GET') {
        const schemeRes = await getPool().query(`SELECT * FROM entities WHERE category = 'govt_scheme' ORDER BY name`);
        const schemes = schemeRes.rows.map(flattenScheme) as any[];
        const headers = ['Name', 'Ministry', 'Status', 'Sectors', 'Geographies', 'Funding Amount',
          'Application Deadline', 'TRL Range', 'Eligibility', 'Beneficiaries', 'Source URL'];
        const esc = (v: any): string => {
          const s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('; ') : String(v);
          return '"' + s.replace(/"/g, '""') + '"';
        };
        const lines = schemes.map(s => [
          s.name, s.ministry, s.status, s.sectorTags, s.geographyScope, s.fundingAmount,
          s.applicationDeadline, s.trl && s.trl.label ? s.trl.label : '', s.eligibilityText,
          s.beneficiaryTypes, s.sourceUrl,
        ].map(esc).join(','));
        const csv = [headers.map(esc).join(','), ...lines].join('\r\n');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="welfare-schemes.csv"',
        });
        res.end(csv);
        return;
      }

      // 10. POST /api/companies/bulk — bulk re-enrich / delete / mark-reviewed
      if (pathname === '/api/companies/bulk' && method === 'POST') {
        const parsed = bulkActionSchema.safeParse(await readJsonBody(req));
        if (!parsed.success) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid bulk request', details: parsed.error.flatten() }));
          return;
        }
        const { action, ids } = parsed.data;
        let affected = 0;
        if (action === 'delete') {
          for (const id of ids) { if (await deleteEntityCascade(id)) affected++; }
        } else if (action === 'reenrich') {
          const r = await getPool().query(`SELECT id, name, category FROM entities WHERE id = ANY($1)`, [ids]);
          for (const row of r.rows) {
            await enqueueTask({ type: 'enrich', entity_id: row.id, entity_name: row.name, priority: 1, payload: { category: row.category }, max_attempts: 3 });
            affected++;
          }
        } else if (action === 'mark_reviewed') {
          const r = await getPool().query(`UPDATE human_review_queue SET resolved = TRUE WHERE entity_id = ANY($1) AND resolved = FALSE`, [ids]);
          affected = r.rowCount ?? 0;
        }
        log.info('Bulk action applied', { action, count: ids.length, affected });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, action, affected }));
        return;
      }

      // 11. POST /api/bootstrap-discover — seed 100+ companies now (background)
      if (pathname === '/api/bootstrap-discover' && method === 'POST') {
        import('../agents/discovery.agent.js')
          .then(m => m.runBootstrapDiscovery())
          .then(r => log.info('Bootstrap discovery finished', r))
          .catch(err => log.error('Bootstrap discovery failed', { error: err.message }));
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Bootstrap discovery started' }));
        return;
      }

      // 12. POST /api/schemes/refresh — (re)seed curated welfare schemes
      if (pathname === '/api/schemes/refresh' && method === 'POST') {
        const { seedWelfareSchemes } = await import('../tools/schemes-seed.js');
        const r = await seedWelfareSchemes();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, ...r }));
        return;
      }

      // ─── Innovators (Side B) ───────────────────────────────────────────────

      // 13. GET /api/innovators — all innovators, flattened for the UI
      if (pathname === '/api/innovators' && method === 'GET') {
        const rows = await listInnovators();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows.map(flattenInnovator)));
        return;
      }

      // 13b. POST /api/innovators — add an innovator, then deep-research it in
      // the background across the free sources (IndiaCSR/Wikipedia/Screener).
      if (pathname === '/api/innovators' && method === 'POST') {
        const parsed = createInnovatorSchema.safeParse(await readJsonBody(req));
        if (!parsed.success) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid innovator', details: parsed.error.flatten() }));
          return;
        }
        const inn = parsed.data;
        const existing = await getPool().query('SELECT id FROM innovators WHERE LOWER(name) = LOWER($1)', [inn.name]);
        if (existing.rows.length) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Innovator already exists', id: existing.rows[0].id }));
          return;
        }
        const id = await insertInnovator(inn);
        import('../tools/innovator-research.js')
          .then(m => m.enrichInnovator(id))
          .then(ok => log.info('Innovator deep research finished', { id, name: inn.name, foundSources: ok }))
          .catch(err => log.error('Innovator deep research failed', { id, error: err.message }));
        log.info('Innovator added + research started', { name: inn.name, id });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, id, name: inn.name }));
        return;
      }

      // 13d. GET /api/innovators/import-template — blank .xlsx with headers
      if (pathname === '/api/innovators/import-template' && method === 'GET') {
        const { buildImportTemplate } = await import('../tools/innovator-import.js');
        const buf = buildImportTemplate();
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="innovator-import-template.xlsx"',
          'Content-Length': buf.length,
        });
        res.end(buf);
        return;
      }

      // 13e. POST /api/innovators/import — bulk import from .xlsx/.csv upload.
      // Body = raw file bytes; original filename passed as ?filename= (drives
      // csv-vs-xlsx parsing). Each row is Zod-validated; valid non-duplicate
      // rows are inserted and deep-researched in the background.
      if (pathname === '/api/innovators/import' && method === 'POST') {
        const filename = urlObj.searchParams.get('filename') || 'upload.xlsx';
        if (!/\.(xlsx|csv)$/i.test(filename)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unsupported file type — upload .xlsx or .csv' }));
          return;
        }
        let buf: Buffer;
        try { buf = await readRawBody(req); } catch (err: any) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        if (!buf.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Empty upload' }));
          return;
        }
        const { parseInnovatorImport, summariseImport } = await import('../tools/innovator-import.js');
        let parsed: ReturnType<typeof parseInnovatorImport>;
        try { parsed = parseInnovatorImport(buf, filename); } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Could not parse file: ${err.message}` }));
          return;
        }

        const duplicates: string[] = [];
        const insertedIds: string[] = [];
        for (const row of parsed.rows) {
          const existing = await getPool().query('SELECT id FROM innovators WHERE LOWER(name) = LOWER($1)', [row.name]);
          if (existing.rows.length) { duplicates.push(row.name); continue; }
          const id = await insertInnovator({
            name: row.name, type: row.type, domain: row.domain,
            trl_current: row.trl_current, trl_target: row.trl_target,
            description: row.description, contact_email: row.contact_email,
            founder_name: row.founder_name, geography: row.geography, website: row.website,
          });
          insertedIds.push(id);
        }

        // Deep-research the new rows in the background, one at a time so the
        // free sources aren't hammered by a large import.
        if (insertedIds.length) {
          import('../tools/innovator-research.js').then(async m => {
            for (const id of insertedIds) {
              await m.enrichInnovator(id).catch(err =>
                log.error('Import background research failed', { id, error: err.message }));
            }
            log.info('Import background research finished', { count: insertedIds.length });
          }).catch(err => log.error('Import background research could not start', { error: err.message }));
        }

        const summary = summariseImport(insertedIds.length, parsed.errors, duplicates);
        log.info('Innovator import', { file: filename, imported: insertedIds.length, skipped: parsed.errors.length, duplicates: duplicates.length });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true, summary,
          imported: insertedIds.length, ids: insertedIds,
          skipped: parsed.errors, duplicates,
        }));
        return;
      }

      // 13c. GET/DELETE /api/innovators/:id
      const innovatorMatch = pathname.match(/^\/api\/innovators\/([a-f\d-]{36})$/i);
      if (innovatorMatch && method === 'GET') {
        const row = await getInnovatorById(innovatorMatch[1]);
        if (!row) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Innovator not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(flattenInnovator(row)));
        return;
      }
      if (innovatorMatch && method === 'DELETE') {
        const ok = await deleteInnovator(innovatorMatch[1]);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ok ? { success: true } : { error: 'Innovator not found' }));
        return;
      }

      // ─── Match engine (core feature) ───────────────────────────────────────

      // 14. GET /api/match/funders/:companyId — top innovators for a funder.
      // (Checked before the innovator route: same /api/match/ prefix.)
      const matchFunderRoute = pathname.match(/^\/api\/match\/funders\/([a-f\d-]{36})$/i);
      if (matchFunderRoute && method === 'GET') {
        const result = await matchInnovatorsForFunder(matchFunderRoute[1], 10);
        if (!result) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Funder not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ funder: { id: result.funder.id, name: result.funder.name }, matches: result.matches }));
        return;
      }

      // 14b. GET /api/match/:innovatorId — ranked funders for an innovator
      const matchInnovatorRoute = pathname.match(/^\/api\/match\/([a-f\d-]{36})$/i);
      if (matchInnovatorRoute && method === 'GET') {
        const result = await matchFundersForInnovator(matchInnovatorRoute[1], 10);
        if (!result) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Innovator not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          innovator: { id: result.innovator.id, name: result.innovator.name, domain: result.innovator.domain },
          matches: result.matches,
        }));
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    } catch (err: any) {
      log.error('Dashboard API error', { url: req.url, error: err.message });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error', detail: err.message }));
    }
  });

  server.listen(port, () => {
    log.info(`Dashboard web server listening on http://localhost:${port}`);
  });

  return server;
}
export default startDashboardServer;
