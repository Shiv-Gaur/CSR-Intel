# Session Handoff — CSR Funding Intelligence (2026-07-28 → 2026-07-30)

> Rewrite this file at the END of every session. The previous version sat stale
> from 2026-07-23 for five days, which is how a half-finished feature
> (src/sync/snapshot.ts) got lost — it did not compile, nothing imported it, and
> the test suite stayed green around it.

## 1. Goal
Finish and ship the manual export/import snapshot sync feature that a previous
session left half-written and unwired.

## 2. Completed — COMMITTED as e7d1709 "Manual export/import snapshot sync"
Working tree is CLEAN. Everything below is in that one commit.

- **src/sync/snapshot.ts** (was untracked and broken; now compiles + is tested)
  * The bug: it called an undefined `getPool()` 8 times → 7 TS2304 errors.
    Adding the import does NOT fix it — the `getPool()` facade in
    `src/db/index.ts` is `async` (returns `Promise<QueryResult>`), so `.rows`
    does not exist on it, and more importantly better-sqlite3's `transaction()`
    is SYNCHRONOUS: awaiting inside it would commit before the writes ran.
  * Fix: use the synchronous `query` from `src/db/sqlite.ts` (imported as
    `dbQuery`) everywhere. ONE access style, comment at the import explains why.
    Do not "tidy" this back to getPool().
  * Postgres-looking `NOW()` / `$1` are FINE — `sqlite.ts` translates both.
- **src/dashboard/dashboard.ts** — three routes, inserted as 9c/9d/9e just before
  the `/api/companies/bulk` route:
  * `GET /api/sync/export` — JSON body + Content-Disposition attachment.
  * `POST /api/sync/import` — raw body via existing `readRawBody`; `SnapshotError`
    → 400 with the user-facing message, anything else rethrows to the 500 handler.
  * `POST /api/sync/import/resolve` — body validated by new `syncResolveSchema`.
- **electron/main.ts** — `sync:save` / `sync:open` ipcMain handlers using
  `dialog.showSaveDialog` / `showOpenDialog`; both return null on cancel. Main
  owns only the picker + disk I/O; the renderer owns the HTTP calls.
- **electron/preload.cjs** — exposes `saveSnapshot(filename, contents)` and
  `openSnapshot()`.
- **src/dashboard/dashboard.html**
  * Settings — Match Profile modal: new "Data sync" group with
    `syncExportBtn` / `syncImportBtn` + hidden `syncImportFile` input.
  * New `syncModal` (summary line, origin hint, per-conflict cards).
  * JS: `exportSnapshot` / `pickSnapshot` / `importSnapshotText` /
    `showSyncResult` / `applySyncChoices`. Desktop path uses the native dialogs;
    browser path falls back to `window.location.href` download + file input.
  * Per-conflict radios `Keep local` (default) / `Use imported` / `Skip` — ONLY
    "use imported" is posted to /resolve.
  * Reuses the existing `esc()` at line ~606 — do not add a second one.
- **docs/PROJECT_REQUIREMENTS.md** — new completed entry + Last updated 2026-07-28.

## 3. Verification done
- `npm run build` clean (exit 0). It is now `tsc && npm run electron:build`, so
  the ONE command covers both the server program and `electron/` — see §7.
- `npm run test` → **214/214 passing, 16 files** (was 191/15 before).
- `src/sync/__tests__/snapshot.test.ts` — 23 tests: buildSnapshot shape +
  company/scheme split + counts, parseSnapshot rejects (non-JSON, non-object,
  wrong format marker, newer schema_version, incompatible app major, missing
  list, nameless record), diffing (new / identical / conflicting, data.* per-key
  diffs, case+whitespace-insensitive name match, innovator fields, mixed
  snapshot), applyResolutions (selective apply, update-not-insert, innovator
  columns, malformed entries ignored, empty list).
- **Mutation-checked**: flipping `if (!local)` → `if (local)` in `importSnapshot`
  fails 7 of the 23 with stack frames inside snapshot.ts. This is the proof the
  file is actually exercised now — the earlier "tests pass" was vacuous.
