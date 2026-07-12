import 'dotenv/config';
import PQueue from 'p-queue';
import {
  claimNextTask, completeTask, failTask,
  updateEntityStatus, updateDriftScores,
  insertChangeHistory, getChangeHistory, getPool
} from '../db/index.js';
import { extractSectors, extractGeographies, extractSpend } from '../utils/extractor.js';
import { fetchPDF, fetchWayback, searchWeb } from '../tools/fetcher.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import type { ChangeHistoryEntry, DriftScores } from '../types/index.js';

const YEARS_TO_SEED = [2020, 2021, 2022, 2023, 2024];
const MAX_CONCURRENT = config.concurrencyDrift;

// ─── Find annual report URLs for a given year ─────────────────────────────────

async function findAnnualReportUrl(entityName: string, year: number): Promise<string | null> {
  const fy = `${year}-${String(year + 1).slice(2)}`; // "2023-24"
  const queries = [
    `"${entityName}" annual report ${fy} filetype:pdf`,
    `"${entityName}" CSR report ${year} ${year + 1} PDF`,
    `"${entityName}" annual report ${year + 1}`,
  ];

  for (const query of queries) {
    const urls = await searchWeb(query);
    const pdfUrl = urls.find(u => u.endsWith('.pdf') || (u.includes('pdf') && u.includes(String(year))));
    if (pdfUrl) return pdfUrl;
  }
  return null;
}

// ─── Fetch content for a given year (PDF first, Wayback fallback) ─────────────

async function fetchYearContent(entityName: string, year: number, existingUrls: string[]): Promise<{
  content: string;
  url: string;
  year: number;
} | null> {
  // Try finding annual report PDF for this year
  const pdfUrl = await findAnnualReportUrl(entityName, year);
  if (pdfUrl) {
    const result = await fetchPDF(pdfUrl);
    if (result.success && result.content.trim()) {
      return { content: result.content, url: pdfUrl, year };
    }
  }

  // Fallback: Wayback Machine snapshot of foundation/company page
  if (existingUrls[0]) {
    const wayback = await fetchWayback(existingUrls[0], year + 1); // check start of next year
    if (wayback.success && wayback.content.trim()) {
      return { content: wayback.content, url: wayback.url, year };
    }
  }

  return null;
}

// ─── Compute drift scores from change history ─────────────────────────────────

function computeDriftScores(history: ChangeHistoryEntry[], yearData: Record<string, unknown>[]): DriftScores {
  const sectorChanges = history.filter(h => h.change_type === 'sector_shift').length;
  const geoChanges = history.filter(h => h.change_type === 'geo_shift').length;
  const reqChanges = history.filter(h => h.change_type === 'requirement_change').length;
  const opennessChanges = history.filter(h => h.change_type === 'openness_change').length;

  const yearsWithData = yearData.length;
  const normalize = (count: number, maxExpected: number) =>
    Math.min(100, Math.round((count / Math.max(yearsWithData, 1)) * (100 / maxExpected) * 100));

  const sectorDrift = normalize(sectorChanges, 2);
  const geoDrift = normalize(geoChanges, 2);
  const requirementDrift = normalize(reqChanges, 1.5);
  const opennessDrift = normalize(opennessChanges, 1);

  // Weighted composite: 0.35 sector + 0.25 geo + 0.25 req + 0.15 openness
  const composite = Math.round(
    0.35 * sectorDrift +
    0.25 * geoDrift +
    0.25 * requirementDrift +
    0.15 * opennessDrift
  );

  return {
    sector_drift: sectorDrift,
    geo_drift: geoDrift,
    requirement_drift: requirementDrift,
    openness_drift: opennessDrift,
    composite_drift: composite,
    computed_at: new Date().toISOString(),
    window_years: yearsWithData,
    // Compatibility fields:
    sector: sectorDrift,
    geography: geoDrift,
    requirement: requirementDrift,
    openness: opennessDrift,
    composite: composite
  };
}

// ─── Process one drift seeding task ──────────────────────────────────────────

