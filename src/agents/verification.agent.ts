import 'dotenv/config';
import PQueue from 'p-queue';
import {
  claimNextTask, completeTask, failTask,
  getEntityById, updateEntityData, updateEntityStatus,
  addToHumanReview, enqueueTask
} from '../db/index.js';
import { extractSectors, extractGeographies, extractSpend } from '../utils/extractor.js';
import { fetchHTML, fetchPDF, searchWeb } from '../tools/fetcher.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import type { VerificationResult, ConflictEntry, CompanyEntity, ConfidenceLevel } from '../types/index.js';

// Jaccard overlap of two string lists (case-insensitive). 1 when both empty.
function listOverlap(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const setB = new Set(b.map(x => x.toLowerCase()));
  const inter = a.filter(x => setB.has(x.toLowerCase())).length;
  const union = new Set([...a, ...b].map(x => x.toLowerCase())).size;
  return union === 0 ? 0 : inter / union;
}

// Deterministic cross-verification: compares the enriched record (Source A)
// against fields independently extracted from Source B. No LLM involved.
function deterministicVerify(
  entity: CompanyEntity,
  sourceB: { url: string; content: string },
  sourceAUrls: string[],
  entityId: string,
): VerificationResult {
  const confirmed_fields: string[] = [];
  const conflict_fields: ConflictEntry[] = [];
  const unverified_fields: string[] = [];
  const updated_confidence: Record<string, ConfidenceLevel> = {};
  const now = new Date().toISOString();
  const aUrl = sourceAUrls[0] ?? '';

  const aSectors = (entity.sector_focus?.value as string[] | null) ?? [];
  const aGeos = (entity.geography_focus?.value as string[] | null) ?? [];
  const aSpendMap = (entity.csr_spend_cr?.value as Record<string, number> | null) ?? null;
  const aSpend = aSpendMap && Object.keys(aSpendMap).length ? Math.max(...Object.values(aSpendMap)) : null;

  const bSectors = extractSectors(sourceB.content);
  const bGeos = extractGeographies(sourceB.content);
  const bSpend = extractSpend(sourceB.content);

  const conflict = (field: string, a: unknown, b: unknown) =>
    conflict_fields.push({ field, source_a_value: a, source_a_url: aUrl, source_b_value: b, source_b_url: sourceB.url, detected_at: now });

  // sector_focus — <50% list overlap is a conflict
  if (!bSectors.length) unverified_fields.push('sector_focus');
  else if (listOverlap(aSectors, bSectors) >= 0.5) { confirmed_fields.push('sector_focus'); updated_confidence['sector_focus'] = 'high'; }
  else conflict('sector_focus', aSectors, bSectors);

  // geography_focus — <50% list overlap is a conflict
  if (!bGeos.length) unverified_fields.push('geography_focus');
  else if (listOverlap(aGeos, bGeos) >= 0.5) { confirmed_fields.push('geography_focus'); updated_confidence['geography_focus'] = 'high'; }
  else conflict('geography_focus', aGeos, bGeos);

  // csr_spend_cr — >5% variance is a conflict
  if (bSpend === null || aSpend === null) unverified_fields.push('csr_spend_cr');
  else if (aSpend > 0 && Math.abs(aSpend - bSpend) / aSpend <= 0.05) { confirmed_fields.push('csr_spend_cr'); updated_confidence['csr_spend_cr'] = 'high'; }
  else conflict('csr_spend_cr', aSpend, bSpend);

  const keyConflicts = conflict_fields.filter(c =>
    ['sector_focus', 'geography_focus', 'csr_spend_cr', 'accepts_proposals'].includes(c.field));

  return {
    entity_id: entityId,
    confirmed_fields,
    conflict_fields,
    unverified_fields,
    updated_confidence,
    human_review_required: keyConflicts.length > 0,
    human_review_reason: keyConflicts.length > 0
      ? `Deterministic verification found ${keyConflicts.length} conflict(s) on key fields`
      : '',
  };
}

const MAX_CONCURRENT = config.concurrencyVerification;


async function findIndependentSource(entityName: string, existingUrls: string[]): Promise<{url: string; content: string} | null> {
  // Search independently — don't rely on the same URLs from enrichment
  const verifyQueries = [
    `"${entityName}" CSR annual report`,
    `"${entityName}" corporate social responsibility`,
    `"${entityName}" foundation grants`,
  ];

  for (const query of verifyQueries) {
    const urls = await searchWeb(query);
    // Find a URL that wasn't already used during enrichment
    const independentUrl = urls.find(u => !existingUrls.includes(u)) ?? urls[0];
    
    if (!independentUrl) continue;

    const isPDF = independentUrl.endsWith('.pdf') || independentUrl.includes('annual');
    const fetchResult = isPDF ? await fetchPDF(independentUrl) : await fetchHTML(independentUrl);

    if (fetchResult.success && fetchResult.content.length > 100) {
      return { url: independentUrl, content: fetchResult.content };
    }
  }

  return null;
}

