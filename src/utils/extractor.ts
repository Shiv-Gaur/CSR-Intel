// Deterministic, dependency-free extractors that replace the previous
// Ollama/LLM pipeline. No API calls, no API keys — runs on any machine.
// Mirrors the field shapes the LLM used to produce so the DB schema is unchanged.

import { DOMAIN_KEYWORDS, DOMAIN_LABELS } from './innovator-match.js';
import { logger } from './logger.js';
import type { InnovatorDomain } from '../types/index.js';

// ─── Regex helper ─────────────────────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Sectors — 15 canonical Indian CSR sectors + match keywords ──────────────

export const SECTOR_KEYWORDS: Record<string, string[]> = {
  'Education': ['education', 'school', 'literacy', 'scholarship', 'e-learning', 'students'],
  'Healthcare': ['healthcare', 'health care', 'hospital', 'medical', 'clinic', 'nutrition', 'immunization', 'public health'],
  // Only the 4 most specific keywords — generic ESG words ("sustainability",
  // "green", "sustainable", "eco", bare "environment") appear on virtually every
  // corporate page and made Environment the top sector for 112/172 companies.
  'Environment': ['environmental', 'climate', 'carbon', 'biodiversity'],
  'Rural Development': ['rural development', 'village development', 'rural area', 'gram panchayat'],
  'Women Empowerment': ['women empowerment', "women's empowerment", 'gender equality', 'girl child', 'self help group'],
  'Skill Development': ['skill development', 'skilling', 'vocational training', 'employability', 'livelihood'],
  'Sanitation': ['sanitation', 'swachh', 'toilet', 'hygiene'],
  'Drinking Water': ['drinking water', 'safe water', 'clean water', 'water supply', 'potable water'],
  'Sports': ['sports', 'athletics', 'olympic', 'paralympic'],
  'Arts & Culture': ['arts and culture', 'arts & culture', 'heritage', 'cultural', 'handicraft'],
  'Technology': ['technology', 'digital literacy', 'digital inclusion', 'ict', 'innovation incubator'],
  'Poverty Alleviation': ['poverty alleviation', 'poverty eradication', 'eradicating hunger', 'hunger', 'food security'],
  'Disaster Relief': ['disaster relief', 'disaster management', 'calamity', 'flood relief', 'pandemic relief'],
  'Animal Welfare': ['animal welfare', 'animal husbandry', 'cattle', 'stray animal'],
  'Armed Forces Veterans': ['armed forces veterans', 'war widows', 'ex-servicemen', 'armed forces'],
};

// Max sectors returned — CSR reports mention nearly every sector in passing, so
// we keep only the most strongly-evidenced ones rather than tagging all 15.
const MAX_SECTORS = 6;

// Case-insensitive keyword match. Returns canonical sectors RANKED by how many
// keyword hits each has (most-evidenced first) and capped at MAX_SECTORS, so the
// first entry is the company's most prominent sector — not an alphabetical default.
export function extractSectors(text: string): string[] {
  if (!text) return [];
  const scored: Array<{ sector: string; hits: number }> = [];
  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    let hits = 0;
    for (const kw of keywords) {
      const m = text.match(new RegExp('\\b' + escapeRegExp(kw), 'ig'));
      if (m) hits += m.length;
    }
    if (hits > 0) scored.push({ sector, hits });
  }
  scored.sort((a, b) => b.hits - a.hits);
  return scored.slice(0, MAX_SECTORS).map(s => s.sector);
}

// Canonical key order of SECTOR_KEYWORDS. The pre-ranking extractor emitted
// sectors in exactly this relative order (Education-first), so a stored list
// still in that order is stale/unranked; a list out of this order was produced
// by frequency ranking, so its first element is the most-evidenced sector.
const CANONICAL_SECTOR_ORDER = Object.keys(SECTOR_KEYWORDS);

/**
 * True when `sectors[0]` can be trusted as the "highest-confidence extracted
 * sector". A single extracted sector is always its own top. For longer lists we
 * inspect only the canonical sectors (unknown/legacy names are skipped, never
 * treated as an order break) and call the list ranked when those known positions
 * break the canonical SECTOR_KEYWORDS order — i.e. it was frequency-ranked.
 */
export function sectorsAreRanked(sectors: unknown): boolean {
  if (!Array.isArray(sectors) || sectors.length === 0) return false;
  if (sectors.length === 1) return true; // sole extracted sector is the top
  // Positions of only the known canonical sectors; unknown names are ignored.
  const positions = sectors
    .map(s => CANONICAL_SECTOR_ORDER.indexOf(String(s)))
    .filter(i => i !== -1);
  if (positions.length < 2) return false; // not enough signal to call it ranked
  for (let k = 1; k < positions.length; k++) {
    if (positions[k] <= positions[k - 1]) return true; // out of canonical order ⇒ ranked
  }
  return false;
}

// ─── Geographies — 28 states + 8 UTs + pan-India variants ────────────────────

const STATES_AND_UTS = [
  // 28 states
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa',
  'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland',
  'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  // 8 union territories
  'Andaman and Nicobar Islands', 'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi',
  'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
];

const PAN_INDIA_VARIANTS = ['pan india', 'pan-india', 'all india', 'nationwide', 'across india'];

// Returns canonical state/UT names found, plus "Pan-India" if a national-scope phrase appears.
export function extractGeographies(text: string): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const name of STATES_AND_UTS) {
    if (new RegExp('\\b' + escapeRegExp(name) + '\\b', 'i').test(text)) {
      found.push(name);
    }
  }
  if (PAN_INDIA_VARIANTS.some(v => new RegExp('\\b' + escapeRegExp(v), 'i').test(text))) {
    found.push('Pan-India');
  }
  return found;
}

// ─── Spend — parse Rs/INR/₹ + crore patterns, return CSR spend in crores ─────

// Only crore figures whose nearby context is CSR-related are treated as CSR
// spend. Pages from financial sources (e.g. Screener.in) carry large crore
// figures for revenue/profit/turnover/EBITDA — those must NOT be captured as
// CSR spend. A figure is accepted only if a CSR keyword appears within ~100
// chars and a revenue keyword does not dominate that same window.
const SPEND_CSR_CONTEXT = /(csr|social responsibility|community investment|foundation|spent|allocated|committed|donated|contribution)/i;
// Not-CSR money. A figure whose context is dominated by any of these is some
// other corporate number — revenue, a bond issue, a capex plan, a loan book —
// that happens to share the page with CSR reporting.
const SPEND_REVENUE_CONTEXT = /(revenue|profit|turnover|ebitda|market cap|valuation|borrowing|bond|debenture|invest|capex|loan|disburse|order book|ipo|fundrais|net worth|assets under management)/i;

// Publisher/site names that contain "CSR" — on these domains EVERY article
// carries the string in its byline ("by India CSR", "IndiaCSR Network"), which
// satisfied SPEND_CSR_CONTEXT unconditionally and made the CSR-context check a
// no-op. That is how a green-infrastructure BOND (Bank of Baroda, ₹10,000 Cr),
// a state INVESTMENT (Godrej, ₹10,000 Cr) and a national FOREIGN-BORROWINGS
// statistic (₹27,556 Cr) were all stored as CSR spend. Stripped before the
// context test so only the article's own words can establish CSR relevance.
const PUBLISHER_BYLINE = /\b(india\s*csr(\s*network)?|csr\s*journal|csr\s*times|csr\s*box|csr\s*mandate)\b/ig;

