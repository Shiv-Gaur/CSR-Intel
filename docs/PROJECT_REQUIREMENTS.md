# PROJECT REQUIREMENTS — Single Source of Truth

> Check this file at the start of every session. Update it whenever a requirement is
> completed or a new one is added. Do not drop requirements — if something can't be done
> this session, it stays open here.
>
> Last updated: 2026-07-30

## Requirements

- [x] Remove LLM/Ollama dependency entirely
- [x] Light mode UI for non-technical users
- [x] CSV export
- [x] Manual company add/delete
- [x] Match profile (technologies/sectors/geography/keywords)
- [x] Auto-discovery of new companies (100+)
- [x] Welfare schemes tab
- [x] TRL status
- [x] Filters/search
- [x] Bulk actions
- [x] Notifications — REMOVED from UI 2026-07-23 (sidebar redesign; bell retired per
      instruction, no server-side API existed; client renderer deleted, reintroduce if needed)
- [x] Insights card — REMOVED 2026-07-23 (sidebar redesign; average match score,
      ready-to-contact and auto-discovered counts live on as Overview stat cards)
- [x] Innovators/startups data model + tab
- [x] Match engine (innovator↔funder)
- [x] Excel import for innovators
- [x] CEO/MD/senior official email extraction — DONE 2026-07-07. `extractExecutiveContacts()`
      in `src/utils/extractor.ts` (title patterns, Wikipedia "Key people", Screener/name-email
      matching, generic csr@/foundation@/investor.relations@ mailboxes). Stored as
      `data.key_contacts` on entities + `key_contacts` jsonb column on innovators. "Key
      Contacts" section in both detail panels (name, title, mailto, confidence badge, source).
      CSV export has CEO/MD/CSR Head name+email columns. Emails only appear when a source
      actually publishes one (execs rarely do; generic mailboxes are the common catch).
- [ ] Financial data extraction (revenue, net profit, CSR budget) for manually added
      companies — OPEN. Partial: estimated CSR spend (2% of net profit) exists in
      `inference.ts`; dedicated revenue/net-profit/CSR-budget fields still to build.
- [x] MoU history extraction — DONE 2026-07-07. `extractMoUHistory()` in extractor.ts;
      persisted as `data.mou_history` on companies during enrichment; shown in company
      CSR Data tab (innovators already had `mou_history` + Partnerships tab).
- [x] Domain-specific fields (solid waste, plastic, wastewater, air pollution, e-waste,
      green hydrogen, circular economy, AI medtech, water body) for BOTH companies AND
      innovators — DONE 2026-07-07. `detectDomainFocus()` auto-detects from extracted text;
      `data.domain_focus` on entities; tags in company detail panel; profile-match boost
      (+4/domain, cap 12) in `computeProfileMatch`.
- [x] Sortable table columns — DONE 2026-07-07. Click header: asc → desc → reset, ↑/↓
      indicator, both Companies and Innovators tables; sort state persists in URL
      (`?sort=score&dir=desc`).
- [x] More data sources — DONE 2026-07-07. Innovators: Crunchbase, YourStory, Inc42,
      Startup India, LinkedIn public page, NASSCOM, Google Scholar (research institutes).
      Companies: Moneycontrol, LinkedIn, NASSCOM. All in `free-sources.ts`, keyless,
      filtered by the existing MIN_SOURCE_CHARS gate.
- [x] Fix innovator sustainability score showing 0 — DONE 2026-07-07. Root cause: score
      was only computed during deep research; inserts defaulted to 0. Now computed at
      insert time (`computeInnovatorSustainability` in `src/utils/sustainability.ts`);
      existing rows backfilled (`scripts/backfill-scores.ts`). Chakr Innovation: 34/100.
- [x] Soften "Low data" visual treatment — DONE 2026-07-07. 80+ "Strong match" (green),
      60+ "Good match" (blue), 40+ "Fair match" (grey), <40 "Limited data" (grey).
      No red/orange anywhere on low scores; numbers unchanged.
