import 'dotenv/config';
import { getPool, getTaskQueueStats, enqueueTask } from './db/index.js';
import { startScheduler } from './scheduler/cron.js';
import { startDashboardServer } from './dashboard/dashboard.js';
import { logger } from './utils/logger.js';

/**
 * Parses argument values from command line arguments (e.g., --name=value)
 */
function getArgValue(prefix: string): string | null {
  const arg = process.argv.slice(2).find(a => a.startsWith(prefix));
  return arg ? arg.split('=')[1] : null;
}

/**
 * Background Postgres task queue worker loop
 */
async function startPostgresQueueWorkers() {
  logger.info('Starting background queue workers (enrichment loop + verify/drift loop)...');

  const { runEnrichmentAgent } = await import('./agents/enrichment.agent.js');
  const { runVerificationAgent } = await import('./agents/verification.agent.js');
  const { runDriftAgent } = await import('./agents/drift.agent.js');

  const pollInterval = 5000; // poll every 5s

  // Enrichment runs in its OWN loop, independent of verify/drift. Previously all
  // three agents shared one loop and each drained to exhaustion in sequence, so a
  // user-initiated re-enrich could sit 'pending' for MINUTES behind a long
  // verification/drift backlog (the seed ships ~160 pending verify tasks) — the
  // "modal stuck on Queued, never updates" bug. Giving enrichment its own loop
  // means a fresh enrich task is claimed within ~pollInterval regardless of how
  // much verify/drift work is outstanding. The two loops can overlap; better-
  // sqlite3 serialises all writes and the agents consume different task types.
  function spawnLoop(fn: () => Promise<void>, name: string): void {
    let running = false;
    async function loop(): Promise<void> {
      if (!running) {
        running = true;
        try { await fn(); }
        catch (err) { logger.error(`Error in ${name} worker`, { error: err instanceof Error ? err.message : String(err) }); }
        finally { running = false; }
      }
      setTimeout(loop, pollInterval);
    }
    void loop();
  }

  spawnLoop(runEnrichmentAgent, 'enrichment');
  spawnLoop(async () => { await runVerificationAgent(); await runDriftAgent(); }, 'verify+drift');
}

/**
 * Main execution function
 */
async function main() {
  const mode = getArgValue('--mode');

  if (mode === 'discover') {
    logger.info('CLI: Running discovery agent pass...');
    try {
      const { runDiscoveryAgent } = await import('./agents/discovery.agent.js');
      await runDiscoveryAgent();
      logger.info('Manual discovery agent pass complete.');
      process.exit(0);
    } catch (err: any) {
      logger.error('Manual discovery agent pass failed', { error: err.message });
      process.exit(1);
    }
  }

  if (mode === 'enrich') {
    const entityId = getArgValue('--entity-id');
    if (!entityId) {
      console.error('❌ Error: The --entity-id=<uuid> parameter is required for manual enrichment.');
      process.exit(1);
    }

    logger.info('CLI: Queuing manual enrichment for entity ID', { entityId });
    try {
      const { rows } = await getPool().query('SELECT name, category FROM entities WHERE id = $1', [entityId]);
      if (rows.length === 0) {
        logger.error('Entity not found', { entityId });
        process.exit(1);
      }
      
      // Enqueue directly in queue
      await enqueueTask({
        type: 'enrich',
        entity_id: entityId,
        entity_name: rows[0].name,
        priority: 1,
        payload: { category: rows[0].category },
        max_attempts: 1,
      });

      // Process ONLY this entity, then exit. Deliberately not runEnrichmentAgent():
      // that drains the entire pending queue, so a targeted `--entity-id` run used
      // to rewrite every backlogged company too (22 entities rewritten when 2 were
      // expected, 2026-07-19). Scoped claim keeps the blast radius at one row.
      const { processEnrichmentTask } = await import('./agents/enrichment.agent.js');
      const didWork = await processEnrichmentTask(entityId);
      if (!didWork) {
        logger.warn('No pending enrich task claimed for this entity — nothing to do', { entityId });
        process.exit(1);
      }
      logger.info('Manual enrichment complete (single entity).', { entityId });
      process.exit(0);
    } catch (err: any) {
      logger.error('Manual enrichment failed', { error: err.message });
      process.exit(1);
    }
  }

  if (mode === 'status') {
    logger.info('CLI: Fetching status dashboard...');
    try {
      const entitiesRes = await getPool().query(`
        SELECT status, COUNT(*) as count FROM entities GROUP BY status
      `);
      const sideRes = await getPool().query(`
        SELECT CASE WHEN category = 'govt_scheme' THEN 'schemes' ELSE 'companies' END AS side,
               COUNT(*) AS count
        FROM entities GROUP BY 1
      `);
      const innovatorsRes = await getPool().query(`
        SELECT status, COUNT(*) as count FROM innovators GROUP BY status
      `);
      const reviewRes = await getPool().query(`
        SELECT COUNT(*) as count FROM human_review_queue WHERE resolved = FALSE
      `);
      const queueStats = await getTaskQueueStats();

      console.log('\n========================================================================');
      console.log('                 CSR INTELLIGENCE SYSTEM STATUS (POSTGRES QUEUE)');
      console.log('========================================================================');

      console.log('\n🏢 FUNDERS (SIDE A):');
      const sides: Record<string, number> = {};
      for (const row of sideRes.rows) sides[row.side] = Number(row.count);
      console.log(`   - COMPANIES    : ${sides.companies ?? 0}`);
      console.log(`   - GOVT SCHEMES : ${sides.schemes ?? 0}`);

      console.log('\n💡 INNOVATORS (SIDE B):');
      let innovatorTotal = 0;
      for (const row of innovatorsRes.rows) {
        console.log(`   - ${row.status.toUpperCase().padEnd(12)} : ${row.count}`);
        innovatorTotal += Number(row.count);
      }
      console.log(`   - TOTAL        : ${innovatorTotal}`);

      console.log('\n📁 ENTITY DATABASE COUNTS:');
      let total = 0;
      for (const row of entitiesRes.rows) {
        console.log(`   - ${row.status.toUpperCase().padEnd(12)} : ${row.count}`);
        total += Number(row.count);
      }
      console.log(`   - TOTAL        : ${total}`);

      console.log('\n⚙️  ACTIVE TASK QUEUE DEPTHS:');
      for (const [qKey, count] of Object.entries(queueStats)) {
        console.log(`   - ${qKey.padEnd(20)} : ${count}`);
      }

      console.log('\n🧑‍💻 REVIEW ESCALATION QUEUE:');
      console.log(`   - Pending Human Reviews: ${reviewRes.rows[0]?.count || 0}`);
      console.log('========================================================================\n');
      process.exit(0);
    } catch (err: any) {
      logger.error('Failed to query status', { error: err.message });
      process.exit(1);
    }
  }

  // Default: Start Workers, Scheduler, and Dashboard Server
  logger.info('Starting CSR Funding Intelligence System (Postgres Queue & Ollama Mode)...');

  try {
    // 1. Run migrations to ensure tables are ready
    const { runMigrations } = await import('./db/index.js');
    await runMigrations();

    // 2. Start web dashboard server first (so user sees UI immediately)
    startDashboardServer(Number(process.env.DASHBOARD_PORT || 3000));

    // 3. Start scheduler
    startScheduler();

    // 4. Start queue workers (polls for tasks)
    await startPostgresQueueWorkers();

    logger.info('System is fully operational, background workers and server active.');
  } catch (err: any) {
    logger.error('Failed to boot system', { error: err.message || String(err), stack: err.stack });
    process.exit(1);
  }
}

main();
export default main;
