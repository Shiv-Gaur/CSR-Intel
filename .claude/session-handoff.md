# Session Handoff — CSR Funding Intelligence (2026-07-13, PHASE 4)

## 1. Goal
PHASE 4: single distributable Windows installer. DONE and verified end-to-end
(install → shortcut launch → seeded data → clean uninstall). Gates: build ✅,
146/146 tests ✅.

## 2. Completed (exact paths)
- **Installer**: release/CSR-Funding-Intelligence-Setup-1.0.0.exe — 244.6 MB
  (856 MB installed; Electron runtime + bundled Chromium dominate). Build with
  `npm run electron:dist`.
- **electron-builder.yml**: NSIS assisted installer (oneClick:false,
  perMachine:false → user picks per-user or all-users/Program Files),
  Desktop + Start Menu shortcuts, asar:false (deliberate — the
  ELECTRON_RUN_AS_NODE child + better-sqlite3 + pino-pretty transport worker
  threads all want plain files), output release/.
- **scripts/stage-electron-assets.ts** (runs inside electron:dist): copies the
  active Puppeteer Chromium (win64-150.0.7871.24, ~415 MB) from
  ~/.cache/puppeteer to build/chromium (SKIPPED when .version marker matches —
  no re-copy, and Puppeteer itself never re-downloads a cached browser);
  snapshots data/csr-intel.db via better-sqlite3 backup() (WAL-safe) to
  build/seed/ — bundled as first-run seed (189 entities = 173 companies +
  16 schemes, 5 innovators).
- **electron/main.ts**: packaged mode now spawns the server as
  `process.execPath` + ELECTRON_RUN_AS_NODE=1 (target machines have no Node;
  dev still uses plain `node`); sets PUPPETEER_EXECUTABLE_PATH to
  resources/chrome/chrome-win64/chrome.exe when bundled.
- **src/config.ts** `puppeteerExecutablePath` (env PUPPETEER_EXECUTABLE_PATH) →
  **src/tools/browser-fetcher.ts** passes it as launch executablePath (empty in
  dev = puppeteer cache as before).
- **package.json**: productName "CSR Funding Intelligence" (also names the
  userData dir), scripts electron:dist + postelectron:dist
  (`npm rebuild better-sqlite3` — electron-builder's npmRebuild switches local
  node_modules to the Electron ABI; the post script restores Node ABI so
  dev/tests keep working. If electron-builder FAILS mid-run, run the rebuild
  manually).
- **.gitignore**: build/, release/.

## 3. Verified live (this machine)
- Silent per-user install (/S): install dir
  %LOCALAPPDATA%\Programs\CSR Funding Intelligence, Desktop + Start Menu
  shortcuts, HKCU Add/Remove entry — all present.
- Launched FROM the Start Menu shortcut: installed exe owned port 3000
  (server child under ELECTRON_RUN_AS_NODE), /api/stats returned 173
  companies / 16 schemes / 5 innovators; seed DB copied on first run to
  %APPDATA%\CSR Funding Intelligence\csr-intel.db (2.1 MB).
- Graceful window close: 0 leftover processes, port 3000 free.
- Silent uninstall via the registered uninstaller (what Add/Remove Programs
  runs): dir, both shortcuts, registry entry all removed; userData DB
  intentionally preserved (reinstall keeps user edits — first-run copy only
  fires when the DB is absent).
- better-sqlite3 Electron-ABI rebuild used a PREBUILT binary (electron 43.1.0,
  buildFromSource=false) — no VS toolchain needed at package time.

## 4. In progress
Nothing half-done. The app is currently UNINSTALLED (that was the test);
run the installer from release/ to put it back. Port 3000 free. NOTE: an
orphaned `tsx src/index.ts` dev server (the known pitfall) was found holding
port 3000 mid-session and killed.

## 5. Next steps (suggested first prompts)
1. "Build financial data extraction (revenue, net profit, CSR budget)" — the
   LAST open tracker item; estimateSpendFromProfit in src/utils/inference.ts.
2. "Add official websites for remaining ~140 companies to known-urls.ts" —
   widens tier-1 contact coverage (only ~31 have domains).
3. Optional installer polish: code signing (currently unsigned → SmartScreen
   warning on other machines), app icon author field ("author is missed in
   package.json" builder warning), auto-update via electron-updater.

## 6. Blockers (need human input)
- Installer is UNSIGNED — Windows SmartScreen will warn on machines that
  download it; needs a code-signing cert to fix.
- Search-free mode still on; SBI/HDFC-class bot walls beat even Puppeteer.
- No hot reload: restart `npm run dev` after src edits; kill port-3000 process
  first (Get-NetTCPConnection -LocalPort 3000).