// ─── Process one verification task ───────────────────────────────────────────

async function processVerificationTask(): Promise<boolean> {
  const task = await claimNextTask('verify');
  if (!task) return false;

  const entityId = task.entity_id!;
  const entityName = task.entity_name!;
  const sourceUrls = (task.payload.source_urls as string[]) ?? [];

  logger.info('Verifying entity', { entityName, entityId });

  try {
    // Get the already-enriched entity record
    const entity = await getEntityById(entityId);
    if (!entity) {
      await failTask(task.id, 'Entity not found');
      return true;
    }

    // Find an independent source (not the same ones used during enrichment)
    const independentSource = await findIndependentSource(entityName, sourceUrls);

    if (!independentSource) {
      // Single-source is NOT a conflict — it is the normal case in search-free
      // mode (see config.ts). Mark verified with a note; do NOT send to human
      // review. Human review is reserved for genuine source-vs-source conflicts.
      logger.info('Single-source entity — verifying without cross-check', { entityName });
      await updateEntityData(entityId, { verification_note: 'Single-source only — no independent verification possible' });
      // 'complete' means drift-seeded on top of verified — re-verifying must not
      // pull an already-complete company back a stage.
      if (entity.status !== 'complete') await updateEntityStatus(entityId, 'verified');
      await enqueueTask({
        type: 'seed_drift',
        entity_id: entityId,
        entity_name: entityName,
        priority: task.priority + 1,
        payload: { category: task.payload.category, source_urls: sourceUrls },
        max_attempts: 2,
      });
      await completeTask(task.id);
      return true;
    }

    // Deterministic cross-verification against the independent Source B.
    const result = deterministicVerify(entity, independentSource, sourceUrls, entityId);

    // Apply confidence upgrades from verification
    const confidenceUpdates: Record<string, unknown> = {};
    for (const [field, newConf] of Object.entries(result.updated_confidence ?? {})) {
      confidenceUpdates[`${field}.confidence`] = newConf;
    }

    // Store conflict log
    const conflictLog: ConflictEntry[] = result.conflict_fields?.map(c => ({
      ...c,
      detected_at: new Date().toISOString(),
    })) ?? [];

    await updateEntityData(entityId, {
      conflict_log: conflictLog,
      verified_at: new Date().toISOString(),
      verified_source_url: independentSource.url,
      confirmed_fields: result.confirmed_fields,
      unverified_fields: result.unverified_fields,
    });

    // Only escalate when two sources ACTIVELY contradict on a key field
    // (>50% disagreement → see listOverlap < 0.5 in deterministicVerify).
    if (result.human_review_required) {
      await addToHumanReview(entityId, result.human_review_reason || `${conflictLog.length} field conflicts detected during verification`, {
        conflicts: conflictLog,
        confirmed: result.confirmed_fields,
        verification_source: independentSource.url,
      });
      // Still mark as verified and queue drift even with conflicts
      await updateEntityStatus(entityId, 'verified');
      await enqueueTask({
        type: 'seed_drift',
        entity_id: entityId,
        entity_name: entityName,
        priority: task.priority + 1,
        payload: { category: task.payload.category, source_urls: [...sourceUrls, independentSource.url] },
        max_attempts: 2,
      });
    } else {
      // Clean verification — upgrade, but never regress an already-complete row.
      if (entity.status !== 'complete') await updateEntityStatus(entityId, 'verified');
      // Queue drift seeding
      await enqueueTask({
        type: 'seed_drift',
        entity_id: entityId,
        entity_name: entityName,
        priority: task.priority + 1,
        payload: { category: task.payload.category, source_urls: [...sourceUrls, independentSource.url] },
        max_attempts: 2,
      });
    }

    await completeTask(task.id);
    logger.info('Verification complete', {
      entityName,
      confirmed: result.confirmed_fields?.length ?? 0,
      conflicts: conflictLog.length,
      humanReview: result.human_review_required,
      verificationSource: independentSource.url,
    });
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Verification task failed', { entityName, error: message });
    await failTask(task.id, message);
    return true;
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function runVerificationAgent(): Promise<void> {
  logger.info('=== Verification agent starting ===', { concurrency: MAX_CONCURRENT });
  const queue = new PQueue({ concurrency: MAX_CONCURRENT });
  let processed = 0;
  let empty = 0;

  while (empty < 3) {
    const promises = Array.from({ length: MAX_CONCURRENT }, () =>
      queue.add(async () => {
        const hadWork = await processVerificationTask();
        if (hadWork) { processed++; empty = 0; }
        else empty++;
      })
    );
    await Promise.all(promises);
    if (empty > 0) await new Promise(r => setTimeout(r, 2000));
  }

  logger.info('=== Verification agent complete ===', { processed });
}

// ─── CLI entry point (so `npm run ingest:verify` actually runs the agent) ─────
import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runVerificationAgent()
    .then(() => process.exit(0))
    .catch((err) => { logger.error({ err }, 'Verification agent failed'); process.exit(1); });
}
