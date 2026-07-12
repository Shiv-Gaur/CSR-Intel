import 'dotenv/config';
import pRetry from 'p-retry';
import { getPool, upsertEntity, updateEntityData, enqueueTask, getMatchProfile } from '../db/index.js';
import { searchWeb, fetchAuto } from '../tools/fetcher.js';
import { getKnownUrls } from '../tools/known-urls.js';
import { extractCompanyNames } from '../utils/ner.js';
import { EXPANDED_COMPANIES } from '../tools/company-seed.js';
import { logger } from '../utils/logger.js';

// ─── Priority seed list — top companies to discover first ────────────────────

const PRIORITY_ENTITIES = [
  // P1 — large private, known NGO-facing
  { name: 'Tata Consultancy Services', category: 'company', priority: 1 },
  { name: 'Tata Trusts', category: 'foundation', priority: 1 },
  { name: 'Mahindra & Mahindra', category: 'company', priority: 1 },
  { name: 'Reliance Foundation', category: 'foundation', priority: 1 },
  { name: 'Infosys Foundation', category: 'foundation', priority: 1 },
  { name: 'HUL - Hindustan Unilever', category: 'company', priority: 1 },
  { name: 'HDFC Bank', category: 'bank', priority: 1 },
  { name: 'Wipro', category: 'company', priority: 1 },
  { name: 'Bajaj Auto', category: 'company', priority: 1 },
  { name: 'Cipla', category: 'company', priority: 1 },
  { name: 'Larsen & Toubro', category: 'company', priority: 1 },
  { name: 'Kotak Mahindra Bank', category: 'bank', priority: 1 },
  { name: 'Asian Paints', category: 'company', priority: 1 },
  { name: 'Godrej Group', category: 'company', priority: 1 },
  { name: 'ITC Limited', category: 'company', priority: 1 },
  // P2 — PSUs and large banks
  { name: 'State Bank of India', category: 'psu', priority: 2 },
  { name: 'ONGC', category: 'psu', priority: 2 },
  { name: 'NTPC', category: 'psu', priority: 2 },
  { name: 'BHEL', category: 'psu', priority: 2 },
  { name: 'Punjab National Bank', category: 'bank', priority: 2 },
  { name: 'Bank of Baroda', category: 'bank', priority: 2 },
  { name: 'Indian Oil Corporation', category: 'psu', priority: 2 },
  // P3 — International funders
  { name: 'Ford Foundation India', category: 'international_funder', priority: 3 },
  { name: 'Bill & Melinda Gates Foundation India', category: 'international_funder', priority: 3 },
  { name: 'Omidyar Network India', category: 'international_funder', priority: 3 },
  { name: 'MacArthur Foundation India', category: 'international_funder', priority: 3 },
  { name: 'Skoll Foundation', category: 'international_funder', priority: 3 },
  { name: 'USAID India', category: 'international_funder', priority: 3 },
  { name: 'Azim Premji Philanthropic Initiatives', category: 'foundation', priority: 1 },
];

// ─── Source URL patterns per entity type ─────────────────────────────────────

function buildSearchQueries(name: string, category: string): string[] {
  // Return multiple targeted queries for better coverage
  const queries: string[] = [];

  switch (category) {
    case 'company':
      queries.push(
        `"${name}" CSR annual report 2024`,
        `"${name}" corporate social responsibility policy NGO`,
      );
      break;
    case 'foundation':
      queries.push(
        `"${name}" grants eligibility apply NGO 2024`,
        `"${name}" foundation official website programs`,
      );
      break;
    case 'psu':
      queries.push(
        `"${name}" CSR activities annual report 2024`,
        `"${name}" CSR policy NGO grants`,
      );
      break;
    case 'bank':
      queries.push(
        `"${name}" CSR policy 2024 NGO grants`,
        `"${name}" annual report corporate social responsibility`,
      );
      break;
    case 'international_funder':
      queries.push(
        `"${name}" India grants apply eligibility 2024`,
        `"${name}" India grant making programs`,
      );
      break;
    case 'govt_scheme':
      queries.push(
        `"${name}" site:myscheme.gov.in`,
        `"${name}" site:india.gov.in eligibility`,
      );
      break;
    default:
      queries.push(`"${name}" CSR 2024`);
  }

  return queries;
}

// ─── Main discovery agent logic ───────────────────────────────────────────────

