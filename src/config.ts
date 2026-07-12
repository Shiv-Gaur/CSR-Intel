import { z } from 'zod';
import 'dotenv/config';

// ─── SEARCH-FREE MODE (permanent) ────────────────────────────────────────────
// Web search is DISABLED — public search engines (DuckDuckGo, Bing, Google,
// Brave scraper) are blocked here by captcha / rate-limits, so scraping them
// only wastes time and floods the logs. The system runs on DIRECT sources only:
// Screener, IndiaCSR, Wikipedia, and known/seeded URLs.
//
// `searchWeb()` therefore returns no results unless a paid API key
// (SERPER_API_KEY or BRAVE_SEARCH_API_KEY) is configured. Set SEARCH_FREE_MODE=
// false in the env only after wiring a working search API.
export const SEARCH_FREE_MODE = (process.env.SEARCH_FREE_MODE ?? 'true').toLowerCase() !== 'false';

const configSchema = z.object({
  // Database
  databaseUrl: z.string().url(),

  // LLM removed — kept for backward compat only
  llmBaseUrl: z.string().default(''),
  llmModel: z.string().default(''),
  llmApiKey: z.string().default(''),

  // Search
  serperApiKey: z.string().default(''),
  braveSearchApiKey: z.string().default(''),

  // Concurrency
  concurrencyDiscovery: z.coerce.number().default(2),
  concurrencyEnrichment: z.coerce.number().default(2),
  concurrencyVerification: z.coerce.number().default(2),
  concurrencyDrift: z.coerce.number().default(2),

  // Rate limits
  fetchDelayMs: z.coerce.number().default(2500),
  searchDelayMs: z.coerce.number().default(5000),

  // Scheduling
  cronDiscovery: z.string().default('0 6 * * *'),
  cronEnrichment: z.string().default('0 7 * * *'),
  cronDrift: z.string().default('0 2 * * 0'),
  cronQaReport: z.string().default('0 8 * * 1'),
  cronDailyRefresh: z.string().default('0 10 * * *'),

  // Logging
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Dashboard
  dashboardPort: z.coerce.number().default(3000),

  // Webhook
  reviewWebhookUrl: z.string().url().optional().or(z.literal('')),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  const raw = {
    databaseUrl: process.env.DATABASE_URL,
    llmBaseUrl: process.env.LLM_BASE_URL,
    llmModel: process.env.LLM_MODEL,
    llmApiKey: process.env.LLM_API_KEY,
    serperApiKey: process.env.SERPER_API_KEY,
    braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY,
    concurrencyDiscovery: process.env.CONCURRENCY_DISCOVERY,
    concurrencyEnrichment: process.env.CONCURRENCY_ENRICHMENT,
    concurrencyVerification: process.env.CONCURRENCY_VERIFICATION,
    concurrencyDrift: process.env.CONCURRENCY_DRIFT,
    fetchDelayMs: process.env.FETCH_DELAY_MS,
    searchDelayMs: process.env.SEARCH_DELAY_MS,
    cronDiscovery: process.env.CRON_DISCOVERY,
    cronEnrichment: process.env.CRON_ENRICHMENT,
    cronDrift: process.env.CRON_DRIFT,
    cronQaReport: process.env.CRON_QA_REPORT,
    cronDailyRefresh: process.env.CRON_DAILY_REFRESH,
    logLevel: process.env.LOG_LEVEL,
    dashboardPort: process.env.DASHBOARD_PORT,
    reviewWebhookUrl: process.env.REVIEW_WEBHOOK_URL,
  };

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    console.error('❌ Invalid configuration:');
    for (const issue of result.error.issues) {
      console.error(`   ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();
