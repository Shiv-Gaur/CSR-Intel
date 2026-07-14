# CSR Funding Intelligence

Agent-based pipeline that discovers Indian CSR funding opportunities, enriches them
from free public sources, verifies the data deterministically, and detects drift over
time — with a matchmaking layer between funders (companies/foundations/PSUs) and
innovators (startups/research institutes). Fully deterministic: no LLM calls, no paid
APIs, no search engines. Ships as a web dashboard for development and a packaged
Windows desktop app (Electron) for distribution.

## Stack

Node.js + TypeScript (ESM) · SQLite (`better-sqlite3`, single file at `./data/csr-intel.db`) · Zod · axios/node-fetch + p-queue/p-retry ·
cheerio · pdf-parse · puppeteer (JS-render fallback) · node-cron · pino · vitest ·
Electron + electron-builder (Windows installer)

## Quick start (development)

```bash
npm install
cp .env.example .env        # optional — every value has a working default
npm run db:migrate          # creates ./data/csr-intel.db
npm run db:seed
npm run dev                 # dashboard on http://localhost:3000 + background workers
```

No database server is required — storage is a single SQLite file (WAL mode).
There is no hot reload: restart `npm run dev` after source edits (kill the
port-3000 process first if it lingers: `Get-NetTCPConnection -LocalPort 3000`).

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

npm run electron:dev         # build + run the desktop shell against local code
npm run electron:dist        # build the Windows installer (see below)
```

## Folder structure

```
electron/       Desktop shell: main.ts (spawns the server as a child process),
                preload.cjs, app icons.
scripts/        Operational scripts: migrate.ts, seed-priority-list.ts,
                stage-electron-assets.ts (packaging inputs).
src/
  agents/       Pipeline agents — discovery, enrichment, verification, drift,
                coordinator. Each independently runnable; they drain a
                SQLite-backed task queue one item at a time.
  dashboard/    HTTP dashboard: dashboard.ts (server + JSON API) and
                dashboard.html (single-file UI, served from disk).
  db/           sqlite.ts (better-sqlite3 connection, pg-shaped query facade,
                central JSON (de)serialisation) and index.ts (migrations +
                data-access helpers).
  scheduler/    node-cron job definitions (all cron jobs live here).
  tools/        I/O-heavy integrations: fetchers (cheerio primary,
                browser-fetcher.ts Puppeteer fallback), free keyless sources,
                official-site contact discovery, exchange feeds, match engine,
                Excel import, seed data.
  types/        Shared TypeScript types.
  utils/        Pure functions: deterministic extractors, inference, TRL,
                scoring/matching, sustainability, plus the pino logger
                (logger-core.ts + the call-style adapter logger.ts) and
                in-memory progress/batch state. Tests colocated in __tests__/.
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

## Building the Windows installer

```bash
npm run electron:dist
```

This chains: `tsc` (server → `dist/`) → `tsc -p tsconfig.electron.json`
(shell → `dist-electron/`) → `scripts/stage-electron-assets.ts` →
`electron-builder --win`.

The staging script prepares two large inputs under `build/` (gitignored):

- **Chromium** — the active Puppeteer browser (~415 MB) copied from
  `~/.cache/puppeteer` into the package, so the JS-render fallback works on
  machines with no Puppeteer cache. Skipped when the staged version already
  matches. If you've never run Puppeteer locally:
  `npx puppeteer browsers install chrome`.
- **Seed DB** — a consistent snapshot of `data/csr-intel.db`, bundled so a
  fresh install starts with the current dataset (copied to the user's AppData
  on first launch; an absent seed still works — migrations create an empty
  schema at boot).

Output: `release/CSR-Funding-Intelligence-Setup-<version>.exe` (~245 MB —
Electron runtime + bundled Chromium dominate). NSIS assisted installer:
per-user (no admin) or all-users (Program Files) choice, Desktop + Start Menu
shortcuts, uninstall via Windows "Add or Remove Programs". User data lives in
`%APPDATA%\CSR Funding Intelligence\` and survives uninstall/reinstall.

Packaging notes:

- The packaged server child runs under `ELECTRON_RUN_AS_NODE` (target machines
  don't have Node), so electron-builder rebuilds `better-sqlite3` against the
  Electron ABI during packaging (prebuilt binary — no compiler toolchain
  needed). The `postelectron:dist` hook restores the Node ABI afterwards so
  `npm run dev`/tests keep working; if a packaging run dies midway, run
  `npm rebuild better-sqlite3` manually.
- The installer is currently **unsigned** — Windows SmartScreen will warn on
  machines that download it. A code-signing certificate fixes this.

## Conventions

See `CLAUDE.md` for the full code rules. Highlights: ESM only, no `any`, Zod for all
external data, parameterised SQL only, pino logger only (never `console.log` in src),
every extracted value must be literal source text with provenance — never guessed.
