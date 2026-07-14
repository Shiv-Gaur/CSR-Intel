# Session Handoff — CSR Funding Intelligence (2026-07-14)

## 1. Goal
(1) Repo cleanup + push; (2) auto-update via electron-updater + GitHub
Releases (v1.0.1). Both DONE, pushed: da362c7 (cleanup), 290304a (updater).
Gates: build ✅, 136/136 tests ✅. Installer:
release/CSR-Funding-Intelligence-Setup-1.0.1.exe (244.8 MB).

## 2. Completed (exact paths)
- Cleanup (da362c7): DELETED src/tools/confidence-scorer.ts +
  drift-compute.ts (+ their 2 test files; agents have own inline logic),
  Dockerfile, docker-compose.yml, deploy.sh, scripts/dev-tools/ (4 files),
  scripts/migrate-postgres-to-sqlite.ts. src/config.ts: databaseUrl + LLM
  fields removed. .env.example + README.md rewritten. Tests 146→136.
  WARNING: coordinator.agent, schemes-seed, innovator-research,
  innovator-import LOOK orphaned but load via dynamic import() — keep.
- Updater (290304a): electron/main.ts (autoUpdater: launch+4h checks packaged
  only, Restart now/Later dialog, briefError() trims header dumps, ipcMain
  app:version + updates:check); electron/preload.cjs (csrDesktop bridge);
  src/dashboard/dashboard.html (gear-panel Check for updates, desktop-only);
  electron-builder.yml (publish: github/Shiv-Gaur/CSR-Intel);
  package.json (v1.0.1, "release" script --publish always + postrelease).
- ABI guard: scripts/stage-electron-assets.ts deletes stale .forge-meta;
  NEW scripts/verify-packaged-native.ts load-tests packaged better-sqlite3
  under ELECTRON_RUN_AS_NODE at end of electron:dist/release.

## 3. Decisions
- CRITICAL BUG FOUND by installing for real: @electron/rebuild's .forge-meta
  marker (node_modules/better-sqlite3/build/Release) survives the
  post-packaging `npm rebuild better-sqlite3`, so every 2nd+ packaging run
  SKIPPED the Electron-ABI rebuild and shipped Node-ABI (127 vs 148) →
  packaged server crashed at boot (window up, blank page). First 1.0.1 build
  shipped broken; fixed + gated. Every packaging log must show "ABI verified".
- "release" script = full chain (build → electron:build → stage → publish
  always → verify), NOT bare `electron-builder --publish=always` (would
  package stale dist/).
- Unsigned auto-update on Windows: updates do NOT retrigger SmartScreen (no
  Mark-of-the-Web on electron-updater's own downloads; unsigned apps skip the
  signature-match check). Only the first browser download warns. This is
  documented behaviour — full round-trip NOT yet tested (needs 2 releases).
- User's REAL install is E:\DRIIV\CSR Funding Intelligence (they installed
  1.0.0 manually there; NSIS remembers the dir). Never uninstall it in tests.
  Currently on fixed 1.0.1, verified healthy (173 companies, ~14s startup).
- Verified live via CDP (--remote-debugging-port=9222 + puppeteer): gear
  button visible only in desktop shell, click → status text, re-enables,
  graceful 404 handling; launch-time auto-check also fired.

## 4. In progress
Nothing half-done. Working tree clean, main in sync with origin. App closed,
port 3000 free. Memory csr-db-environment.md updated (SQLite, E:\DRIIV,
private repo, ABI trap).

## 5. Next steps (first prompts for next session)
1. After the user makes the repo public + sets GH_TOKEN: "Run npm run release
   to publish 1.0.1, then bump to 1.0.2 and do a real update round-trip test
   on the E:\DRIIV install" — closes the only untested link.
2. "Build financial data extraction (revenue, net profit, CSR budget)" — last
   open tracker item; estimateSpendFromProfit in src/utils/inference.ts.
3. "Add official websites for remaining ~140 companies to
   src/tools/known-urls.ts" — widens tier-1 contact coverage (~31 have domains).

## 6. Blockers (need human input)
- Repo github.com/Shiv-Gaur/CSR-Intel is PRIVATE (anon API 404s) —
  auto-update feed is dead for users until the USER flips visibility
  (Settings → General → Danger Zone). gh CLI unauthenticated here.
- GH_TOKEN needed for `npm run release` (fine-grained PAT, Contents
  read+write on CSR-Intel). Steps documented in README.md.
- Installer unsigned → SmartScreen on first browser download; needs a
  code-signing cert to remove.
- Search-free mode still on; SBI/HDFC-class bot walls beat even Puppeteer.
- No hot reload: restart `npm run dev` after src edits; kill the port-3000
  PID first (Get-NetTCPConnection -LocalPort 3000) — orphaned tsx children
  recur, and the Electron shell silently attaches to any port-3000 server.