async function processDriftTask(): Promise<boolean> {
  const task = await claimNextTask('seed_drift');
  if (!task) return false;

  const entityId = task.entity_id!;
  const entityName = task.entity_name!;
  const existingUrls = (task.payload.source_urls as string[]) ?? [];

  logger.info('Seeding drift history', { entityName, entityId });

  try {
    // Fetch content for each year
    const yearContents: Array<{ content: string; url: string; year: number }> = [];

    for (const year of YEARS_TO_SEED) {
      logger.debug('Fetching year', { entityName, year });
      const result = await fetchYearContent(entityName, year, existingUrls);
      if (result) yearContents.push(result);
      else logger.debug('Year content unavailable', { entityName, year });
    }

    if (yearContents.length < 2) {
      logger.warn('Insufficient historical data for drift seeding', { entityName, years: yearContents.length });
      await updateEntityStatus(entityId, 'complete');
      await completeTask(task.id);
      return true;
    }

    // Deterministic multi-year drift analysis — extract per-year signals and
    // diff consecutive years. No LLM involved.
    const perYear = yearContents
      .map(yc => ({
        year: yc.year,
        fy: `FY${yc.year}-${String(yc.year + 1).slice(2)}`,
        url: yc.url,
        sectors: extractSectors(yc.content),
        geographies: extractGeographies(yc.content),
        spend: extractSpend(yc.content),
      }))
      .sort((a, b) => a.year - b.year);

    const change_history: Record<string, unknown>[] = [];
    for (let i = 1; i < perYear.length; i++) {
      const prev = perYear[i - 1];
      const cur = perYear[i];

      if (prev.sectors.join('|') !== cur.sectors.join('|')) {
        change_history.push({ field_name: 'sector_focus', old_value: prev.sectors, new_value: cur.sectors, financial_year: cur.fy, change_type: 'sector_shift', source_url: cur.url });
      }
      if (prev.geographies.join('|') !== cur.geographies.join('|')) {
        change_history.push({ field_name: 'geography_focus', old_value: prev.geographies, new_value: cur.geographies, financial_year: cur.fy, change_type: 'geo_shift', source_url: cur.url });
      }
      if (prev.spend !== null && cur.spend !== null && prev.spend > 0 && Math.abs(cur.spend - prev.spend) / prev.spend > 0.05) {
        change_history.push({ field_name: 'csr_spend_cr', old_value: prev.spend, new_value: cur.spend, financial_year: cur.fy, change_type: 'spend_change', source_url: cur.url });
      }
    }

    const year_data: Record<string, unknown>[] = perYear.map(p => ({
      financial_year: p.fy,
      sector_allocations: Object.fromEntries(p.sectors.map(s => [s, p.spend ?? 0])),
      geography_focus: p.geographies,
      accepts_proposals: null,
      key_requirements: [],
      notes: '',
    }));

    const first = perYear[0];
    const last = perYear[perYear.length - 1];
    const drift_signals: Record<string, string> = {
      sector: `${first.sectors.length} sectors in ${first.fy} → ${last.sectors.length} in ${last.fy}`,
      geography: `${first.geographies.length} geographies in ${first.fy} → ${last.geographies.length} in ${last.fy}`,
      requirements: 'Not analyzed in deterministic mode',
      openness: 'Not analyzed in deterministic mode',
    };

    const seededYears = new Set(perYear.map(p => p.year));
    const gaps = YEARS_TO_SEED
      .filter(y => !seededYears.has(y))
      .map(y => `FY${y}-${String(y + 1).slice(2)} source not found`);

    const driftResult = { change_history, year_data, drift_signals, gaps };

    // Write change history entries to DB
    const historyEntries = (driftResult.change_history ?? []) as unknown as ChangeHistoryEntry[];
    for (const entry of historyEntries) {
      await insertChangeHistory({
        entity_id: entityId,
        field_name: entry.field_name,
        old_value: entry.old_value,
        new_value: entry.new_value,
        financial_year: entry.financial_year,
        change_type: entry.change_type,
        source_url: entry.source_url ?? '',
        detected_at: new Date().toISOString(),
      });
    }

    // Compute drift scores
    const allHistory = await getChangeHistory(entityId);
    const scores = computeDriftScores(allHistory, driftResult.year_data ?? []);
    await updateDriftScores(entityId, scores);

    // Store drift signals summary
    await getPool().query(
      `UPDATE entities SET data = data || $1::jsonb, status = 'complete', updated_at = NOW() WHERE id = $2`,
      [JSON.stringify({
        drift_signals: driftResult.drift_signals,
        drift_gaps: driftResult.gaps,
        years_covered: yearContents.map(y => y.year),
      }), entityId]
    );

    await completeTask(task.id);
    logger.info('Drift seeding complete', {
      entityName,
      historyEntries: historyEntries.length,
      composite_drift: scores.composite_drift,
      years: yearContents.length,
      gaps: driftResult.gaps?.length ?? 0,
    });
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Drift seeding failed', { entityName, error: message });
    await failTask(task.id, message);
    return true;
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function runDriftAgent(): Promise<void> {
  // Drift seeding is slower — use lower concurrency (5 max)
  const concurrency = Math.min(5, MAX_CONCURRENT);
  logger.info('=== Drift seeding agent starting ===', { concurrency });

  const queue = new PQueue({ concurrency });
  let processed = 0;
  let empty = 0;

  while (empty < 3) {
    const promises = Array.from({ length: concurrency }, () =>
      queue.add(async () => {
        const hadWork = await processDriftTask();
        if (hadWork) { processed++; empty = 0; }
        else empty++;
      })
    );
    await Promise.all(promises);
    if (empty > 0) await new Promise(r => setTimeout(r, 3000));
  }

  logger.info('=== Drift seeding agent complete ===', { processed });
}

// ─── CLI entry point (so `npm run ingest:drift` actually runs the agent) ──────
import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runDriftAgent()
    .then(() => process.exit(0))
    .catch((err) => { logger.error({ err }, 'Drift agent failed'); process.exit(1); });
}