- **Two-database round-trip** (script: scratchpad/roundtrip.ts, run as two
  processes because `config.sqlitePath` is fixed per process): DB A seeded with
  3 shared companies → export snapshot1 → add 3 companies → export snapshot2;
  DB B seeded with the same 3 shared rows + 1 local-only + 1 locally-edited →
  import snapshot2. Result: 3 added, 2 up-to-date, 1 conflict (the locally-edited
  row), local-only untouched, no duplicates, row count +3 exactly, re-import
  idempotent, and resolving the conflict as "use imported" applied cleanly
  without creating a duplicate. All 19 assertions passed.
- Dashboard inline script syntax-checked with `vm.Script`
  (scratchpad/check-inline.cjs) — parses clean.

## 4. Decisions
- Access style inside snapshot.ts is the sync `dbQuery`, NOT `getPool()` — see §2.
- Renderer does the HTTP, main process does only the file dialog + disk I/O.
  Keeps main.ts thin and avoids duplicating the server URL there.
- Conflict default is **Keep local**, matching the module's "never silently
  overwrite" guardrail. Keep-local and Skip are both client-side no-ops; they
  differ only in intent, and neither is sent to the server.
- Snapshot matching key is `name` (UNIQUE on both tables), compared
  case-insensitively and trimmed.

## 5. Live click-test in the running Electron app — DONE 2026-07-29
Driven over CDP against the real 173-company DB. **puppeteer.connect does NOT
work here** (`Runtime.callFunctionOn timed out` against Electron 43) — use the
raw CDP client instead: `scratchpad/cdp.cjs` (Node 22 global `WebSocket`,
`Runtime.evaluate` + real `Input.dispatchMouseEvent` clicks). Native OS dialogs
are driven by `scratchpad/dialog.ps1` (EnumWindows for class `#32770`, then
SendKeys).

- Settings → **Export snapshot**: native Save dialog CONFIRMED
  (`class=#32770 title='Export snapshot' pid=<electron>`), button showed
  "Exporting…" while it was up. Produced a real 1.5 MB file: format
  `csr-intel-snapshot`, schema_version 1, app_version 1.0.4, counts
  173/16/5 matching the array lengths exactly.
- Settings → **Import snapshot** of that same file: native Open dialog
  CONFIRMED, summary modal rendered **"0 new · 194 already up to date ·
  0 conflicts"** (173+16+5=194) with the exported-at/version origin line and the
  "Nothing to resolve" state, Apply button correctly hidden.
- **Conflict rendering** exercised with real data by importing a modified copy
  (3 companies' status/priority + 1 innovator's TRL; no names changed so nothing
  could be inserted): **"0 new · 190 already up to date · 4 conflicts"**, 4
  conflict cards, 12 radios (3 per card), Field/Local/Imported diff tables
  showing `status complete→enriched` and `priority 4→1`, Apply button shown.
- **Apply choices** clicked with all radios at the "Keep local" default → nothing
  posted, toast "No changes applied", modal closed. The three conflicted
  companies verified still `status=complete priority=4` and total still 173 —
  the never-silently-overwrite guarantee held live.
- Deliberately NOT done: clicking "Use imported" against the real DB (that would
  mutate the user's 173-company production data). That write path is covered by
  unit tests + the two-DB round-trip in §3.
- Cleanup: electron killed by PID **tree** (`taskkill /T /F`), no orphans, port
  3000 free; the two test snapshots written to ~/Documents were deleted.

### Gotchas found while driving it
- SendKeys drops characters on very long paths — the Open dialog silently stayed
  up with an invalid filename and the import never fired. Use a SHORT path and
  send `^a` first to clear the box. `dialog.ps1 waitfill` polls for the dialog
  and fills it in one process (a separate find-then-fill lets it slip away).
- `Page.captureScreenshot` times out while a native modal is open — screenshot
  before raising the dialog or after dismissing it.
- A modal left open swallows the next click: close `#syncModal` (and reopen
  Settings) before clicking another button.

## 6. RELEASED as v1.0.5 — 2026-07-29
**https://github.com/Shiv-Gaur/CSR-Intel/releases/tag/v1.0.5** (id 361724396,
draft=false, published_at 2026-07-29T12:04:46Z, tag at commit c20397e).

