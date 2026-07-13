# CSR Funding Intelligence

Agent-based pipeline that discovers Indian CSR funding opportunities, enriches them
from free public sources, verifies the data deterministically, and detects drift over
time — with a matchmaking layer between funders (companies/foundations/PSUs) and
innovators (startups/research institutes). Fully deterministic: no LLM calls, no paid
APIs, no search engines.

## Stack

Node.js + TypeScript (ESM) · SQLite (`better-sqlite3`, single file at `./data/csr-intel.db`) · Zod · axios/node-fetch + p-queue/p-retry ·
cheerio · pdf-parse · node-cron · pino · vitest

## Quick start

```bash
npm install
cp .env.example .env        # optional overrides (SQLITE_PATH, port, cron)
npm run db:migrate          # creates ./data/csr-intel.db
npm run db:seed
npm run dev                 # dashboard on http://localhost:3000 + background workers
```

No database server is required — storage is a single SQLite file (WAL mode).
`scripts/migrate-postgres-to-sqlite.ts` is the retired one-time importer from
the old Postgres setup (needs `npm i pg` to run again).

## Commands

```
npm run dev                  # run with tsx (no build needed)
npm run build                # tsc compile to dist/
npm run start                # run compiled dist/index.js
npm run test                 # vitest (all tests)

npm run db:migrate           # run migrations
npm run db:seed              # seed priority company list
npm run seed:innovators      # seed sample innovators

npm run ingest:discovery     # run discovery agent once
npm run ingest:enrich        # run enrichment agent once
npm run ingest:verify        # run verification agent once
npm run ingest:drift         # run drift detection agent once

npm run scheduler            # start cron scheduler only
npm run discover             # CLI: discovery pass
npm run enrich               # CLI: enrich one entity (--entity-id=<uuid>)
npm run status               # CLI: system status dashboard
```

## Folder structure

```
src/
  agents/       Pipeline agents — discovery, enrichment, verification, drift,
                coordinator. Each is independently runnable; they drain a
                Postgres-backed task queue one item at a time.
  dashboard/    HTTP dashboard: dashboard.ts (server + JSON API) and
                dashboard.html (single-file UI, served from disk).
  db/           Postgres pool, parameterised queries, migrations.
  scheduler/    node-cron job definitions (all cron jobs live here).
  tools/        I/O-heavy integrations: fetchers, free keyless sources,
                official-site contact discovery, exchange feeds, match engine,
                Excel import, seed data.
  types/        Shared TypeScript types.
  utils/        Pure functions: deterministic extractors, inference, TRL,
                scoring/matching, sustainability, plus the pino logger
                (logger-core.ts + the call-style adapter logger.ts) and
                in-memory progress/batch state.

scripts/        Operational scripts (migrate, seed).
  dev-tools/    Read-only diagnostics and one-off maintenance scripts.

docs/           PROJECT_REQUIREMENTS.md (requirement tracker — the single
                source of truth, updated every session) and original design
                documents.
```

## Pipeline

```
discovery → enrichment → verification → drift detection
 (stub)      (enriched)    (verified)      (complete)
```

Statuses only move backwards when fresh data genuinely fails quality gates —
re-enrichment refreshes data fields without regressing verified companies.

## Conventions

See `CLAUDE.md` for the full code rules. Highlights: ESM only, no `any`, Zod for all
external data, parameterised SQL only, pino logger only (never `console.log` in src),
every extracted value must be literal source text with provenance — never guessed.