- [x] Ownership transfer info for companies too — DONE 2026-07-07.
      `detectOwnershipTransfer()` → `data.ownership_transfer_open` (true/null, never
      asserts false); shown in company CSR Data tab.
- [x] 5-year impact/innovation analysis for companies — DONE 2026-07-07. Company History
      tab now shows "CSR Spend Trend (5-yr)" (all FY figures in `csr_spend_cr`), MoU
      history, and drift/change signals. Multi-year figures accumulate as drift
      detection runs.
- [x] Data integrity: no fabricated emails — DONE 2026-07-08. `guessOfficialMailboxes()`
      (cosec@/investors@/csr@domain construction) DELETED; every email must be a literal
      regex match in scraped text; JUNK_EMAIL extended (indiacsrnetwork.com); legacy
      pattern-guess contacts + 4 aggregator-staff contact_emails purged from DB.
      UI shows "No public email found" — never a guess.
- [x] Contact provenance (as_of/source dates) — DONE 2026-07-08. Every key contact
      carries `extracted_at` + `as_of` (page's own "last edited" date; fetcher preserves
      Wikipedia #footer-info-lastmod). UI: "As of <date> per <source>" (+ "may be
      outdated" past 1 yr), "page date unknown" when absent.
- [x] Aggregator noise gates for exec names — DONE 2026-07-08. On aggregator pages
      (linkedin/indiacsr/nasscom/…) names require company proximity AND clean
      attribution ("from M&S included Stuart Machin…" rejected; "Name, Title, OtherOrg"
      rejected). TCS verified clean across 3 live runs.
- [x] Enrichment timestamp + freshness — DONE 2026-07-08. "Last Enriched" (exact
      datetime) in Overview/CSR/History tabs + innovator overview; amber "Data may be
      outdated" badge past 30 days; per-field "Extracted <date> from <link>" +
      "Unverified since <date>"; labelled `data.sources` (label/url/success/fetched_at)
      persisted per run; `source_urls` column now kept in sync by enrichment (fixes
      hasDocument scoring for legacy rows via flattenCompany fallback too).
- [x] Live enrichment progress — DONE 2026-07-08. In-memory progress store
      (`src/utils/enrichment-progress.ts`), GET /api/companies/:id/enrichment-status,
      UI modal polls every 2s showing per-source ✓/✗ + stage; Re-enrich button and
      Add Company both open it.
- [x] Exchange/registry sources — DONE 2026-07-08 (best effort). BSE announcements
      (2-step scrip-code API), NSE announcements (cookie-warmup API, ticker-keyed),
      Zauba directors (CIN-keyed URL) added to company sources; all fail soft. Live
      probe: BSE resolves scrip but returns empty; NSE/Zauba bot-blocked from this
      machine; MCA is captcha-gated (not scriptable). Wired so they start contributing
      wherever reachable.
- [x] Bulk re-enrich all 173 companies so the integrity fixes (contacts, as_of,
      sources, domain_focus, MoU) apply beyond TCS — DONE 2026-07-12. Ran via the
      "Re-enrich All" batch: 173/173 done, 0 failed, 2h 44m total (avg 57s/company).
      All 173 now have same-day enriched_at + labelled sources + domain_focus;
      118 have key_contacts, 34 have mou_history (fields only populate where
      sources actually publish the data).
- [x] "Re-enrich All" global control with time estimation — DONE 2026-07-12.
      Data Freshness banner (companies + innovators tabs, only when stale>30d
      count > 0); POST /api/{companies,innovators}/reenrich-all[?staleOnly=true]
      returns batch_id immediately (companies ride the sequential task queue,
      innovators a p-queue concurrency-1); GET …/reenrich-all/:batch_id/status
      returns total/done/queued/failed/current company+source/elapsed/running-avg
      ETA; UI polls 2s — progress bar, live counts, human-readable elapsed/ETA
      ("Estimating…" until 5 done), live table refresh per completion, banner
      clears when finished. GET /api/reenrich-all/active lets any fresh page
      load reattach to an in-flight batch (not just the browser that started it,
      which localStorage alone covered). Unit tests: reenrich-batch.test.ts.
- [x] Status must not regress during re-enrichment — DONE 2026-07-12. Enrichment
      only downgrades verified/complete when the fresh data fails the quality
      gate (needsHumanReview); verification never pulls complete back to
      verified except on genuine source conflicts. Verified live: 13
      re-enrichments of complete companies, zero regressions.
- [x] Official-website contact extraction + contact source priority — DONE
      2026-07-12. `fetchCompanyOfficialContacts()` (src/tools/official-site.ts):
      sitemap.xml → homepage links → path guesses (max 4 candidate pages), feeds
      ONLY extractExecutiveContacts (never sectors/geo/spend — TCS non-contact
      fields verified byte-identical across a re-enrich). Contact trust tiers:
      own site > BSE/NSE/Zauba filings > aggregators; aggregator names that
      contradict a better source are dropped, unconfirmed ones carry
      "Unverified — not confirmed on company's own site" (shown in UI).
      204 unconfirmed wiki/linkedin contacts purged across 101 companies
      (scripts/purge-unconfirmed-wiki-contacts.ts). Name extraction hardened:
      mid-string honorifics, UI chrome ("View Profile"), headline verbs, org
      vocabulary all rejected; leading honorifics stripped.
- [x] UI: permanent header "Re-enrich All" button (works even when nothing is
      stale), SVG delete icon (no more dark emoji box), sticky detail panel
      (position:sticky, follows scroll, click-again deselects) — DONE 2026-07-12.
- [x] LinkedIn removed as a contact source — DONE 2026-07-13. extractExecutiveContacts
      returns nothing for linkedin-sourced text (it fed wrong CEOs, e.g. BHEL "Kiran
      Joseph"); stored linkedin contacts purged. LinkedIn text still feeds
      sector/geo extraction. Fallback chain: own site → BSE/NSE/Zauba filings →
      Wikipedia (labelled Unverified) → "Leadership info not found".
- [x] PSU board-of-directors crawling — DONE 2026-07-13. official-site.ts BOARD_PATHS
      always tried for psu/bank categories; CMD title pattern + board-grid name
      boundary + trailing-designation trim. BHEL now shows "K. Sadashiv Murthy —
      Chairman & Managing Director" from bhel.com/board-of-directors. Seeds added:
      GAIL India, Union Bank of India (CINs deliberately omitted — unverified).
- [x] Boilerplate email leak fixed — DONE 2026-07-13. grievanceofficer@nw18.com
      (Moneycontrol's site-wide fraud disclaimer — Network18 property, NOT IndiaCSR)
      had become contact_email for 168/173 companies. Three defenses: JUNK_EMAIL +=
      publisher domains (nw18/news18/firstpost/cnbctv18/zaubacorp); every extracted
      email must relate to the company (domain matches official site, name token, or
      acronym — emailRelatesToCompany); fetchHTML strips footer/disclaimer/legal/
      copyright elements. 169 bad contact_emails purged (incl. one NGO gmail on
      Mphasis); 12 companies re-enriched clean under the new code.
- [x] Manual contact corrections — DONE 2026-07-13. Per-contact "✎ Fix" / "Report
      incorrect" in the company detail panel → POST /api/companies/:id/contacts/
      override → stored in data.key_contact_overrides and re-applied after every
      enrichment run (applyContactOverrides) — automation can never overwrite a
      human fix; manual entries show source "manual", high confidence.
- [x] PHASE 1: PostgreSQL → SQLite migration — DONE 2026-07-13. better-sqlite3
      (sync, WAL) single file at ./data/csr-intel.db (SQLITE_PATH overridable).
      src/db/sqlite.ts: pg-shaped query() facade ($N→named params, NOW()→ISO
      strftime, TRUE/FALSE→1/0), central JSON (de)serialisation for old
      JSONB/TEXT[] columns, transaction() helper. All 6 tables converted (TEXT
      uuid PKs generated in JS, TEXT ISO timestamps, INTEGER booleans); every
      query across dashboard/agents/tools/scripts rewritten (json_patch,
      json_extract, json_each for ANY(), datetime modifiers for INTERVAL,
      LIKE for ILIKE, aliased COUNT(*)). One-time importer
      scripts/migrate-postgres-to-sqlite.ts RUN: all row counts matched —
      entities 189 (173 companies + 16 schemes), innovators 5, task_queue 2076,
      change_history 74, human_review_queue 260, match_profile 1. Postgres left
      untouched as backup; pg dependency removed. Verified live: dashboard,
      npm run status (identical counts), and a full TCS enrichment
      write-cycle on SQLite. data/ gitignored.
- [x] PHASE 2: Electron desktop shell — DONE 2026-07-13. electron/main.ts spawns
      the existing server (dashboard+workers+cron) as a `node dist/index.js`
      CHILD (avoids better-sqlite3 Electron-ABI rebuild; kill child = clean stop
      of server AND cron; single-instance lock prevents duplicate cron on
      relaunch). Attach mode when a dev server already owns port 3000.
      1400x900 window (min 1000x640), DRIIV-seal icon (electron/icon.ico via
      png-to-ico), minimal CJS preload (sandbox requires CJS). Packaged mode
      stores DB at app.getPath('userData') with first-run copy from resources.
      Scripts: electron:dev / electron:start / electron:build. Verified live:
      native window, 173 companies, add+delete round-trip, graceful quit left
      0 electron / 0 node processes and port 3000 free.
- [x] PHASE 3: Puppeteer JS-render fallback — DONE 2026-07-13. puppeteer 25.3,
      src/tools/browser-fetcher.ts: ONE shared headless Chromium (lazy launch,
      45s idle self-close, exit hooks), p-queue concurrency 2, images/fonts/css
      blocked, 8s nav + 15s protocol + 20s hard cap per fetch (the hard cap was
      forced by hdfcbank.com's bot-wall holding pages in navigation limbo —
      146s/fetch before the fix). Fallback-only wiring: gatherSourceText +
      official-site retry a URL in Chromium when plain fetch < 200 chars
      (JSON-API sources skipped); method logged per fetch. 10-company run:
      10/10 triggered ≥1 fallback (44 fetches, 37 beat cheerio, mean 3.8s);
      ~96s/company vs ~57s cheerio-only. Wins: Cipla investor.relations@ from
      own site (previously 0 usable official pages), BHEL companysecretary@
      via now-readable Zauba. Noise from rendered pages killed: org suffixes,
      nav words, DOM-seam glue (mid-word capital check, Mc/Mac excepted).
      Electron verified: quit mid-enrichment with 10 live Chromium processes →
      0 electron / 0 node / 0 chromium left, port free.
- [x] PHASE 4: Windows installer (electron-builder / NSIS) — DONE 2026-07-13.
      release/CSR-Funding-Intelligence-Setup-1.0.0.exe (244.6 MB; 856 MB
      installed — Electron + bundled Chromium dominate). Build:
      `npm run electron:dist` (tsc → tsc electron → stage-electron-assets →
      electron-builder). Packaged server child runs under ELECTRON_RUN_AS_NODE
      (target machines have no Node); better-sqlite3 auto-rebuilt for the
      Electron 43 ABI by electron-builder (prebuilt binary, no compile), then
      `postelectron:dist` restores the Node ABI for dev/tests. Puppeteer's
      Chromium (win64-150.0.7871.24, ~415 MB) staged from the local cache
      (skip-if-same-version marker) into resources/chrome and wired via
      PUPPETEER_EXECUTABLE_PATH → config.puppeteerExecutablePath. Seed data
      bundled: consistent snapshot of data/csr-intel.db (189 entities incl.
      173 companies + 16 schemes, 5 innovators) copied to userData on first
      run; empty-DB fallback still works (migrations run at boot). NSIS
      assisted installer, per-user or all-users (Program Files) choice,
      Desktop + Start Menu shortcuts. VERIFIED END-TO-END on this machine:
      silent install → shortcuts + Add/Remove entry present → launched FROM
      THE SHORTCUT → 173 companies served by the installed exe → graceful
      close (0 leftover processes, port free) → silent uninstall removed
      dir/shortcuts/registry (user DB preserved by design).
- [x] Repo cleanup + public-push prep — DONE 2026-07-14. Deleted dead
      confidence-scorer.ts + drift-compute.ts (+10 tests — superseded
      duplicates; verification/drift agents ship their own inline logic),
      docker-era Dockerfile/docker-compose.yml/deploy.sh, one-shot
      scripts/dev-tools/ + migrate-postgres-to-sqlite.ts; dead config fields
      (databaseUrl, LLM trio) removed; .env.example + README rewritten to
      match reality. Verified alive-via-dynamic-import before deleting:
      coordinator.agent, schemes-seed, innovator-research, innovator-import.
      Tests 146→136 green. Pushed to github.com/Shiv-Gaur/CSR-Intel main.
- [x] Auto-update (electron-updater ← GitHub Releases) — DONE 2026-07-14,
      v1.0.1. main.ts: checks on launch + every 4h (packaged only), background
      download, "Restart now/Later" dialog on update-downloaded, all failures
      caught (never crash — verified live against a 404 feed). Gear panel:
      desktop-only "Check for updates" button + status line (IPC via
      preload.cjs contextBridge). electron-builder publish: github/Shiv-Gaur/
      CSR-Intel; `npm run release` (--publish always, GH_TOKEN-gated, uploads
      draft release + latest.yml). CRITICAL FIX found by testing the real
      installer: @electron/rebuild's .forge-meta marker survived the post-
      build Node-ABI restore, so the 2nd+ packaging run shipped a Node-ABI
      better-sqlite3 that crashed the packaged server at boot
      (NODE_MODULE_VERSION 127 vs 148). stage-electron-assets now deletes the
      marker; scripts/verify-packaged-native.ts loads the packaged module
      under ELECTRON_RUN_AS_NODE at the end of every electron:dist/release —
      wrong ABI now fails the build. UI flow verified via CDP-driven click in
      the installed app. KNOWN GAPS: repo is currently PRIVATE (updater feed
      404s for users — must be made public), installer unsigned (SmartScreen
      on first browser download; auto-updates themselves bypass SmartScreen —
      no Mark-of-the-Web), full update round-trip untested until a real
      GitHub release exists.
- [x] STAGE 1 — Expanded domain taxonomy + Innovator feasibility fields — DONE
      2026-07-21. Domain taxonomy grew 9→13: added semiconductors,
      energy_security, industry_4_0, smart_agriculture (clean_air folded into
      air_pollution, renewable_missions into green_hydrogen via keywords).
      Updated DOMAIN_SECTOR_MAP/DOMAIN_LABELS/DOMAIN_KEYWORDS (innovator-match.ts),
      InnovatorDomain union (types), createInnovator Zod enum, dashboard DOMAINS
      (filter + Add-Innovator dropdowns). New Innovator-only columns (migration in
      runMigrations, idempotent PRAGMA-guarded ALTER for existing DBs — RAN on the
      live 5-innovator DB): robustness_logistics, robustness_geographic_scalability
      (strong/moderate/weak/unknown), indigenous_tech (bool/null), govt_mission_
      alignment (text[]), subsidy_land_electricity (json {land,electricity,notes}),
      capex_subsidy_available/notes, opex_subsidy_available/notes. Deterministic
      LLM-free auto-detection during enrichment (src/utils/feasibility.ts):
      indigenous ("Made in India" vs "licensed from"), 14 govt missions (PLI, Make
      in India, Swachh Bharat, National Hydrogen Mission…), subsidy keyword scans —
      all low-confidence, fill-only-if-empty, never overwrite locked fields. New
      "Feasibility" tab in the Innovator detail panel (read summary + inline edit
      form) — PUT /api/innovators/:id/feasibility writes + LOCKS every touched
      field (data.feasibility_overrides), so re-enrichment can't clobber a human
      value. New Innovators-tab filters: Indigenous Tech (yes/no/unknown pills) +
      Government Mission Alignment (multiselect). Tests: feasibility.test.ts (11).
      Verified live: Chakr Innovation feasibility PUT round-trip + lock map.
- [x] STAGE 2 — Internal curated cross-entity search engine — DONE 2026-07-21.
      Global header search (🔍 / Ctrl+K) opens an overlay, separate from the
      per-tab table search. Local-first: SQLite FTS5 virtual table search_fts
      (created in runMigrations; FTS5 ships in better-sqlite3), rebuilt on demand
      from companies+schemes+innovators (name/sectors/domain_focus/description/
      usp/eligibility). GET /api/search?q= returns ranked matches grouped by type,
      each clickable to its detail panel; toFtsQuery sanitizes user input to a safe
      prefix-AND MATCH (operator chars can't throw). Live curated fallback
      (src/tools/curated-search.ts) fires when local <5 or on "Search the web for
      more": Wikipedia OpenSearch + Screener API + IndiaCSR/YourStory/Inc42 title
      scrape, all keyless, fail-soft, deduped, round-robin interleaved. Leads shown
      in a distinct "Found via trusted sources" section (NOT as verified data) with
      "＋ Add as Innovator/Company" — company adds POST /api/companies + open live
      enrichment progress; innovator adds pre-fill the Add-Innovator modal (domain
      pick) then run deep research. Tests: search-fts.test.ts (6, incl. the
      spec "plastic waste"→Nepra case), curated-search.test.ts (6, HTTP mocked).
      Verified live: DB-hit "plastic waste" → 17 local incl. Nepra; DB-miss
      "hydrogen fuel cells" → 0 local → live Wikipedia leads.
- [x] FULL UI REDESIGN — glass/gradient sidebar shell — DONE 2026-07-23. Visual
      reference: docs/design/redesign-mockup.html (exact CSS reused: gradient
      stops, glass rgba/blur values, 236px sidebar, logo-chip gradient, stat-card
      3px accent bars, score-bar gradients). Dark top bar replaced by a left
      sidebar: DRIIV logo on dark gradient chip, icon nav (Overview / Companies /
      Welfare Schemes / Innovators / Search / Settings; active = tinted+accent),
      pinned bottom update strip ("Up to date · v{version} · checked on launch" →
      "Update available — Restart" on download; new updates:state IPC +
      updates:restart in electron/main.ts + preload.cjs; autoUpdater confirmed to
      check on EVERY launch, 10s after ready, then 4-hourly). Main top strip:
      global search bar (opens the existing Ctrl+K curated overlay — distinct from
      the per-tab quick filter, BOTH kept); page title/subtitle; compact action
      row (Add Company / Add Innovator / Import Excel / Download Template /
      Re-enrich All / Download CSV). Notification bell REMOVED from UI (no
      backend existed; client code deleted). Insights block REMOVED — useful
      numbers moved to a new Overview page of 8 glass stat cards (Ready card
      deep-links to filtered Companies). Filters consolidated: Status pills → a
      single Status dropdown; companies Advanced = one dropdown with
      Score/Profile Match/Source/TRL radio groups; innovators = Domain/TRL/Stage/
      Geography/Govt Mission/Ownership/Indigenous dropdowns; schemes =
      Status/Sector/Geography/TRL dropdowns — active-filter chips + Clear all
      kept. All columns kept (Score AND Profile Match separate; Profile Match now
      a purple-gradient bar). ZERO feature loss verified in the live Electron
      window via CDP: add/edit/delete, Excel import+template, Re-enrich All w/
      progress+ETA, per-entity Force Re-enrich, bulk bar (select-all/re-enrich/
      export/mark-reviewed/delete/clear), CSV export, Match Profile settings
      (Settings nav opens it; manual "Check for updates" inside), TRL filter,
      sortable columns, sticky detail panel w/ all tabs (incl. Feasibility),
      Key Contacts/MoU/domain tags/feasibility fields. backdrop-filter verified
      rendering in packaged-style Electron Chromium (computed blur(22px)
      saturate(1.6)) AND headless browser mode. Accessibility deviation from
      mockup: --ink-muted darkened #8990a8→#6d7490 for AA-ish contrast on glass.
      NOTE: .claude/skills/ui-overhaul/SKILL.md still describes the pre-redesign
      white/pills design — stale, needs a refresh.
- [x] Manual export/import snapshot sync (share data between machines) — DONE
      2026-07-28. `src/sync/snapshot.ts`: buildSnapshot() dumps entities (split
      companies vs govt_scheme) + innovators into a versioned JSON envelope
      (format marker, schema_version 1, app_version, exported_at, counts);
      parseSnapshot() rejects non-JSON, wrong format, newer schema, mismatched
      app major, missing lists and nameless records. Import matches on `name`
      (case/whitespace-insensitive) and NEVER silently overwrites: new records
      insert, identical ones count as up-to-date, existing-but-different become
      conflicts the user resolves by hand; only "use imported" choices reach
      applyResolutions(). Routes: GET /api/sync/export (download), POST
      /api/sync/import (raw JSON body → counts + conflict details), POST
      /api/sync/import/resolve (Zod-validated resolutions). UI: Export/Import
      snapshot buttons in Settings — Match Profile, using Electron native
      Save/Open dialogs (sync:save / sync:open IPC + preload saveSnapshot/
      openSnapshot), falling back to a browser download + file input; import
      summary modal shows new/up-to-date/conflict counts with per-conflict
      Keep local / Use imported / Skip radios over a Field/Local/Imported diff
      table. 23 unit tests in src/sync/__tests__/snapshot.test.ts (shape,
      validation, diffing, resolutions) plus a verified two-database round-trip
      (export → add 3 companies → re-export → import into a second DB: 3 added,
      2 up-to-date, 1 conflict, local-only and locally-edited rows untouched, no
      duplicates, re-import idempotent). NOTE: this is the v1 stopgap — the DB
      access style inside snapshot.ts is the SYNCHRONOUS `query` from sqlite.ts,
      not the async getPool() facade, because better-sqlite3 transactions cannot
      contain awaits. LIVE-VERIFIED 2026-07-29 in the running Electron app
      against the real 173-company DB: native Save dialog produced a valid
      1.5 MB snapshot (173/16/5); re-importing it showed "0 new · 194 already up
      to date · 0 conflicts"; importing a modified copy showed 4 conflicts with
      diff tables and Keep local/Use imported/Skip radios; applying with the
      Keep-local defaults wrote nothing and left all records untouched.
- [x] Ship snapshot sync to users — RELEASED as **v1.0.5** 2026-07-29:
      https://github.com/Shiv-Gaur/CSR-Intel/releases/tag/v1.0.5 (id 361724396,
      non-draft, tag at commit c20397e). Numbered 1.0.5 not 1.0.4 because an
      earlier unpublished 1.0.4 build (2026-07-27, pre-snapshot-sync) was already
      installed locally and electron-updater treats equal versions as "no
      update"; the unreleased v1.0.4 tag was deleted and its stale artifacts
      moved to `release/_stale-2026-07-27/`. All three assets on ONE release
      (installer 204,150,193 B + .blockmap + latest.yml), with latest.yml
      verified by downloading the published installer and recomputing its sha512
      (declared == measured) rather than trusting file presence. electron-builder
      again split the publish into TWO non-draft releases with assets divided
      between them — repaired by deleting both and recreating one via the API;
      this is now reproducible (v1.0.3 and v1.0.5), so treat the publish step as
      unreliable and always verify.
- [x] `npm run build` type-checks `electron/` too — DONE 2026-07-29. `build` is
      now `tsc && npm run electron:build` (server-only compile kept as
      `build:server`); electron:dev/electron:dist/release no longer invoke
      electron:build separately. Previously tsconfig.json excluded `electron/`
      entirely, so a broken main process passed `npm run build` silently —
      confirmed fixed by injecting a type error and watching the build fail.