Shipped as 1.0.5 rather than 1.0.4: a different 1.0.4 build (2026-07-27,
pre-snapshot-sync) was already installed on this machine, and electron-updater
treats equal versions as "no update", which would have made the release
undetectable on this install. The unreleased v1.0.4 tag was deleted (local +
remote) and the stale 1.0.4 artifacts moved to `release/_stale-2026-07-27/`.

- Assets (all three on the ONE release): `CSR-Funding-Intelligence-Setup-1.0.5.exe`
  (204,150,193 B), `.exe.blockmap` (210,784 B), `latest.yml` (377 B).
- latest.yml verified by DOWNLOADING the published installer and hashing it —
  version 1.0.5, declared size and sha512 both equal the measured values, and
  `files[0].sha512` agrees with the top-level `sha512`. Not a presence check.
- `postrelease` (`npm rebuild better-sqlite3`) ran, so the native module is back
  on the Node ABI; `npm run test` 214/214 confirms it.
- **The split-release trap reproduced.** electron-builder logged "creating GitHub
  release" TWICE and produced two non-draft releases for v1.0.5 with the assets
  split (one got exe+latest.yml, the other only the blockmap). Repaired exactly
  as [[release-publish-traps]] prescribes: DELETE both by id (204), confirm the
  tag survived (200), POST one release, upload all three assets (201 each).
  This is now reproducible across v1.0.3 and v1.0.5 — assume it will happen
  again and plan to repair, don't hope the publish step works.

## 7. Next steps
1. Auto-update round-trip is now testable for the first time: this machine has
   1.0.4 installed and 1.0.5 is live, so launching the installed app should
   detect and silently install the update. Still the user's manual test.
   Per [[silent-update-and-install]] the 1.0.4→1.0.5 transition may still show a
   brief progress window; fully silent applies from 1.0.5 onward.
2. `.claude/skills/ui-overhaul/SKILL.md` is STILL STALE (describes the
   pre-redesign white/pills design, wrong paths `src/dashboard.html`) — carried
   over unaddressed from 2026-07-23.
3. Snapshots include innovators and schemes, but the two-DB round-trip only
   stressed companies. Innovator/scheme paths are unit-tested and were seen in
   the live conflict list, but not round-tripped across two DBs.

## 8. Build now covers electron/ (2026-07-29)
`npm run build` was plain `tsc`, whose program excluded `electron/` entirely, so
a broken main process could sit undetected until someone ran `electron:build`.
Now:
- `"build": "tsc && npm run electron:build"` — the standard check covers both.
- `"build:server": "tsc"` added for the server-only compile.
- `electron:dev` / `electron:dist` / `release` no longer call `electron:build`
  separately (build already does it) — no double compile.
Verified by injecting a deliberate type error into `electron/main.ts`:
`npm run build` failed with `electron/main.ts(251,9): error TS2322` where it
would previously have passed. Probe reverted.

## 9. Blockers / carried over
- **Revoke the GH_TOKEN pasted into chat on 2026-07-29**
  (`ghp_TeQV...`, scope `repo`, push+admin). It is in that conversation's
  transcript permanently; the local scratchpad copy was deleted, which does not
  help. https://github.com/settings/tokens — the token from an earlier chat is
  still outstanding too.
- Financial data extraction (revenue, net profit, CSR budget) for manually added
  companies — still OPEN in PROJECT_REQUIREMENTS.md.
- IndiaCSR 403 rate-limit verification of BHEL/ITC/Infosys re-enrich spend —
  untouched since 2026-07-22.
- GH_TOKEN pasted in an earlier chat should be revoked (carried warning, still
  not confirmed done).
- Auto-update round-trip on the installed app remains the user's manual test.