async function discoverEntity(name: string, category: string, priority: number): Promise<void> {
  logger.info('Discovering entity', { name, category, priority });

  // 1. Check known URL seeds first — guaranteed to work even when search is down
  const knownSeed = getKnownUrls(name);
  const knownUrls = knownSeed?.urls ?? [];

  if (knownUrls.length > 0) {
    logger.info('Using known URL seeds', { name, knownUrlCount: knownUrls.length });
  }

  // 2. Run web search for additional URLs (may fail under rate limiting, that's OK)
  const queries = buildSearchQueries(name, category);
  const searchUrls: string[] = [];

  for (const query of queries) {
    try {
      const urls = await searchWeb(query);
      searchUrls.push(...urls);
    } catch (err: any) {
      logger.debug('Search query failed during discovery', { query, error: err.message });
    }
  }

  // 3. Combine known + searched, deduplicate
  const uniqueUrls = [...new Set([...knownUrls, ...searchUrls])];

  // Pick best URL
  const bestUrl = uniqueUrls.find(u =>
    category === 'foundation' ? u.includes('foundation') || u.includes('trust') || u.includes('grants') :
    category === 'international_funder' ? !u.includes('wikipedia') && (u.includes('grant') || u.includes('apply')) :
    u.includes('csr') || u.includes('annual') || u.includes('report') || u.endsWith('.pdf')
  ) ?? uniqueUrls[0] ?? null;

  // Seed the entity stub
  const entityId = await upsertEntity({
    name,
    category: category as any,
    priority: priority as 1 | 2 | 3 | 4,
    status: 'stub',
    cin: knownSeed?.cin ?? undefined,
    source_urls: uniqueUrls.slice(0, 5),
    data: {
      discovered_search_queries: queries,
      discovered_urls_count: uniqueUrls.length,
      ticker: knownSeed?.ticker ?? null,
      website: knownSeed?.website ?? null,
    } as any,
  } as any);

  // Queue for enrichment
  await enqueueTask({
    type: 'enrich',
    entity_id: entityId,
    entity_name: name,
    priority,
    payload: { source_url: bestUrl, category, search_urls: uniqueUrls.slice(0, 5) },
    max_attempts: 3,
  });

  logger.info('Entity stub created and queued for enrichment', {
    name,
    entityId,
    bestUrl,
    totalUrls: uniqueUrls.length,
    knownUrls: knownUrls.length,
    searchUrls: searchUrls.length,
  });
}

// ─── CSR portal batch discovery (scrapes company list) ───────────────────────

