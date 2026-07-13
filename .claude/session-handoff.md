# Session Handoff — CSR Funding Intelligence (2026-07-13)

## 1. Goal
Phases 1-3 of the platform rework: (1) PostgreSQL → SQLite, (2) Electron desktop
shell, (3) Puppeteer JS-render fallback. All DONE, verified, pushed to
https://github.com/Shiv-Gaur/CSR-Intel (main). Gates: build ✅, 146/146 tests ✅.

## 2. Completed (exact paths)
- **PHASE 1**: src/db/sqlite.ts (better-sqlite3, WAL, ./data/csr-intel.db,
  SQLITE_PATH override; pg-shaped query() facade; central JSON (de)serialise);
  src/db/index.ts rewritten; every query converted (json_patch/json_extract/
  json_each; datetime modifiers; aliased COUNT(*)). Data migrated via
  scripts/migrate-postgres-to-sqlite.ts — entities 189 (173 companies + 16
  schemes), innovators 5, task_queue 2076, change_history 74, human_review 260,
  match_profile 1 — ALL COUNTS MATCHED. pg removed. Postgres docker untouched
  as backup. data/ gitignored.
- **PHASE 2**: electron/main.ts (server as `node dist/index.js` CHILD — no
  better-sqlite3 ABI rebuild; child kill stops server+workers+cron; single-
  instance lock; attach mode if port 3000 already served); electron/preload.cjs
  (sandbox needs CJS); electron/icon.ico (DRIIV seal via png-to-ico);
  packaged mode: SQLITE_PATH → app.getPath('userData'). Scripts: electron:dev/
  electron:start/electron:build (tsconfig.electron.json → dist-electron/).
- **PHASE 3**: src/tools/browser-fetcher.ts (shared headless Chromium, queue
  concurrency 2, resource blocking, 8s nav/15s protocol/20s hard cap, 45s idle
  close, exit hooks); fallback wiring in src/tools/free-sources.ts (<200 chars,
  skip bse/nse JSON APIs) + src/tools/official-site.ts. Extractor hardening for
  rendered-page noise (NAME_STOPWORDS additions + mid-word-capital DOM-seam
  check in src/utils/extractor.ts).
- Earlier same day: contact integrity (LinkedIn ban, nw18 boilerplate purge,
  PSU board pages, manual overrides), DRIIV logo header (dark bar, cropped
  1024x300 asset at src/dashboard/assets/logo.png, GET /assets/logo.png).

## 3. Decisions
- Server ALWAYS a child process under Electron (ABI + lifecycle); Chromium dies
  with the child — verified: quit mid-enrichment with 10 live chrome.exe → zero
  orphans, port free.
- Browser fallback is threshold-gated (fires only on <200-char fetches), never
  a replacement; hdfcbank.com forced the 20s hard cap (protocol stalls at 146s).
- 10-company fallback run: 10/10 companies triggered it (~4-5 fetches each,
  mean 3.8s/fetch); ~96s/company vs 57s cheerio-only (~4.6h vs 2.7h for 173).
- Tier-1 pages can still name SUBSIDIARY heads (BoB "Samir Bhupendra Shah") —
  not machine-verifiable; the per-contact "Report incorrect" override is the fix.
- SBI/ONGC sites resist even the browser (404 conventional paths, /web/ URL
  scheme, bot walls) — their contacts stay wikipedia+Unverified, honestly.

## 4. In progress
Nothing half-done. Port 3000 free (Electron quit test was last). DB is SQLite
at ./data/csr-intel.db — docker csr-postgres is a STALE backup as of 2026-07-13.

## 5. Next steps (suggested first prompts)
1. "Package the Electron app with electron-builder (installer, bundled DB
   snapshot, icon)" — natural PHASE 4; main.ts already handles userData DB.
2. "Build financial data extraction (revenue, net profit, CSR budget)" — the
   last old tracker item; estimateSpendFromProfit in src/utils/inference.ts.
3. "Add official websites for remaining ~140 companies to known-urls.ts" —
   widens tier-1 contact coverage (only ~31 have domains).

## 6. Blockers (need human input)
- Search-free mode still on; SBI/HDFC-class bot walls beat even Puppeteer.
- Docker Postgres only needed if re-running the one-time migration (needs
  `npm i pg` again).
- No hot reload: restart `npm run dev` after src edits; kill port-3000 process
  first (Get-NetTCPConnection -LocalPort 3000).
