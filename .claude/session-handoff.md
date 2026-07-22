# Session Handoff — CSR Funding Intelligence (2026-07-21)

## 1. Goal
Two features in one session, both DONE:
- STAGE 1: expanded domain taxonomy (9→13) + new Innovator-only feasibility
  fields (robustness, indigenous tech, govt-mission alignment, subsidies) with
  deterministic auto-detection, a Feasibility detail tab, and two new filters.
- STAGE 2: internal curated cross-entity search — local SQLite FTS5 first, live
  trusted-source leads (Wikipedia/Screener/IndiaCSR/YourStory/Inc42) as fallback,
  with one-click "Add as Innovator/Company".
Gates: build ✅ (tsc clean), 188/188 tests ✅ (was 165; +23 new), migration RAN on
the live DB, npm run status healthy (173 companies / 16 schemes / 5 innovators).

## 2. Completed (exact paths)
STAGE 1:
- Domains 9→13 (added semiconductors, energy_security, industry_4_0,
  smart_agriculture; clean_air→air_pollution, renewable_missions→green_hydrogen
  via keywords): src/types/index.ts (InnovatorDomain union), src/utils/
  innovator-match.ts (DOMAIN_SECTOR_MAP/DOMAIN_LABELS/DOMAIN_KEYWORDS),
  src/dashboard/dashboard.ts (createInnovator Zod enum → INNOVATOR_DOMAINS),
  src/dashboard/dashboard.html (DOMAINS array — feeds filter pills + Add-Innovator
  dropdown).
- New innovators columns + migration: src/db/index.ts runMigrations — added to the
  CREATE TABLE (fresh DBs) AND idempotent PRAGMA-guarded ALTER (existing DBs; RAN
  via `npm run db:migrate`). Columns: robustness_logistics,
  robustness_geographic_scalability, indigenous_tech, govt_mission_alignment,
  subsidy_land_electricity, capex_subsidy_available/_notes, opex_subsidy_available/
  _notes. Registered JSON columns in src/db/sqlite.ts (govt_mission_alignment,
  subsidy_land_electricity, search_meta). INNOVATOR_PATCH_COLS + InnovatorInsert
  extended.
- Auto-detection (NEW src/utils/feasibility.ts): detectIndigenousTech,
  detectGovtMissionAlignment (14 canonical missions), detectSubsidies,
  detectFeasibilitySignals. Wired into src/tools/innovator-research.ts
  (enrichInnovator) — fill-only-if-empty, respects data.feasibility_overrides
  locks, stores feasibility_detected_at.
- Feasibility tab: src/dashboard/dashboard.html renderInnovatorDetail — added
  'feasibility' tab, feasibilityHtml() (read summary + inline edit form),
  wireFeasibility() (PUT + reload). Endpoint PUT /api/innovators/:id/feasibility
  in dashboard.ts (feasibilitySchema, locks every touched field).
- Filters: Indigenous Tech pills + Govt Mission multiselect in the Innovators tab
  (F.indigenous / F.missions through readURL/writeURL/clearAll/renderFilters/
  visibleInnovators/chips; DD_LABELS generalized for the missions dropdown).
  flattenInnovator exposes camelCase feasibility fields + feasibilityOverrides.

STAGE 2:
- FTS5: src/db/index.ts — search_fts virtual table (created in runMigrations),
  rebuildSearchIndex(), searchEntities(), toFtsQuery() (safe prefix-AND).
- Live curated (NEW src/tools/curated-search.ts): curatedWebSearch() +
  per-source fetchers (searchWikipedia/Screener/IndiaCsr/YourStory/Inc42),
  dedupeLeads, normName. Promise.allSettled, fail-soft, round-robin interleave.
- API: GET /api/search?q=[&live=true] in dashboard.ts (local always, live only
  when live=true — frontend auto-fires live when localTotal<5).
- UI: src/dashboard/dashboard.html — header 🔍 button (#globalSearchBtn, Ctrl+K),
  #searchModal overlay, runGlobalSearch/renderSearchResults/searchLocalSection/
  searchLiveSection, openSearchResult (→ detail panel), addCompanyFromLead
  (POST /api/companies + enrich progress), addInnovatorFromLead (pre-fills
  Add-Innovator modal).
- Tests: NEW src/utils/__tests__/feasibility.test.ts (11),
  src/db/__tests__/search-fts.test.ts (6, incl. "plastic waste"→Nepra),
  src/tools/__tests__/curated-search.test.ts (6, axios mocked).

## 3. Decisions
- Robustness (logistics + geo scalability) is NOT auto-detected — too subjective
  for keyword matching; defaults 'unknown', set manually via the tab.
- Subsidy/indigenous detectors set true or leave null, NEVER false — a source not
  mentioning a subsidy is not evidence of its absence. indigenous ties → null.
- Saving the Feasibility form locks EVERY field on it (data.feasibility_overrides),
  not just changed ones — the user reviewed the whole form, so it's asserted.
- FTS index is rebuilt on each /api/search call (cheap at hundreds of rows) —
  always fresh, no sync bugs. Revisit if entity count grows into 10k+.
- Live search runs server-side only with &live=true so a keystroke never blocks on
  the network; frontend debounces 300ms and auto-triggers live at localTotal<5.
- curated-search does its OWN raw axios+cheerio (fetchAuto returns stripped text,
  unusable for link extraction). Wikipedia OpenSearch + Screener API are the
  reliable clean-name sources; IndiaCSR/YourStory/Inc42 are best-effort scrapes.

## 4. In progress
Nothing half-done. Working tree has the feature edits (uncommitted — user has not
asked to commit). Live demo server (scratchpad/serve.mjs on :3939) was stopped.
The demo PUT that populated Chakr Innovation's feasibility was RESET back to
defaults afterwards (made-up values, no source) — the live DB is clean.

## 5. Next steps (first prompts for next session)
1. "Commit Stage 1 + Stage 2" if the user wants it in git (not done — awaiting ask).
2. "Wire robustness auto-hints" — optional: infer logistics/geo scalability from
   team_size/geography spread as a low-confidence starting guess.
3. Pre-existing open item: "Build financial data extraction (revenue, net profit,
   CSR budget)" — still the last open tracker item (inference.ts).

## 6. Blockers (need human input)
- Live curated search depends on outbound network; in this env Wikipedia + Screener
  respond, the WordPress scrapes (IndiaCSR/YourStory/Inc42) often return nothing
  (bot walls / JS shells) — fail-soft by design, but lead quality varies by source
  reachability. No API keys added (search-free mode unchanged).
- (Carried) Repo github.com/Shiv-Gaur/CSR-Intel still PRIVATE → auto-update feed
  dead until the user flips visibility; GH_TOKEN needed for `npm run release`.
- No hot reload: restart after src edits; kill the port PID first (orphaned tsx
  children recur; the Electron shell attaches to any server already on port 3000).
