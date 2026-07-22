// Deterministic, LLM-free feasibility signal detection for innovators.
// Pure functions over a text corpus (the combined source text gathered during
// deep research). Every signal is BEST-EFFORT and low-confidence: keyword
// matches, not verified facts. Callers surface them as such and let users
// override (locked via data.feasibility_overrides).

import type { SubsidyLandElectricity } from '../types/index.js';

// ─── Indigenous technology ──────────────────────────────────────────────────

const INDIGENOUS_POSITIVE = [
  'made in india', 'make in india', 'indigenously developed', 'indigenous technology',
  'indigenously designed', 'domestic technology', 'domestically developed',
  'atmanirbhar', 'swadeshi', 'developed in india', 'built in india',
];
const INDIGENOUS_NEGATIVE = [
  'licensed from', 'imported technology', 'foreign collaboration', 'foreign technology',
  'technology transfer from', 'licensed technology', 'under licence from', 'under license from',
  'imported from', 'in collaboration with a foreign',
];

/**
 * true  → text signals domestically developed tech
 * false → text signals foreign/licensed/imported tech
 * null  → no signal either way (leave for manual entry)
 * When both appear, the stronger count wins; ties resolve to null.
 */
export function detectIndigenousTech(text: string): boolean | null {
  const t = text.toLowerCase();
  const pos = INDIGENOUS_POSITIVE.filter(k => t.includes(k)).length;
  const neg = INDIGENOUS_NEGATIVE.filter(k => t.includes(k)).length;
  if (pos === 0 && neg === 0) return null;
  if (pos > neg) return true;
  if (neg > pos) return false;
  return null;
}

// ─── Government mission / scheme alignment ──────────────────────────────────

// Canonical mission names → the phrasing variants that indicate a match. The
// canonical label (key) is what we store; keep this list in sync with the
// GOVT_MISSIONS list in dashboard.html.
export const GOVT_MISSIONS: Record<string, string[]> = {
  'PLI': ['pli scheme', 'production linked incentive', 'production-linked incentive', 'pli '],
  'Make in India': ['make in india'],
  'Digital India': ['digital india'],
  'Startup India': ['startup india'],
  'Atmanirbhar Bharat': ['atmanirbhar bharat', 'atmanirbhar', 'self-reliant india'],
  'National Solar Mission': ['national solar mission', 'jawaharlal nehru national solar mission', 'jnnsm'],
  'Swachh Bharat Mission': ['swachh bharat', 'clean india mission'],
  'Namami Gange': ['namami gange', 'clean ganga', 'national mission for clean ganga'],
  'National Hydrogen Mission': ['national hydrogen mission', 'national green hydrogen mission', 'green hydrogen mission'],
  'Smart Cities Mission': ['smart cities mission', 'smart city mission'],
  'Skill India': ['skill india', 'pradhan mantri kaushal', 'pmkvy'],
  'Jal Jeevan Mission': ['jal jeevan mission', 'har ghar jal'],
  'Semicon India': ['semicon india', 'semiconductor mission', 'india semiconductor mission'],
  'FAME': ['fame scheme', 'fame india', 'faster adoption and manufacturing of electric'],
};

/** Distinct canonical mission names mentioned in the text (best-effort). */
export function detectGovtMissionAlignment(text: string): string[] {
  const t = text.toLowerCase();
  const hits: string[] = [];
  for (const [canonical, variants] of Object.entries(GOVT_MISSIONS)) {
    if (variants.some(v => t.includes(v))) hits.push(canonical);
  }
  return hits;
}

// ─── Subsidy mentions ───────────────────────────────────────────────────────

const has = (t: string, kws: string[]) => kws.some(k => t.includes(k));

export interface SubsidySignals {
  subsidy_land_electricity: SubsidyLandElectricity;
  capex_subsidy_available: boolean | null;
  capex_subsidy_notes: string | null;
  opex_subsidy_available: boolean | null;
  opex_subsidy_notes: string | null;
}

/**
 * Keyword-scan for subsidy/support mentions. A hit sets the flag true with a
 * short note; absence leaves it null (unknown), never false — the source simply
 * not mentioning a subsidy is not evidence it is unavailable.
 */
export function detectSubsidies(text: string): SubsidySignals {
  const t = text.toLowerCase();

  const landHit = has(t, ['subsidized land', 'subsidised land', 'land subsidy', 'land at concessional', 'free land', 'land allotment']);
  const powerHit = has(t, ['subsidized power', 'subsidised power', 'subsidized electricity', 'subsidised electricity', 'electricity subsidy', 'power subsidy', 'power tariff subsidy', 'concessional power']);
  const capexHit = has(t, ['capex support', 'capital subsidy', 'capex subsidy', 'capital investment subsidy', 'capital expenditure support', 'viability gap funding', 'government grant', 'capital grant']);
  const opexHit = has(t, ['opex support', 'operational subsidy', 'operating subsidy', 'opex subsidy', 'production incentive', 'interest subvention']);

  const anyLandPower = landHit || powerHit;
  return {
    subsidy_land_electricity: {
      land_subsidy: landHit ? true : null,
      electricity_subsidy: powerHit ? true : null,
      notes: anyLandPower ? 'Auto-detected from source text (low confidence)' : null,
    },
    capex_subsidy_available: capexHit ? true : null,
    capex_subsidy_notes: capexHit ? 'Auto-detected mention of capex/capital support (low confidence)' : null,
    opex_subsidy_available: opexHit ? true : null,
    opex_subsidy_notes: opexHit ? 'Auto-detected mention of opex/operational support (low confidence)' : null,
  };
}

// ─── Combined ───────────────────────────────────────────────────────────────

export interface FeasibilitySignals extends SubsidySignals {
  indigenous_tech: boolean | null;
  govt_mission_alignment: string[];
}

/** Run every detector over one corpus. */
export function detectFeasibilitySignals(text: string): FeasibilitySignals {
  return {
    indigenous_tech: detectIndigenousTech(text),
    govt_mission_alignment: detectGovtMissionAlignment(text),
    ...detectSubsidies(text),
  };
}
