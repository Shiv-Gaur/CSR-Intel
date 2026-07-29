# Session Handoff — CSR Funding Intelligence (2026-07-28)

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
- `npm run build` clean (exit 0).
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

## 5. Next steps
1. **Not yet exercised in the live Electron window** — the native Save/Open
   dialogs were not driven end-to-end via CDP this session (the previous session
   used `npx electron . --remote-debugging-port=9222` + puppeteer.connect;
   scratchpad/drive-electron.cjs). Worth a manual click-through of
   Settings → Export snapshot / Import snapshot in the installed app.
2. Not released. Current version is 1.0.4; this feature is unreleased.
3. `.claude/skills/ui-overhaul/SKILL.md` is STILL STALE (describes the
   pre-redesign white/pills design, wrong paths `src/dashboard.html`) — carried
   over unaddressed from 2026-07-23.
4. Snapshots include innovators and schemes, but the round-trip only stressed
   companies. Innovator/scheme paths are unit-tested but not round-tripped.

## 6. Blockers / carried over
- Financial data extraction (revenue, net profit, CSR budget) for manually added
  companies — still OPEN in PROJECT_REQUIREMENTS.md.
- IndiaCSR 403 rate-limit verification of BHEL/ITC/Infosys re-enrich spend —
  untouched since 2026-07-22.
- GH_TOKEN pasted in an earlier chat should be revoked (carried warning, still
  not confirmed done).
- Auto-update round-trip on the installed app remains the user's manual test.
