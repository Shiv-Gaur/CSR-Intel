# Session Handoff — CSR Funding Intelligence (2026-07-07)

## 1. Goal
Recover dropped requirements per the new **PROJECT_REQUIREMENTS.md** (root — single source
of truth, read it first every session): sortable columns, executive-contact extraction,
sustainability-score=0 fix, softened low-score visuals, company domain_focus, more data
sources, ownership-transfer/5-yr/MoU for companies.
All gates green: **build ✅, 97/97 tests ✅ (23 new), live browser-verified ✅ (3 headless-
Chrome screenshots), status ✅, tracker updated ✅.**

## 2. Completed (exact paths)
- **`PROJECT_REQUIREMENTS.md`** — NEW permanent tracker; 9 items closed this session,
  1 open (financial data extraction).
- **`src/utils/sustainability.ts`** — NEW pure module: `detectCircularityIndicators`,
  `scoreSustainability` (moved from innovator-research.ts, re-exported there),
  `computeInnovatorSustainability` (OR-merges provided+detected indicators).
- **`src/db/index.ts`** — `insertInnovator` now computes sustainability at insert when
  none supplied (root cause of the all-zeros bug: hard default 0, only deep research ever
  set it). Migration: `innovators.key_contacts JSONB DEFAULT '[]'`. `INNOVATOR_PATCH_COLS`
  + jsonCols include key_contacts. `rerankAllProfileScores` passes `data.domain_focus`.
- **`src/utils/extractor.ts`** — NEW: `extractExecutiveContacts` (two-step: locate title
  case-insensitively, then CASE-SENSITIVE name regex in a ±60/70-char window — a combined
  /i regex swallowed lowercase words), `mergeExecutiveContacts`, `detectDomainFocus` (uses
  DOMAIN_KEYWORDS), `domainFocusLabel`, `extractMoUHistory` (MoU/MOU/memorandum forms,
  capitalized-word partner capture), `detectOwnershipTransfer` (true/null).
- **`src/utils/match.ts`** — `CompanyMatchInput.domain_focus?`; +4/domain cap 12 boost.
- **`src/tools/free-sources.ts`** — `SourceEntity.kind` + `innovatorType`; new keyless
  sources (innovator: crunchbase/yourstory/inc42/startupindia/linkedin/nasscom/scholar;
  company: moneycontrol/linkedin/nasscom).
- **`src/agents/enrichment.agent.ts`** — persists `key_contacts`, `domain_focus`,
  `mou_history`, `ownership_transfer_open`; passes kind:'company'.
- **`src/tools/innovator-research.ts`** — key_contacts extraction per source; passes
  kind:'innovator' + type; imports scoring from utils/sustainability.
- **`src/dashboard.ts`** — flattenCompany: keyContacts/domainFocus/mouHistory/
  ownershipTransferOpen/csrSpendByYear; flattenInnovator: keyContacts; CSV: Domain Focus +
  CEO/MD/CSR-Head name+email columns + fixed Source Confidence `[object Object]`.
- **`src/dashboard.html`** — sortable headers (SORT state, cycleSort asc→desc→reset, ↑/↓,
  URL-persisted `?sort=&dir=`, reset on tab CLICK not in setTab — init order!); softened
  scoreVerdict (Strong/Good match green/blue, Fair match + Limited data grey; susBar
  orange→blue); Key Contacts cards (confidence badge + source) in company overview/CSR tab
  + innovator overview; Domain Focus tags; Ownership + MoU fields in company CSR tab;
  CSR Spend Trend (5-yr) in History tab; deep link `?select=<id>` opens detail on load.
- **`src/utils/__tests__/executive-contacts.test.ts`** — NEW, 16 tests.
- **`src/utils/__tests__/sustainability.test.ts`** — NEW, 7 tests.
- **`scripts/backfill-scores.ts`** — NEW, idempotent, ALREADY RUN: 5 innovators rescored
  (Nepra 49, Phool 49, Hasiru 38, Chakr 34, Log9 15), domain_focus backfilled, 173 reranked.

## 3. Decisions
- Company key_contacts live inside `entities.data` (jsonb, like every other enriched
  field); innovators got a dedicated column (their pattern).
- `detectOwnershipTransfer` returns true or **null** — absence of language is not "No".
- No exec emails found for TCS (companies rarely publish them); mechanism unit-tested,
  generic csr@/foundation@ mailboxes are the realistic catch. Requirement says "if found".
- LinkedIn/NASSCOM pages contribute some cross-page name noise (clearly source-labelled,
  medium confidence); NAME_STOPWORDS extended (tenure/central/europe/…) to cut the worst.
- db-ops skill is partially stale (references `companies` table / UPPERCASE statuses —
  real schema is `entities` + lowercase). Followed its migration rules only.

## 4. In progress
Nothing half-done. Dev server running in background on http://localhost:3000 (bg task
bat9ljxor — current code, includes CSV fix). TCS (id 0b9787a1…) was re-enriched twice as
the contacts test subject; its data is current. 4 pending human reviews pre-existing,
untouched. 30 `seed_drift:running` tasks are stale claims from old sessions (pre-existing).

## 5. Next steps (suggested first prompts)
1. "Build financial data extraction (revenue, net profit, CSR budget) for manually added
   companies" — the last open tracker item; `estimateSpendFromProfit` is the seed.
2. "Bulk re-enrich all 173 companies so key_contacts/domain_focus/MoU populate everywhere"
   (only TCS has them so far; ~9 fetches × ~1s each per company — run overnight via cron?).
3. "Rebuild the csr-app Docker image (docker compose build app) + drop obsolete version:
   key" — carried over from 2026-07-06 handoff, still not done.

## 6. Blockers (need human input)
- Web search still disabled (search-free mode) — new sources are direct-URL only;
  Crunchbase/LinkedIn may bot-block (harmless: MIN_SOURCE_CHARS filters empties).
- DB = docker `csr-postgres` @ localhost:5432/csr_intel (postgres/postgres). Native PG18
  on 5433 is NOT the project DB. Docker Desktop must be started manually (was down at
  session start; I started it). Restart `npm run dev` after src edits (no hot reload) —
  kill any orphaned node on port 3000 first.
