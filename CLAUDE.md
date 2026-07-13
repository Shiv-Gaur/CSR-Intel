# CSR Funding Intelligence

Agent-based pipeline for CSR funding discovery, enrichment, verification, and drift detection.

## Stack

- **Runtime:** Node.js + TypeScript (ESM, `"type": "module"`)
- **LLM:** Ollama (local) — never call external LLM APIs without explicit instruction
- **DB:** SQLite via `better-sqlite3` (single file, default `./data/csr-intel.db`) — parameterised queries only, never string interpolation; JSON columns (de)serialised centrally in `src/db/sqlite.ts`
- **Validation:** Zod — all external input must be validated before use
- **HTTP:** axios + node-fetch (streaming) + p-queue (rate limiting) + p-retry (retries)
- **Scraping:** cheerio
- **PDF:** pdf-parse
- **Scheduling:** node-cron (`src/scheduler/cron.ts`)
- **Logging:** pino + pino-pretty — never `console.log` in source files
- **Testing:** vitest

## Commands

```
npm run dev                  # run with tsx (no build needed)
npm run build                # tsc compile to dist/
npm run start                # run compiled dist/index.js

npm run test                 # vitest run (all tests)

npm run db:migrate           # run migrations
npm run db:seed              # seed priority list

npm run ingest:discovery     # run discovery agent
npm run ingest:enrich        # run enrichment agent
npm run ingest:verify        # run verification agent
npm run ingest:drift         # run drift detection agent

npm run scheduler            # start cron scheduler
npm run discover             # index.ts --mode=discover
npm run enrich               # index.ts --mode=enrich
npm run status               # index.ts --mode=status
```

## Agents

Four agents, each independently runnable:
- `discovery.agent.ts` — finds new CSR funding opportunities
- `enrichment.agent.ts` — enriches discovered opportunities
- `verification.agent.ts` — verifies data accuracy
- `drift.agent.ts` — detects changes in existing records

Before modifying any agent, confirm which stage of the pipeline it affects.

## Code rules

- ESM only — use `import/export`, never `require()`
- No `any` types, no `@ts-ignore` without explanation
- Zod schemas for all external data (scraped HTML, PDF content, API responses)
- pino logger only — import from the project's logger module, don't create new instances
- All HTTP through axios instance or node-fetch — no new HTTP libraries
- p-queue for rate-limited scraping, p-retry for transient failures
- New cron jobs go in `src/scheduler/cron.ts` only
- Environment variables only through the project's config module, never `process.env.X` in business logic

## Testing rules

- vitest only — ESM-compatible
- Mock Ollama and all external HTTP in unit tests
- Run `npm run test` before marking any task done
