import cron from 'node-cron';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

// ─── Guard: prevent overlapping runs ─────────────────────────────────────────

const running: Record<string, boolean> = {};

async function guardedRun(name: string, fn: () => Promise<void>): Promise<void> {
  if (running[name]) {
    logger.warn(`Skipping ${name} — previous run still active`);
    return;
  }
  running[name] = true;
  const start = Date.now();
  try {
    logger.info(`Cron starting: ${name}`);
    await fn();
    logger.info(`Cron done: ${name}`, { duration_s: Math.round((Date.now() - start) / 1000) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Cron failed: ${name}`, { error: message });
  } finally {
    running[name] = false;
  }
}

// ─── Schedule all jobs ────────────────────────────────────────────────────────

export function startScheduler(): void {
  logger.info('Scheduler starting — registering cron jobs');

  // ── Daily: discover new entities + bootstrap 100+ company seed (6am IST)
  cron.schedule(config.cronDiscovery, () => {
    guardedRun('discovery', async () => {
      const { runDiscoveryAgent, runBootstrapDiscovery } = await import('../agents/discovery.agent.js');
      await runDiscoveryAgent();
      await runBootstrapDiscovery();
    });
  }, { timezone: 'Asia/Kolkata' });

  // ── Daily: (re)seed curated welfare schemes (4am IST)
  cron.schedule('0 4 * * *', () => {
    guardedRun('schemes-refresh', async () => {
      const { seedWelfareSchemes } = await import('../tools/schemes-seed.js');
      await seedWelfareSchemes();
    });
  }, { timezone: 'Asia/Kolkata' });

  // ── Daily: auto-discover new companies by target sector (5am IST, every 24h)
  cron.schedule('0 5 * * *', () => {
    guardedRun('auto-discovery', async () => {
      const { runAutoDiscovery } = await import('../agents/discovery.agent.js');
      await runAutoDiscovery();
    });
  }, { timezone: 'Asia/Kolkata' });

  // ── Daily: enrich + verify pending stubs (7am IST)
  cron.schedule(config.cronEnrichment, () => {
    guardedRun('enrichment+verification', async () => {
      const { runEnrichmentAgent } = await import('../agents/enrichment.agent.js');
      const { runVerificationAgent } = await import('../agents/verification.agent.js');
      await runEnrichmentAgent();
      await runVerificationAgent();
    });
  }, { timezone: 'Asia/Kolkata' });

  // ── Sunday 2am: drift recompute
  cron.schedule(config.cronDrift, () => {
    guardedRun('drift-recompute', async () => {
      const { runWeeklyDriftRecompute } = await import('../agents/coordinator.agent.js');
      await runWeeklyDriftRecompute();
    });
  }, { timezone: 'Asia/Kolkata' });

  // ── Monday 8am: weekly QA report
  cron.schedule(config.cronQaReport, () => {
    guardedRun('qa-report', async () => {
      const { printQASummary } = await import('../agents/coordinator.agent.js');
      await printQASummary();
    });
  }, { timezone: 'Asia/Kolkata' });

  // ── Daily: refresh stale P1/P2 entities (10am IST)
  cron.schedule(config.cronDailyRefresh, () => {
    guardedRun('daily-refresh', async () => {
      const { runDailyRefresh } = await import('../agents/coordinator.agent.js');
      await runDailyRefresh();
    });
  }, { timezone: 'Asia/Kolkata' });

  logger.info('All cron jobs registered', {
    jobs: [
      `discovery+bootstrap@${config.cronDiscovery}`,
      `schemes-refresh@0 4 * * *`,
      `auto-discovery@0 5 * * *`,
      `enrichment@${config.cronEnrichment}`,
      `refresh@${config.cronDailyRefresh}`,
      `drift@${config.cronDrift}`,
      `qa@${config.cronQaReport}`
    ],
  });

  // Keep process alive — scheduler should stay running
  process.on('SIGTERM', () => {
    logger.info('Scheduler received SIGTERM — shutting down gracefully');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    logger.info('Scheduler received SIGINT — shutting down');
    process.exit(0);
  });
}

export default startScheduler;