// A one-off donation is NOT annual CSR programme spend. "Bank of Baroda Donates
// Rs 1 Crore to Uttarakhand CM Relief Fund" is a real, correctly-attributed CSR
// figure that says nothing about the company's annual budget — and storing it as
// `csr_spend_cr` is what put an identical 1 Cr on BoB, Canara Bank and Fortis.
// Round-number relief donations repeat across unrelated companies for the same
// reason boilerplate does: everyone gives the same tidy sum to the same appeal.
// The RECIPIENT is what marks a one-off, not the verb. "Donated Rs 8 crore to
// the foundation" is a company funding its own CSR foundation — ordinary
// programme spend — whereas the same verb pointed at a relief fund is a
// one-time cheque. Keying on the verb alone misclassified the former.
const RELIEF_RECIPIENT = /(relief fund|disaster relief|pm ?cares|cm relief|chief minister.{0,25}relief|flood relief|earthquake relief|cyclone relief|drought relief|immediate relief|war (?:effort|fund)|calamity)/i;
// Weak signals — only count when paired with an explicit one-time framing.
const DONATION_VERB = /(donat(?:e|es|ed|ion)|contribut(?:e|es|ed|ion) towards|handed over|presented a cheque)/i;
const ONE_TIME_MARKER = /(one[- ]time|one[- ]off|special contribution|in response to the|towards the victims)/i;

/** A single relief/disaster donation rather than an annual programme total. */
function isOneOffDonation(window: string): boolean {
  if (ANNUAL_SPEND_CONTEXT.test(window)) return false;   // annual framing always wins
  return RELIEF_RECIPIENT.test(window) || (DONATION_VERB.test(window) && ONE_TIME_MARKER.test(window));
}

