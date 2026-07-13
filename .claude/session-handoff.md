# Session Handoff — CSR Funding Intelligence (2026-07-12)

## 1. Goal
(a) Run the "Re-enrich All" batch for real on all 173 companies; (b) fix 4 bugs
(status regression, wrong/fake exec contacts, delete-icon tooltip overlap, missing
Re-enrich All button) + sticky detail panel; (c) restructure the repo and push to
GitHub. All done. Gates: build ✅, 133/133 tests ✅, live browser-verified ✅.

## 2. Completed (exact paths — post-restructure)
- **Batch run**: 173/173 done, 0 failed, 2h44m (avg 57s/company). All rows have
  same-day enriched_at + sources + domain_focus; 118 key_contacts, 34 mou_history.
- **`src/agents/enrichment.agent.ts`** — no longer downgrades verified/complete
  unless needsHumanReview fails; official-site contact step 4.2b added.
- **`src/agents/verification.agent.ts`** — never pulls complete→verified except on
  genuine conflicts. Verified live: 13 re-enrichments, zero regressions.
- **`src/tools/official-site.ts`** — NEW `fetchCompanyOfficialContacts(domain)`:
  sitemap.xml → homepage links → path guesses (max 4 pages); contacts ONLY.
- **`src/utils/extractor.ts`** — contact tiers (own site > BSE/NSE/Zauba > rest),
  UNVERIFIED_CONTACT_NOTE on unconfirmed aggregator names, namesConsistent()
  subset matching, NAME_STOPWORDS +org/chrome/verb words, mid-string-honorific
  reject, leading-honorific strip.
- **`scripts/dev-tools/purge-unconfirmed-wiki-contacts.ts`** — RUN: 204 contacts
  purged across 101 companies.
- **`src/dashboard/dashboard.html`** — SVG trash icon (no title attr — native
  tooltip was BUG 3), header ↻ Re-enrich All btn (all-rows, confirm dialog),
  sticky `.panel.side`, click-again deselect, ⚠ unverified label on contacts.
- **`src/dashboard/dashboard.ts`** — GET /api/reenrich-all/active (cross-browser
  batch reattach); moved from src/ root, dynamic imports fixed.
- **Restructure**: dashboard→src/dashboard/, logger→src/utils/logger-core.ts,
  4 scripts→scripts/dev-tools/, PROJECT_REQUIREMENTS.md+2 design HTMLs→docs/,
  deleted claude.ts.disabled + 10 scripts/test-*.js + test:search script + 7
  unused imports (LLM-era schema consts). README.md + .gitignore NEW.
- **Tests**: +10 in reenrich-batch.test.ts (new) + executive-contacts.test.ts.
- **Git**: repo initialized, pushed to https://github.com/Shiv-Gaur/CSR-Intel
  (main, 78 files, merge over GitHub's stub initial commit, .env excluded).

## 3. Decisions
- Enrichment preserves earned status; only needsHumanReview (score<30, no
  sectors/geos) justifies downgrade. Verification conflict branch still demotes.
- Aggregator (wiki/linkedin/nasscom/…) names: dropped only when contradicting a
  tier-1/2 name for the same title (namesConsistent guards noisy supersets);
  otherwise kept + labelled "Unverified — not confirmed on company's own site".
- No domain guessing: official-site runs only for the ~29 companies with a
  curated `website` in src/tools/known-urls.ts. "Infosys" entity ≠ "Infosys
  Foundation" seed (exact match) — so Infosys gets no tier-1 pages.
- docs/PROJECT_REQUIREMENTS.md is the tracker's NEW path (user-confirmed move);
  memory + MEMORY.md updated to match.
- Old interrupted batch's 120 pending enrich tasks were cancelled as
  failed/'superseded' 2026-07-12 — those failed counts in task_queue are expected.

## 4. In progress
Nothing half-done. Dev server running on http://localhost:3000 (bg task bzff6bpuo,
current restructured code). Working tree clean, pushed. 4 pending human reviews +
~32 stale seed_drift:running claims pre-existing, untouched.

## 5. Next steps (suggested first prompts)
1. "Build financial data extraction (revenue, net profit, CSR budget) for manually
   added companies" — the LAST open tracker item (docs/PROJECT_REQUIREMENTS.md);
   `estimateSpendFromProfit` in src/utils/inference.ts is the seed.
2. "Add official websites for the remaining ~144 companies to known-urls.ts (or
   fuzzy-match seeds like Infosys→Infosys Foundation)" — widens tier-1 contact
   coverage beyond 29 companies.
3. "Rebuild the csr-app Docker image (docker compose build app) + drop obsolete
   version: key" — carried over since 2026-07-06; Dockerfile html-copy path was
   already updated for src/dashboard/.

## 6. Blockers (need human input)
- Web search still disabled (search-free mode); Crunchbase/LinkedIn/NSE/Zauba may
  bot-block (fail soft). Cipla's own site returned 0 usable pages when probed.
- DB = docker `csr-postgres` @ localhost:5432/csr_intel (postgres/postgres);
  native PG18 on 5433 is NOT it. Docker Desktop needs manual start after reboot.
- No hot reload: restart `npm run dev` after src edits; kill orphaned node on
  port 3000 first (Get-NetTCPConnection -LocalPort 3000).
- git push auth worked this session (existing credentials); no token setup needed.
