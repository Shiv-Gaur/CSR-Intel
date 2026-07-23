# Session Handoff — CSR Funding Intelligence (2026-07-23)

## 1. Goal
Full UI redesign: replace the dark top-bar layout with the glass/gradient left-sidebar
shell from docs/design/redesign-mockup.html across Companies / Welfare Schemes /
Innovators — with ZERO data or feature loss.

## 2. Completed (exact paths) — NOT yet committed
- src/dashboard/dashboard.html — the whole shell:
  * `<style>` replaced with the mockup design system (exact gradient stops, glass
    rgba/blur(18-22px) saturate(160%), 236px sidebar, logo-chip gradient, 3px
    stat-card accent bars, gradient score bars). Legacy CSS var aliases kept
    (--primary/--border/--text-muted/… map to new tokens) so untouched inline JS
    styles still resolve. ONE deliberate deviation: --ink-muted #8990a8→#6d7490
    (contrast on glass; mockup value failed AA at 11-12px).
  * Sidebar: DRIIV logo (/assets/logo.png) on dark chip, icon nav
    (Overview/Companies/Welfare Schemes/Innovators/Search/Settings). Nav items
    reuse old tab ids (tabCompanies/tabSchemes/tabInnovators) + new tabOverview;
    navSearch→openGlobalSearch; Settings carries id=profileBtn → Match Profile
    modal (retitled "Settings — Match Profile", contains Check-for-updates).
  * Pinned update strip (updT1/updT2/updDot/updRestart): "Up to date · v{v} ·
    checked on launch" → "Update found (downloading)" → "Update available —
    Restart"; browser mode shows "Local dashboard · browser mode".
  * Topbar global-search bar keeps id=globalSearchBtn (old listener works);
    quick-filter search above table KEPT — the two searches are distinct.
  * Action row under title: addBtn/addInnBtn/importInnBtn/tmplInnBtn/
    reenrichAllHdrBtn/csvBtn (same ids, same setTab visibility logic).
  * Insights block REMOVED; new Overview page = 8 stat cards (ids ov-*),
    renderOverview() fed by statsData + insightsData; Ready card deep-links to
    Companies?status=complete. loadInsights kept (20s interval).
  * Notifications bell REMOVED (markup + all JS: snapshot/computeNotifications/
    renderNotifications/bellBtn/notifPanel). No server API existed.
  * Filters: pillRow deleted → ddSingle() radio dropdowns + ddGroup() for the
    Advanced panel (Score/Match/Source/TRL in one .ddmenu.wide). ddRow
    multi-selects unchanged. .ddmenu clicks stopPropagation so multiselects stay
    open. Chips + Clear all unchanged.
  * Profile Match column now matchBarHtml (purple gradient bar ≥40, grey below);
    Score bars scoreGrad(): ≥60 green grad, ≥40 indigo grad, <40 grey.
- electron/main.ts — sendUpdateState() on 'updates:state' channel
  (none/available/downloaded/error + version) alongside the old text channel;
  ipcMain.handle('updates:restart') → stopServer()+quitAndInstall.
  Launch check CONFIRMED: setupAutoUpdater runs from app.whenReady on every
  launch (10s delay), then 4-hourly (packaged only).
- electron/preload.cjs — exposes onUpdateState + restartToUpdate.
- docs/PROJECT_REQUIREMENTS.md — redesign entry added; Notifications/Insights
  entries annotated as removed 2026-07-23.

## 3. Verification done
- npm run build + electron:build clean; npm run test 188/188 green (twice).
- node --check on the extracted inline script: OK.
- LIVE Electron (npx electron . --remote-debugging-port=9222, driven via
  puppeteer.connect CDP — script: scratchpad/drive-electron.cjs): screenshots
  01-10 in session scratchpad. Confirmed: sidebar+logo+update strip
  ("Up to date · v1.0.2 · checked on launch"), computed backdrop-filter
  blur(22px) saturate(1.6) on <aside>, gradient body, all three tabs, Status
  dropdown open, Advanced dropdown groups, Overview cards, Ctrl+K overlay w/
  FTS results, Settings modal, bulk bar ("2 selected", all 5 actions), header
  sort (Score ↑), detail tabs incl. Feasibility. Browser mode (headless
  puppeteer): blur OK, strip fallback OK, bell/insights absent.

## 4. Decisions
- Overview page invented as the home for surviving insight numbers (avg match,
  ready-to-contact, auto-discovered) as stat cards — spec allowed this, forbade
  a dedicated Insights block.
- csvBtn on Innovators tab still exports schemes CSV — PRE-EXISTING quirk,
  deliberately not changed (no-feature-change rule). Flag to user if wanted.
- Innovators keep Ownership filter (spec's list omitted it; no-loss rule wins).
- st-ready/st-review stat cards on Schemes/Innovators tabs still show company
  counts — pre-existing behavior, untouched.

## 5. Next steps
1. User visual review → commit (suggest: "Full UI redesign: glass/gradient
   sidebar shell (mockup-exact), Overview page, dropdown filters").
2. Release as v1.0.3 when ready (npm run release) to test the update strip's
   downloaded→Restart flow against a real GitHub release.
3. .claude/skills/ui-overhaul/SKILL.md is STALE (describes white/pills design,
   wrong paths src/dashboard.html) — refresh it.
4. Optional: purge dead CSS if any straggler classes remain (checked: .pill/
   .notif/.iconbtn/.insights/.tabs all removed).

## 6. Blockers / carried over from 2026-07-22
- IndiaCSR 403 rate-limit verification of BHEL/ITC/Infosys re-enrich spend
  (backup at scratchpad/enrich_backup.json of THAT session) — not touched today.
- GH_TOKEN pasted in an earlier chat should be revoked (carried warning).
- Auto-update round-trip (1.0.1→1.0.2 installed app) still the user's manual test.
