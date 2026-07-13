import { getPool, getTaskQueueStats, enqueueTask } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

// ─── Run the full ingestion pipeline in order ─────────────────────────────────

export async function runFullPipeline(): Promise<void> {
  logger.info('=== FULL PIPELINE START ===');

  // Import agents lazily to avoid circular deps
  const { runDiscoveryAgent } = await import('./discovery.agent.js');
  const { runEnrichmentAgent } = await import('./enrichment.agent.js');
  const { runVerificationAgent } = await import('./verification.agent.js');
  const { runDriftAgent } = await import('./drift.agent.js');

  logger.info('[1/4] Discovery');
  await runDiscoveryAgent();

  logger.info('[2/4] Enrichment');
  await runEnrichmentAgent();

  logger.info('[3/4] Verification');
  await runVerificationAgent();

  logger.info('[4/4] Drift seeding');
  await runDriftAgent();

  // Final stats
  await printQASummary();
  logger.info('=== FULL PIPELINE COMPLETE ===');
}

// ─── Daily refresh — check top-50 for updates ────────────────────────────────

export async function runDailyRefresh(): Promise<void> {
  logger.info('=== DAILY REFRESH START ===');

  // Queue refresh tasks for P1 + P2 entities last updated > 7 days ago
  const { rows } = await getPool().query(`
    SELECT id, name, priority
    FROM entities
    WHERE status = 'complete'
      AND priority <= 2
      AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')
    ORDER BY priority ASC, updated_at ASC
    LIMIT 50
  `);

  logger.info(`Queuing ${rows.length} entities for refresh`);

  for (const row of rows) {
    await enqueueTask({
      type: 'enrich',          // re-enrich goes through full pipeline again
      entity_id: row.id,
      entity_name: row.name,
      priority: row.priority,
      payload: { refresh: true },
      max_attempts: 2,
    });
  }

  if (rows.length > 0) {
    const { runEnrichmentAgent } = await import('./enrichment.agent.js');
    const { runVerificationAgent } = await import('./verification.agent.js');
    await runEnrichmentAgent();
    await runVerificationAgent();
  }

  logger.info('=== DAILY REFRESH COMPLETE ===');
}

// ─── Weekly drift recompute ───────────────────────────────────────────────────

export async function runWeeklyDriftRecompute(): Promise<void> {
  logger.info('=== WEEKLY DRIFT RECOMPUTE START ===');

  // Queue drift recompute for all complete entities
  const { rows } = await getPool().query(`
    SELECT id, name, priority
    FROM entities WHERE status = 'complete'
    ORDER BY priority ASC
  `);

  for (const row of rows) {
    await enqueueTask({
      type: 'seed_drift',
      entity_id: row.id,
      entity_name: row.name,
      priority: row.priority,
      payload: { recompute: true },
      max_attempts: 2,
    });
  }

  const { runDriftAgent } = await import('./drift.agent.js');
  await runDriftAgent();

  logger.info('=== WEEKLY DRIFT RECOMPUTE COMPLETE ===');
}

// ─── QA Summary report ───────────────────────────────────────────────────────

export async function printQASummary(): Promise<void> {
  const [entities, taskStats, reviewQueue, lowConfidence, driftReady] = await Promise.all([
    getPool().query(`
      SELECT status, COUNT(*) as count FROM entities GROUP BY status ORDER BY count DESC
    `),
    getTaskQueueStats(),
    getPool().query(`SELECT COUNT(*) AS count FROM human_review_queue WHERE resolved = FALSE`),
    getPool().query(`
      SELECT COUNT(*) AS count FROM entities
      WHERE json_extract(data, '$.missing_fields') IS NOT NULL
        AND json_array_length(data, '$.missing_fields') > 3
    `),
    getPool().query(`SELECT COUNT(*) AS count FROM entities WHERE drift_scores IS NOT NULL`),
  ]);

  const summary = {
    entity_counts: Object.fromEntries(entities.rows.map((r: any) => [r.status, parseInt(r.count)])),
    task_queue: taskStats,
    human_review_pending: parseInt(reviewQueue.rows[0].count),
    low_completeness_entities: parseInt(lowConfidence.rows[0].count),
    entities_with_drift_scores: parseInt(driftReady.rows[0].count),
    generated_at: new Date().toISOString(),
  };

  logger.info('QA SUMMARY', summary);

  // If webhook configured, post to Slack or similar
  if (config.reviewWebhookUrl) {
    try {
      const fetch = (await import('node-fetch')).default;
      await fetch(config.reviewWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `*CSR Intelligence DB — Weekly QA*\n` +
            `✅ Complete: ${summary.entity_counts['complete'] ?? 0}\n` +
            `🔄 In progress: ${(summary.entity_counts['stub'] ?? 0) + (summary.entity_counts['enriched'] ?? 0)}\n` +
            `👁 Human review pending: ${summary.human_review_pending}\n` +
            `📊 Drift scores computed: ${summary.entities_with_drift_scores}\n` +
            `⚠️ Low completeness: ${summary.low_completeness_entities}`,
        }),
      });
    } catch (err) {
      logger.warn('Webhook notification failed', { err });
    }
  }
}
