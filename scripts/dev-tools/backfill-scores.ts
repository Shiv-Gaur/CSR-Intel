// One-time backfill (safe to re-run):
//  1. Innovators with sustainability_score = 0 → recompute from description/USP/
//     research summary + stored circularity indicators (the insert-time default
//     used to be a hard 0; see src/utils/sustainability.ts).
//  2. Companies → detect data.domain_focus from stored text (raw_notes, key
//     programs, name) so the platform-domain match boost works without a full
//     re-enrichment pass. Skips entities that already have domain_focus.
// Then reranks persisted profile-match scores so the boost is reflected.
// CLI: npx tsx scripts/backfill-scores.ts

import 'dotenv/config';
import { getPool, closePool, rerankAllProfileScores } from '../../src/db/index.js';
import { computeInnovatorSustainability } from '../../src/utils/sustainability.js';
import { detectDomainFocus } from '../../src/utils/extractor.js';
import { logger } from '../../src/utils/logger.js';

async function backfillInnovators(): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT id, name, description, usp, circularity_indicators, data, sustainability_score
     FROM innovators WHERE sustainability_score = 0`);
  let updated = 0;
  for (const r of rows) {
    const text = [r.description ?? '', r.usp ?? '', (r.data?.research_summary as string) ?? ''].join(' ');
    const { score, indicators } = computeInnovatorSustainability(text, r.circularity_indicators ?? null);
    if (score <= 0) continue;
    await getPool().query(
      `UPDATE innovators SET sustainability_score = $1, circularity_indicators = $2::jsonb, last_updated_at = NOW() WHERE id = $3`,
      [score, JSON.stringify(indicators), r.id]);
    logger.info('Backfilled sustainability score', { name: r.name, score });
    updated++;
  }
  return updated;
}

async function backfillCompanyDomains(): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT id, name, data FROM entities WHERE category != 'govt_scheme'`);
  let updated = 0;
  for (const r of rows) {
    const data = r.data || {};
    if (Array.isArray(data.domain_focus)) continue; // already detected — enrichment owns it now
    const text = [
      r.name ?? '',
      data.raw_notes ?? '',
      Array.isArray(data.key_programs?.value) ? data.key_programs.value.join(' ') : '',
      Array.isArray(data.sector_focus?.value) ? data.sector_focus.value.join(' ') : '',
    ].join(' ');
    const domains = detectDomainFocus(text);
    await getPool().query(
      `UPDATE entities SET data = data || $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify({ domain_focus: domains }), r.id]);
    if (domains.length) updated++;
  }
  return updated;
}

async function main(): Promise<void> {
  const innovators = await backfillInnovators();
  const companies = await backfillCompanyDomains();
  const reranked = await rerankAllProfileScores();
  logger.info('Backfill complete', { innovatorsRescored: innovators, companiesWithDomains: companies, reranked });
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(err => { logger.error({ err }, 'Backfill failed'); process.exit(1); });