async function discoverFromCSRPortal(): Promise<void> {
  // LLM removed — extracting arbitrary entities from directory/portal HTML
  // required an LLM. In deterministic mode discovery relies on the curated
  // priority list plus known URL seeds, so this branch is a no-op.
  logger.info('Directory/portal discovery skipped (deterministic LLM-free mode) — using priority list + known URLs');
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function runDiscoveryAgent(): Promise<void> {
  logger.info('=== Discovery agent starting ===');

  // 1. Seed from priority list
  for (const entity of PRIORITY_ENTITIES) {
    await pRetry(
      () => discoverEntity(entity.name, entity.category, entity.priority),
      { retries: 2, onFailedAttempt: (err: any) => logger.warn('Discovery retry', { name: entity.name, err: err.message || String(err) }) }
    );
  }

  // 2. Discover from CSR portal (additional entities)
  await discoverFromCSRPortal();

  const stats = await getPool().query('SELECT COUNT(*) FROM entities WHERE status = $1', ['stub']);
  logger.info('=== Discovery agent complete ===', { total_stubs: stats.rows[0].count });
}

// ─── Auto-discovery by sector (item 5) ───────────────────────────────────────

// Map our 15 canonical CSR sectors to IndiaCSR category slugs (the only
// sector-tagged discovery source that was reachable when probed, June 2026).
const SECTOR_TO_INDIACSR_SLUG: Record<string, string> = {
  'Education': 'education',
  'Healthcare': 'health',
  'Environment': 'environment',
  'Rural Development': 'rural-development',
  'Women Empowerment': 'gender-equality',
  'Skill Development': 'skill-development',
  'Sanitation': 'sanitation',
  'Drinking Water': 'water',
  'Sports': 'sports',
  'Arts & Culture': 'art-culture',
  'Technology': 'technology',
  'Poverty Alleviation': 'poverty',
  'Disaster Relief': 'disaster-management',
  'Animal Welfare': 'animal-welfare',
  'Armed Forces Veterans': 'csr',
};

const MAX_NEW_PER_RUN = 25;

/**
 * Find NEW companies working in the user's target sectors. For each target
 * sector, scrape the IndiaCSR category page, run deterministic NER to pull
 * candidate company names, keep only names not already known, and add them as
 * auto-discovered stubs queued for enrichment.
 */
export async function runAutoDiscovery(targetSectors?: string[]): Promise<{ discovered: number; candidates: number }> {
  logger.info('=== Auto-discovery starting ===');
  const profile = await getMatchProfile();
  const sectors = (targetSectors && targetSectors.length ? targetSectors : profile.target_sectors) ?? [];

  if (!sectors.length) {
    logger.info('Auto-discovery skipped — no target sectors set in profile');
    return { discovered: 0, candidates: 0 };
  }

  const { rows } = await getPool().query('SELECT LOWER(name) AS n FROM entities');
  const known = new Set<string>(rows.map((r: any) => r.n));
  const addedThisRun = new Set<string>();
  let discovered = 0;
  let candidates = 0;

  for (const sector of sectors) {
    if (discovered >= MAX_NEW_PER_RUN) break;
    const slug = SECTOR_TO_INDIACSR_SLUG[sector];
    if (!slug) continue;

    const url = `https://indiacsr.in/category/${slug}/`;
    const res = await fetchAuto(url);
    if (!res.success || !res.content.trim()) {
      logger.debug('Auto-discovery source empty', { sector, url });
      continue;
    }

    const names = extractCompanyNames(res.content);
    candidates += names.length;

    for (const name of names) {
      if (discovered >= MAX_NEW_PER_RUN) break;
      const key = name.toLowerCase();
      if (known.has(key) || addedThisRun.has(key)) continue;

      const id = await upsertEntity({ name, category: 'company', status: 'stub' });
      // Set discovery flags at the top level of the data JSONB (merge, not nested).
      await updateEntityData(id, { auto_discovered: true, discovery_source: `IndiaCSR — ${sector}`, discovery_url: url });
      await enqueueTask({ type: 'enrich', entity_id: id, entity_name: name, priority: 4, payload: { category: 'company' }, max_attempts: 3 });

      addedThisRun.add(key);
      discovered++;
      logger.info('Auto-discovered new company', { name, sector, source: url });
    }
  }

  logger.info('=== Auto-discovery complete ===', { targetSectors: sectors.length, candidates, discovered });
  return { discovered, candidates };
}

// ─── Bootstrap discovery (item: auto-discover 100+ companies) ─────────────────

// Free, keyless pages that list many Indian companies. Scraped best-effort with
// NER; silently skipped when blocked (search-free mode, see config.ts). The
// curated EXPANDED_COMPANIES list below guarantees the 100+ target regardless.
const BOOTSTRAP_SCRAPE_SOURCES = [
  { label: 'Wikipedia — largest companies in India', url: 'https://en.wikipedia.org/wiki/List_of_largest_companies_in_India' },
  { label: 'Wikipedia — CSR in India', url: 'https://en.wikipedia.org/wiki/Corporate_social_responsibility_in_India' },
  { label: 'Screener — top companies by market cap', url: 'https://www.screener.in/screens/357649/all-stocks/' },
];

/**
 * One-time (and daily) bootstrap that grows the database past 100+ entities:
 *  1) inserts the curated BSE500 large-cap seed (offline-guaranteed), then
 *  2) best-effort NER over free public listing pages for extra names.
 * All new rows are deduped, flagged auto_discovered, and queued for enrichment.
 */
export async function runBootstrapDiscovery(): Promise<{ added: number; total: number }> {
  logger.info('=== Bootstrap discovery starting ===');
  const { rows } = await getPool().query('SELECT LOWER(name) AS n FROM entities');
  const known = new Set<string>(rows.map((r: any) => r.n));
  let added = 0;

  async function addStub(rawName: string, category: string, source: string): Promise<void> {
    const name = rawName.replace(/\s+/g, ' ').trim();
    const key = name.toLowerCase();
    if (!name || known.has(key)) return;
    known.add(key);
    const id = await upsertEntity({ name, category: category as any, status: 'stub', priority: 4 });
    await updateEntityData(id, { auto_discovered: true, discovery_source: source });
    await enqueueTask({ type: 'enrich', entity_id: id, entity_name: name, priority: 5, payload: { category }, max_attempts: 3 });
    added++;
  }

  // 1. Curated expanded seed — always available, no network needed.
  for (const c of EXPANDED_COMPANIES) await addStub(c.name, c.category, 'BSE500 bootstrap seed');

  // 2. Best-effort scrape of free public listing pages (NER).
  for (const src of BOOTSTRAP_SCRAPE_SOURCES) {
    try {
      const res = await fetchAuto(src.url);
      if (!res.success || !res.content.trim()) { logger.debug('Bootstrap source empty', { url: src.url }); continue; }
      const names = extractCompanyNames(res.content);
      for (const n of names.slice(0, 80)) await addStub(n, 'company', src.label);
      logger.info('Bootstrap scrape parsed', { source: src.label, candidates: names.length });
    } catch (err: any) {
      logger.debug('Bootstrap scrape failed', { url: src.url, error: err.message });
    }
  }

  const totalRes = await getPool().query('SELECT COUNT(*) FROM entities');
  const total = Number(totalRes.rows[0].count);
  logger.info('=== Bootstrap discovery complete ===', { added, total });
  return { added, total };
}

// ─── CLI entry point (so `npm run ingest:discovery` actually runs the agent) ──
import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runDiscoveryAgent()
    .then(() => process.exit(0))
    .catch((err) => { logger.error({ err }, 'Discovery agent failed'); process.exit(1); });
}