// Strong positive evidence that a figure IS the annual programme total. When
// both fire, the annual reading wins — "donated Rs 400 crore under its FY24 CSR
// budget" is a budget statement that happens to use the verb "donated".
const ANNUAL_SPEND_CONTEXT = /(annual csr|csr budget|csr obligation|csr expenditure|total csr|fy\s?'?\d{2,4}|fiscal(?: year)?|financial year|spent .{0,30}on csr|allocated .{0,30}(for|under) csr|csr spend(?:ing)? (?:of|for|in)|under csr in)/i;

/** Real Indian CSR spend is mandated at ~2% of net profit; even the largest
 *  spenders (Reliance, TCS, HDFC) land in the hundreds of crores and the
 *  all-time top of the table is under ~2,000 Cr. A four-or-five-figure crore
 *  number is therefore never CSR — it is revenue, market cap, a bond, or a
 *  government programme outlay that leaked in from the same page. Rejected
 *  outright and logged for manual review: "Not found" beats a fabricated
 *  figure, per the data-integrity standard. */
export const SPEND_PLAUSIBILITY_CEILING_CR = 5000;

/** Distinctive tokens of a company name (plus its acronym) for proximity gates.
 *  Same recipe as the executive-contact aggregator gate: words ≥4 chars minus
 *  generic stopwords, the initials acronym when ≥3 chars, and the single word
 *  itself for one-word names (ITC, GAIL). */
export function entityNameTokens(entityName: string): string[] {
  const words = entityName.split(/\s+/).filter(Boolean);
  const tokens = words.map(w => w.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter(w => w.length >= 4 && !ENTITY_TOKEN_STOPWORDS.has(w));
  if (words.length >= 2) {
    const acronym = words.map(w => w[0]).join('').toLowerCase();
    if (acronym.length >= 3) tokens.push(acronym);
  }
  if (words.length === 1 && words[0].length >= 3) tokens.push(words[0].toLowerCase());
  return tokens;
}

/** Whole-word matchers for entity-name tokens, for gates that search prose.
 *  Substring matching false-accepts short names and acronyms — "ITC" hides
 *  inside "switch" and "pitch", "GAIL" inside "prevailing" — which would let an
 *  unrelated company's figure through on any page containing an ordinary
 *  English word. Gates that search a DOMAIN (emailRelatesToCompany) keep
 *  substring matching instead: "aartiindustries.com" has no word boundaries. */
export function entityTokenMatchers(tokens: string[]): RegExp[] {
  return tokens.map(t => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
}

/** Text of the sentence containing [start, end), for same-sentence attribution
 *  gates. Breaks on . ! ? newline and the separators scraped listings use in
 *  place of punctuation (| • —). Scraped PDF text can run for pages without any
 *  break, so the span is also hard-capped at ±300 chars — a name further away
 *  than that is not attribution, it is coincidence. */
const SENTENCE_BREAK = /[.!?\n|•—]/;
function sentenceAround(text: string, start: number, end: number): string {
  let from = Math.max(0, start - 300);
  for (let i = start - 1; i >= from; i--) {
    if (SENTENCE_BREAK.test(text[i])) { from = i + 1; break; }
  }
  let to = Math.min(text.length, end + 300);
  for (let i = end; i < to; i++) {
    if (SENTENCE_BREAK.test(text[i])) { to = i; break; }
  }
  return text.slice(from, to);
}

// Handles: "Rs. 45 crore", "INR 120 Cr", "₹45 crore", "45.2 crores", "Rs 12.5 Cr".
//
// `entityName` (optional but strongly recommended): source pages are often
// aggregator search/listing pages (IndiaCSR "?s=", Moneycontrol, news feeds)
// that mix MANY companies' CSR figures on one page. Whatever article snippet
// happened to be listed there used to leak in as the researched company's
// spend — the same figure then appeared on every company enriched that day
// (the "44.44 Cr on four unrelated companies" incident). With `entityName`
// given, a figure only counts when a distinctive token of the company name
// appears in the SAME SENTENCE as it. Proximity alone is not enough: a search
// page echoes the queried name in its own header ("Search results for: X"),
// which sits within any character window of every article listed below it —
// the exact page shape this gate exists to reject. A rejected real figure shows
// as "Not found", which the data-integrity standard prefers over a fabricated one.
export interface SpendCandidate {
  /** Figure in crore. */
  valueCr: number;
  /** `annual` — a programme/budget total, eligible for csr_spend_cr.
   *  `one_off` — a relief/disaster donation, eligible only for notable_donations. */
  kind: 'annual' | 'one_off';
  /** Context-strength score; the highest-scoring annual candidate wins. */
  strength: number;
  /** Trimmed local context, for storage alongside a donation and for logs. */
  context: string;
}

// Scoring window for context strength — deliberately tighter than a sentence.
// Scraped listings run headline and body together with no punctuation between
// them, so sentenceAround() can return a span covering several figures at once
// and score them all identically.
const STRENGTH_WINDOW = 120;

/** How strongly the surrounding text says "this is the annual CSR total".
 *  A figure quoted with a fiscal year AND measured against a stated obligation
 *  is a fuller-context statement than a bare number in a headline — that is the
 *  IndiGo case, where the headline said 13.96 Cr and the body of the same
 *  article said "spent Rs 139.68 crores on CSR in FY 2025, exceeding its Rs 11
 *  crore obligation". */
function contextStrength(window: string, after: string): number {
  let score = 0;
  if (/fy\s?'?\d{2,4}|fiscal(?: year)?|financial year|\bin \d{4}\b/i.test(window)) score += 2;
  if (/(obligation|mandated|statutory|required|prescribed|2 ?%|two per ?cent|target)/i.test(window)) score += 2;
  if (/(spent|expenditure|budget|total|allocated|outlay)/i.test(window)) score += 1;
  // A figure that IS the obligation ("exceeding its Rs 11 crore obligation") is
  // the benchmark being compared against, not the amount spent.
  if (/^\s*(?:crores?|cr)?\s*(?:obligation|target|requirement|mandate|threshold)/i.test(after)) score -= 4;
  return score;
}

/** Every CSR-looking figure on the page that survives the attribution, revenue
 *  and plausibility gates, classified and scored. Callers pick what they need:
 *  `extractSpend` takes the strongest annual figure, `extractNotableDonations`
 *  takes the one-off donations. */
export function extractSpendCandidates(text: string, entityName?: string): SpendCandidate[] {
  if (!text) return [];
  const tokens = entityName ? entityNameTokens(entityName) : [];
  const matchers = entityTokenMatchers(tokens);
  const textLc = tokens.length ? text.toLowerCase() : '';
  const out: SpendCandidate[] = [];
  const re = /(?:rs\.?|inr|₹)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:crores?|cr)\b/ig;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    // Context window: ~60 chars before the figure (where the label usually sits)
    // through ~40 chars after — keeps the keyword "within 100 characters".
    // The publisher byline is stripped FIRST: it must not be able to satisfy
    // either the CSR test below or the `csr` escape hatch on the revenue test.
    const ctx = text.slice(Math.max(0, match.index - 60), re.lastIndex + 40).replace(PUBLISHER_BYLINE, ' ');
    if (!SPEND_CSR_CONTEXT.test(ctx)) continue;          // not a CSR figure
    if (SPEND_REVENUE_CONTEXT.test(ctx) && !/(csr|social responsibility|community investment)/i.test(ctx)) continue; // revenue-dominated
    if (matchers.length) {
      const sentence = sentenceAround(textLc, match.index, re.lastIndex);
      if (!matchers.some(r => r.test(sentence))) continue;  // figure belongs to some OTHER company on this page
    }
    const num = parseFloat(match[1].replace(/,/g, ''));
    if (Number.isNaN(num)) continue;
    if (num > SPEND_PLAUSIBILITY_CEILING_CR) {
      logger.warn('IMPLAUSIBLE CSR SPEND REJECTED — figure exceeds ceiling; almost certainly revenue/market-cap/bond leaking from the source page', {
        entityName: entityName ?? '(none)', figureCr: num, ceilingCr: SPEND_PLAUSIBILITY_CEILING_CR,
        context: ctx.replace(/\s+/g, ' ').trim().slice(0, 200),
      });
      continue;
    }
    const window = text
      .slice(Math.max(0, match.index - STRENGTH_WINDOW), re.lastIndex + STRENGTH_WINDOW)
      .replace(PUBLISHER_BYLINE, ' ');
    const after = text.slice(re.lastIndex, re.lastIndex + 30);
    const oneOff = isOneOffDonation(window);
    out.push({
      valueCr: num,
      kind: oneOff ? 'one_off' : 'annual',
      strength: contextStrength(window, after),
      context: window.replace(/\s+/g, ' ').trim().slice(0, 240),
    });
  }
  return out;
}

/** The company's annual CSR spend: the highest-context-strength `annual`
 *  candidate. Ties keep the earlier (first-match) figure, preserving the
 *  historical behaviour. One-off donations are excluded entirely — see
 *  `extractNotableDonations`. */
export function extractSpend(text: string, entityName?: string): number | null {
  const annual = extractSpendCandidates(text, entityName).filter(c => c.kind === 'annual');
  if (!annual.length) return null;
  let best = annual[0];
  for (const c of annual) if (c.strength > best.strength) best = c;
  return best.valueCr;
}

/** One-off relief/disaster donations, kept as their own list. Genuinely useful
 *  data — it just must not be confused with an annual budget. */
export function extractNotableDonations(
  text: string, entityName?: string,
): Array<{ amount_cr: number; context: string }> {
  const seen = new Set<number>();
  return extractSpendCandidates(text, entityName)
    .filter(c => c.kind === 'one_off')
    .filter(c => (seen.has(c.valueCr) ? false : (seen.add(c.valueCr), true)))
    .map(c => ({ amount_cr: c.valueCr, context: c.context }));
}

// ─── Summary — first 300 chars, no generation ────────────────────────────────

export function generateSummary(text: string): string {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

// ─── Deterministic completeness score, 0–100 ─────────────────────────────────

export function scoreCompany(data: {
  sectors: string[];
  geographies: string[];
  spend: number | null;
  hasDocument: boolean;
  hasContactInfo: boolean;
}): number {
  let score = 0;
  score += Math.min(data.sectors.length, 10) * 2;      // sectors: max 20
  score += Math.min(data.geographies.length, 10) * 2;  // geographies: max 20
  if (data.spend !== null) score += 25;                // spend known: 25
  if (data.hasDocument) score += 20;                   // hasDocument: 20
  if (data.hasContactInfo) score += 15;                // hasContactInfo: 15
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ─── Cross-source attribution & agreement confidence ────────────────────────

export type AgreementLevel = 'high' | 'medium' | 'low';

export interface CrossSourceAttribution {
  sectors: string[];                              // union across sources
  geographies: string[];                          // union across sources
  sectorSources: Record<string, string[]>;        // sector -> source labels that found it
  geographySources: Record<string, string[]>;     // geography -> source labels
  sectorConfidence: Record<string, AgreementLevel>; // 3+ sources => high, 2 => medium, 1 => low
}

function agreementLevel(count: number): AgreementLevel {
  if (count >= 3) return 'high';
  if (count === 2) return 'medium';
  return 'low';
}

/**
 * Extract sectors/geographies from each source independently, then take the
 * union and record which sources agreed on each value. The more sources that
 * mention a sector, the higher its agreement confidence.
 */
export function attributeAcrossSources(
  perSource: Array<{ label: string; text: string }>,
): CrossSourceAttribution {
  const sectorSources: Record<string, string[]> = {};
  const geographySources: Record<string, string[]> = {};

  for (const src of perSource) {
    if (!src.text) continue;
    for (const sector of extractSectors(src.text)) {
      (sectorSources[sector] ??= []).push(src.label);
    }
    for (const geo of extractGeographies(src.text)) {
      (geographySources[geo] ??= []).push(src.label);
    }
  }

  const sectorConfidence: Record<string, AgreementLevel> = {};
  for (const [sector, labels] of Object.entries(sectorSources)) {
    sectorConfidence[sector] = agreementLevel(new Set(labels).size);
  }

  return {
    sectors: Object.keys(sectorSources),
    geographies: Object.keys(geographySources),
    sectorSources,
    geographySources,
    sectorConfidence,
  };
}

// ─── Supporting cheap extractors (regex only) ────────────────────────────────

/**
 * First email in the text that is not junk AND — when the entity is known —
 * plausibly belongs to that entity. The corpus here is COMBINED source text, so
 * without the relevance gate a publisher's boilerplate (Moneycontrol's
 * grievanceofficer@nw18.com fraud disclaimer) wins for every company.
 */
export function extractEmail(text: string, entityName?: string, companyDomain?: string | null): string | null {
  if (!text) return null;
  const re = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (JUNK_EMAIL.test(m[0])) continue;
    if (entityName && !emailRelatesToCompany(m[0], entityName, companyDomain)) continue;
    return m[0].toLowerCase();
  }
  return null;
}

export function extractRegistrations(text: string): string[] {
  if (!text) return [];
  const checks: Array<[string, RegExp]> = [
    ['12A', /\b12-?AA?\b/i],
    ['80G', /\b80-?G\b/i],
    ['CSR-1', /\bCSR-?1\b/i],
    ['FCRA', /\bFCRA\b/i],
    ['Section 8', /\bsection\s*8\b/i],
  ];
  const found: string[] = [];
  for (const [label, re] of checks) {
    if (re.test(text)) found.push(label);
  }
  return found;
}

// ─── Executive contacts (CEO / MD / Chairman / CSR Head …) ───────────────────

export interface ExecutiveContact {
  name: string | null;
  title: string;
  email: string | null;
  source: string;
  confidence: ConfidenceLevelLite;
  /** When this contact was extracted (ISO, run time). */
  extracted_at?: string;
  /** The source page's own recency signal (e.g. Wikipedia "last edited" date),
   *  ISO date, when the page publishes one. null = page carries no date. */
  as_of?: string | null;
  /** Set on aggregator-tier contacts (Wikipedia/LinkedIn/…) whose name was NOT
   *  independently confirmed by the company's own site or a regulatory filing. */
  verification?: string;
}
export type ConfidenceLevelLite = 'high' | 'medium' | 'low';

// ─── Source-page recency ──────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
};

/**
 * Parse a page's own "how current am I" marker from its text. Recognised forms:
 * Wikipedia's footer "This page was last edited on 1 March 2026", and generic
 * "last updated on 12 Jan 2026" / "updated: 2026-03-01" lines. Returns an ISO
 * date (YYYY-MM-DD) or null when the page publishes no recency signal — callers
 * must treat null as "age unknown", never as "current".
 */
export function extractSourceDate(text: string): string | null {
  if (!text) return null;
  const iso = (y: number, mo: number, d: number): string | null => {
    if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  // "last edited on 1 March 2026" / "last updated on 12 Jan 2026"
  let m = text.match(/last\s+(?:edited|updated|modified|reviewed)(?:\s+on)?[:\s]+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/i);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()] ?? Object.entries(MONTHS).find(([k]) => k.startsWith(m![2].toLowerCase().slice(0, 3)))?.[1];
    if (mo) return iso(Number(m[3]), mo, Number(m[1]));
  }
  // "last updated: March 1, 2026"
  m = text.match(/last\s+(?:edited|updated|modified|reviewed)(?:\s+on)?[:\s]+([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()] ?? Object.entries(MONTHS).find(([k]) => k.startsWith(m![1].toLowerCase().slice(0, 3)))?.[1];
    if (mo) return iso(Number(m[3]), mo, Number(m[2]));
  }
  // "updated: 2026-03-01"
  m = text.match(/last\s+(?:edited|updated|modified|reviewed)(?:\s+on)?[:\s]+(\d{4})-(\d{2})-(\d{2})/i);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}

// Canonical titles and the phrases that signal them. Order matters: the first
// matching pattern wins, so more specific titles come before generic ones.
const TITLE_PATTERNS: Array<{ title: string; re: RegExp }> = [
  { title: 'CSR Head', re: /\b(?:csr head|head of csr|head\s*[-–]\s*csr|chief csr officer|csr committee chair(?:man|person)?)\b/i },
  { title: 'Head of Foundation', re: /\b(?:head of (?:the )?foundation|foundation head)\b/i },
  { title: 'Corporate Affairs', re: /\b(?:head of )?corporate affairs\b/i },
  // Company Secretary / Compliance Officer — SEBI listing rules force companies
  // to publish these with an email, so they are the most findable contacts.
  { title: 'Company Secretary', re: /\bcompany secretary\b/i },
  { title: 'Compliance Officer', re: /\bcompliance officer\b/i },
  { title: 'CEO', re: /\b(?:chief executive officer|ceo)\b/i },
  // PSU convention: one person holds "Chairman & Managing Director" (CMD) —
  // must match BEFORE the bare Managing Director pattern, or the name window
  // swallows "Chairman" ("K. Sadashiv Murthy Chairman & Managing Director").
  { title: 'Chairman & Managing Director', re: /\bchairman\s*(?:&|and)\s*managing\s+director\b/i },
  { title: 'Chairman & Managing Director', re: /\bCMD\b/ }, // case-sensitive like MD
  { title: 'Managing Director', re: /\bmanaging\s+director\b/i },
  { title: 'Managing Director', re: /\bMD\b/ }, // case-sensitive: "MD", not "md"/"Md"
  { title: 'Chairman', re: /\b(?:chairman|chairperson|chairwoman)\b/i },
];

// Person-name shape: optional initials + 1–4 capitalised words ("N. Chandrasekaran",
// "Kushagra Srivastava"). Deliberately strict to avoid sentence fragments.
const NAME_RE_SRC = String.raw`((?:[A-Z]\.\s?)*[A-Z][a-z][A-Za-z'’.-]*(?:\s+(?:[A-Z]\.\s?)*[A-Z][a-z][A-Za-z'’.-]*){0,3})`;
const HONORIFIC_SRC = String.raw`(?:Mr\.?|Ms\.?|Mrs\.?|Dr\.?|Shri|Smt\.?)\s+`;

// Words that mean a "name" capture is actually organisation/report/region
// boilerplate ("Central Europe", "Tenure F. C. Kohli" from Wikipedia infoboxes).
const NAME_STOPWORDS = /\b(?:limited|ltd|india|company|corporate|social|responsibility|foundation|officer|director|directors|committee|board|report|annual|policy|bank|group|private|the|tenure|central|europe|asia|africa|america|global|digital|services|solutions|technologies|region|international|speaks|says|announces|launches|welcomes|presents|celebrates|discusses|unveils|highlights|joins|visits|view|profile|profiles|message|read|more|know|non|executive|independent|whole|designate|chairman|chairperson|chairwoman|president|founder|contact|incorporated|corporation|disclosure|investors?|operations|mauritius|finance|logistics|insurance|capital|motors|holidays|resorts|energy|power|steel|cement|pharma|chemicals|aviation|airlines|telecom|retail|realty|infrastructure|ventures|enterprises|industries|hotels|tractors|agri)\b/i;

const HONORIFIC_WORD = /^(?:mr|mrs|ms|dr|shri|smt)\.?$/i;

function isPlausibleName(name: string): boolean {
  const words = name.trim().split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  // A LEADING honorific is fine (stripped before storing); one appearing
  // mid-capture means the regex crossed an entity boundary and glued an
  // organisation to a person ("Mahindra Logistics Mr. Lakshmanan").
  if (words.slice(1).some(w => HONORIFIC_WORD.test(w))) return false;
  // Every word must be capitalised — combined regexes run with the 'i' flag when
  // the title pattern needs it, so the name shape must be re-checked here.
  if (!words.every(w => /^[A-Z]/.test(w))) return false;
  // Rendered pages glue adjacent DOM nodes together ("Head OfficePlot No.") —
  // a mid-word capital is a text-extraction seam, not a name (Mc/Mac excepted).
  if (words.some(w => /[a-z][A-Z]/.test(w) && !/^Ma?c[A-Z]/.test(w))) return false;
  if (NAME_STOPWORDS.test(name)) return false;
  return true;
}

/** Leading honorifics are formatting, not identity — store the bare name. */
function stripLeadingHonorifics(name: string): string {
  return name.replace(/^(?:(?:Mr|Mrs|Ms|Dr|Shri|Smt)\.?\s+)+/i, '').trim();
}

// Board pages repeat the designation right after the person ("Shri K. Sadashiv
// Murthy Chairman & Managing Director") — the greedy name regex swallows those
// trailing title words. Trim them off before judging plausibility.
const TRAILING_TITLE_WORD = /^(?:chairman|chairperson|chairwoman|managing|director|ceo|cmd|md|president|executive|officer|secretary)$/i;
function trimTrailingTitleWords(name: string): string {
  const words = name.trim().split(/\s+/);
  while (words.length > 1 && TRAILING_TITLE_WORD.test(words[words.length - 1])) words.pop();
  return words.join(' ');
}

// Generic purpose-mailbox prefixes → standalone contacts with no person name.
// Ordered by how official/reliable the channel is; the same order drives
// pickOfficialContact(). Company Secretary/compliance mailboxes are a SEBI
// disclosure requirement, so they get medium confidence rather than low.
const GENERIC_MAILBOXES: Array<{ re: RegExp; title: string; confidence: ConfidenceLevelLite }> = [
  { re: /^(?:cosec|co[._-]?sec|company[._-]?secretary|companysecretary|secretarial|compliance)(?:[._-]|$)/i, title: 'Company Secretary (official contact)', confidence: 'medium' },
  { re: /^(?:investor[._-]?relations|investorrelations|investors?|ir)$/i, title: 'Investor Relations', confidence: 'medium' },
  { re: /^csr(?:[._-]|$)/i, title: 'CSR Contact', confidence: 'low' },
  { re: /^foundation(?:[._-]|$)/i, title: 'Foundation Contact', confidence: 'low' },
  { re: /^(?:info|contact|enquiry|enquiries|corporate[._-]?communications?)(?:[._-]|$)/i, title: 'General Contact', confidence: 'low' },
];

// Addresses that can never be the target company's own contact:
//  - placeholders/SDK addresses in page markup (form hints, schema examples);
//  - the aggregator portals we scrape (an @nasscom.in email on a NASSCOM search
//    page is a NASSCOM staffer, not the company being researched).
const JUNK_EMAIL = /@(?:example\.|test\.|domain\.|company\.com$|email\.com$|yourdomain\.|sentry\.|schema\.org|nasscom\.in$|linkedin\.com$|yourstory\.com$|inc42\.com$|moneycontrol\.com$|indiacsr\.in$|indiacsrnetwork\.com$|wikipedia\.org$|wikimedia\.org$|screener\.in$|crunchbase\.com$|startupindia\.gov\.in$|bseindia\.com$|nseindia\.com$|zaubacorp\.com$|nw18\.com$|network18online\.com$|news18\.com$|firstpost\.com$|cnbctv18\.com$)/i;

/**
 * Does an extracted email plausibly belong to the company being researched
 * (rather than to the SOURCE website hosting the text)? True when:
 *  - its registrable domain matches the company's known official domain, or
 *  - the domain contains a distinctive token of the company name or its acronym
 *    (bhel.co.in ⊃ "bhel", tcs.com ⊃ "tcs", bajajauto.com ⊃ "bajaj").
 * grievanceofficer@nw18.com on a Moneycontrol page fails both for every company.
 * Deliberately strict: a rejected real email shows as "No public email found",
 * which the data-integrity standard prefers over a wrong one.
 */
export function emailRelatesToCompany(email: string, entityName: string, companyDomain?: string | null): boolean {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (!domain) return false;
  if (companyDomain) {
    const official = companyDomain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    if (domain === official || domain.endsWith(`.${official}`) || official.endsWith(`.${domain}`)) return true;
  }
  const domainBody = domain.split('.').slice(0, -1).join('.'); // drop TLD
  return entityNameTokens(entityName).some(t => domainBody.includes(t));
}

// Aggregator/search pages mix MANY companies on one page (LinkedIn "people also
// viewed", IndiaCSR search results, NASSCOM listings) — a title+name found there
// is only trustworthy when the researched company is mentioned NEARBY.
const AGGREGATOR_SOURCES = new Set([
  'indiacsr', 'nasscom', 'linkedin', 'moneycontrol', 'yourstory', 'inc42',
  'crunchbase', 'startupindia', 'scholar',
]);
const ENTITY_TOKEN_STOPWORDS = new Set([
  'limited', 'ltd', 'private', 'pvt', 'india', 'company', 'group',
  'services', 'technologies', 'systems', 'solutions', 'corporation', 'bank',
]);

// Prose that marks a FORMER officeholder. Wikipedia leadership sections narrate
// resignations and succession ("MD & CEO Sumant Kathpalia resigned in April
// 2025…"), which must NOT be captured as current leadership. Checked in a
// same-sentence window around each title match.
const FORMER_EXEC_RE = /\b(?:resign(?:ed|ation|s)?|stepp?ed[\s-]?down|step down|former(?:ly)?|ex-|erstwhile|retir(?:ed|ing|es|ement)|outgoing|succeeded by|replaced by|preceded by|predecessor|until\s+20\d\d|till\s+20\d\d|from\s+20\d\d\s+to\s+20\d\d)\b/i;
// A qualified/subordinate/former variant sitting right before the title — a
// Deputy / Joint / Acting / Vice / Ex- CEO is not THE current chief executive and
// must not be recorded as one ("Deputy CEO Arun Khurana", "Ex-CEO Kathpalia").
const SUBORDINATE_PREFIX_RE = /\b(?:deputy|dy|joint|jt|assistant|asst|acting|interim|vice|former|ex)[-.]?\s*$/i;
// When an org name sits immediately BEFORE a title on an aggregator page ("BMW
// Group India CEO Hardeep S. Brar"), the person heads THAT org. Skip the check
// when the phrase merely leads with a connector/role word rather than an org.
const ORG_BEFORE_LEAD_IGNORE = /^(?:the|and|by|for|its|our|new|group|global|regional|country|national|chief|deputy|joint|acting|interim|vice|senior|executive|managing|non|a|an)\b/i;

/**
 * Extract executive/leadership contacts from free text: names near title words
 * (CEO, Managing Director, Chairman, CSR Head, Head of Foundation, Corporate
 * Affairs), Wikipedia-infobox "Key people" lines, and email addresses —
 * firstname.lastname@domain is matched back to an extracted name (high
 * confidence); generic csr@/foundation@/investor.relations@ mailboxes become
 * standalone low-confidence contacts.
 *
 * `entityName` (optional): on aggregator pages (see AGGREGATOR_SOURCES) a name
 * is kept only if the company itself is mentioned within ±300 chars — this
 * drops other companies' executives that share the page.
 */
export function extractExecutiveContacts(text: string, source = 'text', entityName?: string, companyDomain?: string | null): ExecutiveContact[] {
  if (!text) return [];
  // LinkedIn is banned as a CONTACT source entirely (2026-07-13): public company
  // pages mix employees, "people also viewed" and event attendees with no way to
  // confirm a profile actually holds the claimed title — it produced flatly wrong
  // CEOs (BHEL: "Kiran Joseph"). LinkedIn text still feeds sector/geo extraction.
  if (source === 'linkedin') return [];
  const contacts: ExecutiveContact[] = [];
  const seen = new Set<string>();
  // Provenance stamped on every contact: when WE extracted it, and how current
  // the page itself claims to be (Wikipedia "last edited" etc.; null = unknown).
  const extractedAt = new Date().toISOString();
  const asOf = extractSourceDate(text);
  const push = (c: ExecutiveContact) => {
    if (c.name) {
      const bare = stripLeadingHonorifics(c.name);
      if (!bare) return;
      c = { ...c, name: bare };
    }
    const key = `${(c.name ?? '').toLowerCase()}|${c.title}`;
    if (seen.has(key) || contacts.length >= 10) return;
    seen.add(key);
    contacts.push({ ...c, extracted_at: extractedAt, as_of: asOf });
  };

  // Gates for aggregator pages (two layers, both needed):
  //  1. proximity — distinctive tokens of the company name (plus its acronym,
  //     e.g. TCS) must appear near the match;
  //  2. attribution — if the nearest preceding "from/at/of <Org>" phrase names a
  //     DIFFERENT organisation, the person belongs to that org, not ours
  //     ("Key attendees from M&S included Stuart Machin, CEO … and from Tata
  //     Consultancy Services, K Krithivasan, CEO" on TCS's own LinkedIn page).
  const textLc = text.toLowerCase();
  let nearEntity: (idx: number) => boolean = () => true;
  let attributionOk: (idx: number) => boolean = () => true;
  let orgMatchesEntity: ((s: string) => boolean) | null = null;
  if (entityName && AGGREGATOR_SOURCES.has(source)) {
    const words = entityName.split(/\s+/).filter(Boolean);
    // ≥3 chars: a short distinctive name/acronym ("ITC") must still gate. With a
    // ≥4 filter, "ITC Limited" produced NO tokens ("ITC" excluded, "Limited"
    // a stopword) → the whole aggregator gate silently disabled, flooding the
    // company with other firms' execs from the ?s= search page.
    const tokens = words.map(w => w.toLowerCase()).filter(w => w.length >= 3 && !ENTITY_TOKEN_STOPWORDS.has(w));
    // Acronym gate, but only for 3+ letter acronyms. A 2-letter acronym
    // (IndusInd Bank → "ib") substring-matches almost any page and defeats the
    // proximity gate, cross-attributing other companies' executives.
    const acronym = words.map(w => w[0]).join('').toLowerCase();
    if (words.length >= 2 && acronym.length >= 3) tokens.push(acronym);
    const matchesEntity = (s: string) => { const t = s.toLowerCase(); return tokens.some(tok => t.includes(tok)); };
    if (tokens.length) {
      orgMatchesEntity = matchesEntity;
      nearEntity = (idx: number) => matchesEntity(textLc.slice(Math.max(0, idx - 300), idx + 300));
      attributionOk = (idx: number) => {
        const before = text.slice(Math.max(0, idx - 260), idx);
        const attrRe = /\b(?:from|at|of)\s+((?:[A-Z][A-Za-z&.'’-]*|&)(?:\s+(?:[A-Z][A-Za-z&.'’-]*|&)){0,4})/g;
        let m: RegExpExecArray | null;
        let lastOrg: string | null = null;
        while ((m = attrRe.exec(before)) !== null) lastOrg = m[1];
        return lastOrg === null || matchesEntity(lastOrg);
      };
    }
  }

  // Two-step matching: locate the title (case-insensitive where the pattern
  // needs it), then look for a person name in a window before/after with a
  // CASE-SENSITIVE name regex — a combined 'i' regex would let the greedy name
  // matcher swallow lowercase words ("Anil Sharma addressed…").
  const nameBefore = new RegExp(NAME_RE_SRC + String.raw`\s*[,(–—-]\s*(?:the\s+)?$`);
  const nameAfter = new RegExp(String.raw`^\s*[:,–—-]?\s*(?:${HONORIFIC_SRC})?` + NAME_RE_SRC);
  // Board-page photo grids render "Name Title" with NO punctuation between them
  // ("K. Sadashiv Murthy Chairman & Managing Director") — accept a bare
  // whitespace boundary, but only on the company's own pages (tier 1), where a
  // name directly abutting a title is the layout convention, not a coincidence.
  const nameBeforePlain = new RegExp(NAME_RE_SRC + String.raw`\s+$`);
  const allowPlainBoundary = contactSourceTier(source) === 1;
  // Shared capture pipeline: trim trailing designation words, then plausibility.
  const nameOf = (m: RegExpMatchArray | null): string | null => {
    if (!m) return null;
    const cand = trimTrailingTitleWords(m[1]);
    return isPlausibleName(cand) ? cand : null;
  };
  for (const { title, re } of TITLE_PATTERNS) {
    const tre = new RegExp(re.source, re.flags.includes('i') ? 'gi' : 'g');
    let m: RegExpExecArray | null;
    while ((m = tre.exec(text)) !== null) {
      // Aggregator gates: page area must concern the entity, and the nearest
      // "from/at/of <Org>" attribution must not name a different organisation.
      if (!nearEntity(m.index) || !attributionOk(m.index)) continue;
      const before = text.slice(Math.max(0, m.index - 60), m.index);
      const after = text.slice(tre.lastIndex, tre.lastIndex + 90);
      // FORMER-officeholder / subordinate-role guard (all sources — Wikipedia
      // prose is the main offender). "…CEO, Sumant Kathpalia, resigned in April
      // 2025…" and "Deputy CEO Arun Khurana … stepped down" are succession
      // history, not current leadership. The look-ahead stays inside the same
      // sentence so an unrelated later "resigned" can't drop a current exec.
      const sameSentenceAfter = after.split(/(?<=[.;])\s/)[0];
      if (FORMER_EXEC_RE.test(before) || FORMER_EXEC_RE.test(sameSentenceAfter) || SUBORDINATE_PREFIX_RE.test(before)) continue;
      // Trailing attribution on aggregator pages: "Vikas Garg, Chairman, Ebix
      // Group" — the org right after the title owns the person. Title words
      // after the comma ("…, Chairman, CEO and MD") are a continuation, not an org.
      if (orgMatchesEntity) {
        const orgAfter = after.match(/^\s*,\s*((?:[A-Z][A-Za-z&.'’-]*|&)(?:\s+(?:[A-Z][A-Za-z&.'’-]*|&)){0,4})/);
        const isTitleWord = orgAfter && /\b(?:CEO|MD|Chairman|Chairperson|Director|Officer|Secretary|President|Head|Founder)\b/i.test(orgAfter[1]);
        if (orgAfter && !isTitleWord && !orgMatchesEntity(orgAfter[1])) continue;
        // Org name immediately BEFORE the title ("BMW Group India CEO Hardeep S.
        // Brar") means the person heads THAT org — reject when it isn't ours.
        const orgBefore = before.match(/((?:[A-Z][A-Za-z&.'’-]+\s+){0,3}[A-Z][A-Za-z&.'’-]+)\s+$/);
        if (orgBefore && !ORG_BEFORE_LEAD_IGNORE.test(orgBefore[1]) && !orgMatchesEntity(orgBefore[1])) continue;
      }
      const nb = nameOf(before.match(nameBefore));   // "Kushagra Srivastava, CEO"
      if (nb) push({ name: nb, title, email: null, source, confidence: 'medium' });
      const na = nameOf(after.match(nameAfter));     // "CEO: Mr. Anil Kumar Sharma"
      if (na) push({ name: na, title, email: null, source, confidence: 'medium' });
      if (allowPlainBoundary && !nb) {
        const nbp = nameOf(before.match(nameBeforePlain)); // "K. Sadashiv Murthy Chairman & Managing Director"
        if (nbp) push({ name: nbp, title, email: null, source, confidence: 'medium' });
      }
    }
  }

  // Wikipedia infobox: "Key people N. Chandrasekaran (Chairman) K Krithivasan (CEO & MD)".
  // The separator is optional — rendered infoboxes glue it ("Key peopleRavinder Takkar…").
  const kp = text.match(/key people\s*:?\s*([^]{0,240})/i);
  if (kp && nearEntity(kp.index ?? 0)) {
    const pairRe = new RegExp(NAME_RE_SRC + String.raw`\s*\(([^)]{2,60})\)`, 'g');
    let m: RegExpExecArray | null;
    while ((m = pairRe.exec(kp[1])) !== null) {
      if (!isPlausibleName(m[1])) continue;
      const rawTitle = m[2];
      const canon = TITLE_PATTERNS.find(t => t.re.test(rawTitle));
      push({ name: m[1].trim(), title: canon ? canon.title : rawTitle.trim(), email: null, source, confidence: 'medium' });
    }
  }

  // Emails: attach firstname.lastname@ to a matching extracted name (→ high
  // confidence); collect generic purpose mailboxes as standalone contacts.
  const emailRe = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  let em: RegExpExecArray | null;
  // On non-official pages an email must plausibly belong to the researched
  // company — a source site's own mailbox (publisher grievance/contact
  // addresses) can never become the company's contact.
  const requireRelevance = entityName && contactSourceTier(source) >= 2;
  while ((em = emailRe.exec(text)) !== null) {
    const email = em[0].toLowerCase();
    if (JUNK_EMAIL.test(email)) continue; // form placeholders, SDK addresses
    if (requireRelevance && !emailRelatesToCompany(email, entityName!, companyDomain)) continue;
    const local = email.split('@')[0];
    const dotted = local.match(/^([a-z]+)[._]([a-z]+)$/);
    if (dotted) {
      const owner = contacts.find(c => c.name &&
        c.name.toLowerCase().includes(dotted[1]) && c.name.toLowerCase().includes(dotted[2]));
      if (owner && !owner.email) { owner.email = email; owner.confidence = 'high'; continue; }
    }
    // An email within ~120 chars after a titled name mention likely belongs to
    // that person ("Company Secretary: A. Sharma, e-mail: cs@acme.com" layouts).
    const nearOwner = contacts.find(c => c.name && !c.email &&
      text.slice(Math.max(0, em!.index - 120), em!.index).includes(c.name));
    if (nearOwner) { nearOwner.email = email; nearOwner.confidence = 'high'; continue; }
    const generic = GENERIC_MAILBOXES.find(g => g.re.test(local));
    if (generic && !contacts.some(c => c.email === email)) {
      push({ name: null, title: generic.title, email, source, confidence: generic.confidence });
    }
  }

  // Wikipedia: the "Key people" infobox is the authoritative CURRENT-leadership
  // list. When it is present, drop body/navbox leadership captures whose name
  // isn't in it — Wikipedia articles embed succession prose ("… resigned …") and
  // PARENT-company director navboxes (the Vodafone Idea page lists Vodafone Group
  // plc's Colao/Kleisterlee) that otherwise leak former or other-company execs.
  // The Key-people names themselves are already in `contacts`, so the current
  // officeholder is never lost; email-bearing entries are always kept.
  if (source === 'wikipedia') {
    const keyNames = new Set<string>();
    const kpm = text.match(/key people\s*:?\s*([^]{0,240})/i);
    if (kpm) {
      const pr = new RegExp(NAME_RE_SRC + String.raw`\s*\(([^)]{2,60})\)`, 'g');
      let mm: RegExpExecArray | null;
      while ((mm = pr.exec(kpm[1])) !== null) if (isPlausibleName(mm[1])) keyNames.add(mm[1].trim().toLowerCase());
    }
    if (keyNames.size) {
      return contacts.filter(c => !!c.email || (!!c.name && keyNames.has(c.name.toLowerCase())));
    }
  }

  return contacts;
}

// ─── Official contact channel fallback ───────────────────────────────────────

// Exec personal emails are rarely public; official channels (Company Secretary
// per SEBI disclosure rules, IR, CSR mailboxes) usually are. This priority
// picks the best email-bearing contact to use as a company's primary contact.
const OFFICIAL_TITLE_PRIORITY = [
  'Company Secretary', 'Compliance Officer', 'Investor Relations',
  'CSR Head', 'CSR Contact', 'Head of Foundation', 'Foundation Contact', 'General Contact',
];

/**
 * Best contact to use as the company's primary email: a NAMED person with an
 * email first (highest-value find), then official channels by priority, then
 * any email-bearing entry. Inferred pattern-guesses are never returned.
 */
export function pickOfficialContact(contacts: ExecutiveContact[] | null | undefined): ExecutiveContact | null {
  const withEmail = (contacts ?? []).filter(c => c && c.email && c.source !== 'pattern-guess');
  if (!withEmail.length) return null;
  const named = withEmail.find(c => c.name);
  if (named) return named;
  for (const title of OFFICIAL_TITLE_PRIORITY) {
    const hit = withEmail.find(c => c.title.startsWith(title));
    if (hit) return hit;
  }
  return withEmail[0];
}

// NOTE: there is deliberately NO email-guessing here. An earlier
// guessOfficialMailboxes() synthesised cosec@/investors@/csr@<domain> addresses;
// those were never observed in any source and were removed as fabrication.
// Every email in an ExecutiveContact is a literal string matched in scraped text.

// ─── Contact source trust tiers ───────────────────────────────────────────────
// 1 = the company's own domain (official-site pages, curated seed pages) —
//     most trustworthy for CURRENT leadership;
// 2 = regulatory filing feeds (BSE/NSE announcements, Zauba = MCA mirror) —
//     verified and dated;
// 3 = everything else (Wikipedia, LinkedIn, news/startup aggregators) — names
//     here are kept only when they don't contradict a better source, and are
//     labelled unverified unless a tier-1/2 source confirms them.
const OFFICIAL_SITE_SOURCES = new Set(['official-site', 'contact-page', 'ir-page', 'investors-page', 'known', 'manual']);
const REGULATORY_SOURCES = new Set(['bse-announcements', 'nse-announcements', 'zauba-directors']);

export function contactSourceTier(source: string): 1 | 2 | 3 {
  if (OFFICIAL_SITE_SOURCES.has(source)) return 1;
  if (REGULATORY_SOURCES.has(source)) return 2;
  return 3;
}

export const UNVERIFIED_CONTACT_NOTE = "Unverified — not confirmed on company's own site";

/** Same person despite formatting drift: every word of the shorter name appears
 *  in the longer one ("Srini Pallia" ↔ "Srini Pallia CEO Message", initials kept
 *  as-is). Prevents a noisy capture from "contradicting" the clean form. */
function namesConsistent(a: string, b: string): boolean {
  const wa = a.toLowerCase().split(/\s+/).filter(Boolean);
  const wb = b.toLowerCase().split(/\s+/).filter(Boolean);
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  return short.every(w => long.includes(w));
}

// Deterministic ordering when joining a person's multiple titles.
const TITLE_JOIN_ORDER = [
  'Chairman & Managing Director', 'Chairman', 'Managing Director & CEO',
  'Managing Director', 'CEO', 'Company Secretary', 'Compliance Officer',
  'Investor Relations', 'CSR Head',
];
function combineTitles(titles: string[]): string {
  let uniq = [...new Set(titles.map(t => t.trim()))];
  // Drop any title fully contained in a longer one — "Managing Director" ⊂
  // "Chairman & Managing Director", "CEO" ⊂ "Managing Director & CEO" — so an
  // exec listed under both a full and a partial title yields ONE clean title,
  // never "Chairman & Managing Director & Managing Director".
  uniq = uniq.filter(t => !uniq.some(o => o !== t && o.toLowerCase().includes(t.toLowerCase())));
  if (uniq.length === 1) return uniq[0];
  const low = new Set(uniq.map(t => t.toLowerCase()));
  // The common Indian combined exec role — render it canonically.
  if (uniq.length === 2 && low.has('ceo') && low.has('managing director')) return 'Managing Director & CEO';
  const rank = (t: string) => { const i = TITLE_JOIN_ORDER.indexOf(t); return i < 0 ? 99 : i; };
  return uniq.sort((a, b) => rank(a) - rank(b)).join(' & ');
}

/** One human = one contact. Multiple title captures of the SAME person (a bank's
 *  "Managing Director & CEO" parsed once as MD by the body scan and once as CEO
 *  by the infobox) collapse into a single entry with a combined title. Name-less
 *  (email-only) contacts pass through untouched. Order of first appearance kept. */
function collapseByName(contacts: ExecutiveContact[]): ExecutiveContact[] {
  const norm = (n: string) => n.toLowerCase().replace(/\s+/g, ' ').trim();
  const seen = new Set<string>();
  const out: ExecutiveContact[] = [];
  for (const c of contacts) {
    if (!c.name) { out.push(c); continue; }
    const k = norm(c.name);
    if (seen.has(k)) continue;
    seen.add(k);
    const group = contacts.filter(x => x.name && norm(x.name) === k);
    if (group.length === 1) { out.push(group[0]); continue; }
    // Prefer an email-bearing / most-trusted entry as the base, combine titles.
    const base = group.slice().sort((a, b) =>
      (b.email ? 1 : 0) - (a.email ? 1 : 0) || contactSourceTier(a.source) - contactSourceTier(b.source))[0];
    out.push({ ...base, title: combineTitles(group.map(x => x.title)) });
  }
  return out;
}

/**
 * Pool per-source contact lists with source-trust priority:
 *  - official site → regulatory filings → aggregators (list is ordered that way);
 *  - an aggregator name that CONTRADICTS a tier-1/2 name for the same title is
 *    dropped (this is where wrong Wikipedia/LinkedIn names die);
 *  - an aggregator name with no tier-1/2 confirmation survives but carries
 *    UNVERIFIED_CONTACT_NOTE;
 *  - dedupe by name+title, preferring entries that carry an email.
 */
export function mergeExecutiveContacts(lists: ExecutiveContact[][]): ExecutiveContact[] {
  const sorted = lists.flat().filter(Boolean)
    .sort((a, b) => contactSourceTier(a.source) - contactSourceTier(b.source));

  const officialNameByTitle = new Map<string, string>();
  const trustedNames: string[] = [];
  for (const c of sorted) {
    if (c.name && contactSourceTier(c.source) <= 2) {
      trustedNames.push(c.name);
      if (!officialNameByTitle.has(c.title.toLowerCase())) {
        officialNameByTitle.set(c.title.toLowerCase(), c.name);
      }
    }
  }

  const byKey = new Map<string, ExecutiveContact>();
  for (let c of sorted) {
    if (c.name && contactSourceTier(c.source) === 3) {
      const official = officialNameByTitle.get(c.title.toLowerCase());
      if (official && !namesConsistent(official, c.name)) continue; // contradicted — drop
      if (!trustedNames.some(n => namesConsistent(n, c.name!))) c = { ...c, verification: UNVERIFIED_CONTACT_NOTE };
    }
    const key = `${(c.name ?? c.email ?? '').toLowerCase()}|${c.title.toLowerCase()}`;
    const prev = byKey.get(key);
    if (!prev || (!prev.email && c.email)) byKey.set(key, c);
  }
  return collapseByName([...byKey.values()]).slice(0, 10);
}

// ─── Manual contact overrides ─────────────────────────────────────────────────

/** A user correction to one extracted contact. `replace: null` removes it.
 *  Stored in entities.data.key_contact_overrides; re-applied after every
 *  enrichment run so automation can never overwrite a human fix. */
export interface ContactOverride {
  /** The (name|title) the automated pipeline produced, lowercased for matching. */
  match: { name: string | null; title: string };
  /** Corrected values, or null to remove the contact entirely. */
  replace: { name: string | null; title: string; email: string | null } | null;
  corrected_at: string;
}

/**
 * Apply manual corrections on top of freshly extracted contacts. Matching is by
 * (name|title), case-insensitive. A replacement that no longer matches anything
 * is appended anyway — the human-verified contact must survive even when the
 * automated extraction stops finding the wrong original.
 */
export function applyContactOverrides(contacts: ExecutiveContact[], overrides: ContactOverride[] | null | undefined): ExecutiveContact[] {
  if (!overrides?.length) return contacts;
  const key = (name: string | null | undefined, title: string) =>
    `${(name ?? '').toLowerCase()}|${title.toLowerCase()}`;
  let out = [...contacts];
  for (const o of overrides) {
    if (!o?.match?.title) continue;
    const mk = key(o.match.name, o.match.title);
    out = out.filter(c => key(c.name, c.title) !== mk);
    if (o.replace) {
      const manual: ExecutiveContact = {
        name: o.replace.name, title: o.replace.title, email: o.replace.email,
        source: 'manual', confidence: 'high', extracted_at: o.corrected_at, as_of: o.corrected_at.slice(0, 10),
      };
      // Dedupe in case the same correction was saved twice.
      if (!out.some(c => key(c.name, c.title) === key(manual.name, manual.title))) out.unshift(manual);
    }
  }
  return out.slice(0, 10);
}

// ─── Domain focus (the platform's 9 problem domains) ─────────────────────────

/**
 * Detect which of the platform's focus domains (solid_waste, plastic, wastewater,
 * air_pollution, e_waste, green_hydrogen, circular_economy, ai_medtech,
 * water_body) a text talks about — ranked by keyword-hit count, most-evidenced
 * first. Applies to companies AND innovators.
 */
export function detectDomainFocus(text: string): InnovatorDomain[] {
  if (!text) return [];
  const t = text.toLowerCase();
  const scored: Array<{ domain: InnovatorDomain; hits: number }> = [];
  for (const [domain, kws] of Object.entries(DOMAIN_KEYWORDS)) {
    let hits = 0;
    for (const kw of kws) {
      let i = t.indexOf(kw);
      while (i !== -1) { hits++; i = t.indexOf(kw, i + kw.length); }
    }
    if (hits > 0) scored.push({ domain: domain as InnovatorDomain, hits });
  }
  scored.sort((a, b) => b.hits - a.hits);
  return scored.map(s => s.domain);
}

/** UI label for a domain key ("solid_waste" → "Solid Waste"). */
export function domainFocusLabel(domain: string): string {
  return (DOMAIN_LABELS as Record<string, string>)[domain] ?? domain;
}

// ─── MoU history ──────────────────────────────────────────────────────────────

export interface MoUMention { partner: string; year?: string; description?: string }

/**
 * Extract MoU mentions: "signed an MoU with X (in 2021)", "memorandum of
 * understanding with X". Partner names are capitalised phrases; the surrounding
 * sentence fragment is kept as the description.
 */
export function extractMoUHistory(text: string): MoUMention[] {
  if (!text) return [];
  const out: MoUMention[] = [];
  const seen = new Set<string>();
  // Case-sensitive on purpose: "MoU"/"MOU" acronym forms, spelt-out phrase in
  // either capitalisation. Partner = run of Capitalised words (with of/and/&/for
  // connectors), so it stops naturally before lowercase prose like "in 2020 for…".
  const re = /\b(?:MoU|MOU|[Mm]emorandum of [Uu]nderstanding)\b[^.\n]{0,120}?\bwith\s+(?:the\s+)?([A-Z][\w&.'’-]*(?:\s+(?:(?:of|and|&|for)\s+)?[A-Z][\w&.'’-]*){0,5})(?:\s+in\s+((?:19|20)\d{2}))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && out.length < 5) {
    const partner = m[1].replace(/\s+/g, ' ').trim().replace(/[,.]$/, '');
    if (partner.length < 3 || seen.has(partner.toLowerCase())) continue;
    seen.add(partner.toLowerCase());
    const start = Math.max(0, m.index - 60);
    const description = text.slice(start, Math.min(text.length, m.index + m[0].length + 40)).replace(/\s+/g, ' ').trim();
    out.push({ partner, ...(m[2] ? { year: m[2] } : {}), description });
  }
  return out;
}

// ─── Ownership / technology transfer openness ─────────────────────────────────

// true = explicit transfer/licensing language found; null = no signal (never
// asserts a false — absence of language is not evidence the company refuses).
export function detectOwnershipTransfer(text: string): boolean | null {
  if (!text) return null;
  const positive = /\b(?:technology transfer|transfer of technology|tech transfer|technology licensing|licens\w*\s+(?:its|our|the)\s+technolog\w*|open to licens\w*)\b/i;
  return positive.test(text) ? true : null;
}

// true / false / null (unknown) — based on explicit proposal-acceptance language.
export function detectAcceptsProposals(text: string): boolean | null {
  if (!text) return null;
  const negative = /(do not|don't|not)\s+(accept|invite|entertain)\s+(unsolicited\s+)?(proposals|applications)/i;
  if (negative.test(text)) return false;
  const positive = /(invite|inviting|accepting|submit|call for|apply for|welcome)[\w\s]{0,30}?(proposals|grant applications|applications)|grant application|partner with us|ngo partnership/i;
  if (positive.test(text)) return true;
  return null;
}
