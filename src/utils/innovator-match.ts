// Deterministic innovator ↔ funder match scoring — the platform's core feature.
// Pure functions only (no DB, no HTTP) so the whole algorithm is unit-testable.
// DB loading/assembly lives in src/tools/match-engine.ts.

import type { InnovatorDomain } from '../types/index.js';

// ─── Domain → CSR sector mapping ──────────────────────────────────────────────

export const DOMAIN_SECTOR_MAP: Record<InnovatorDomain, string[]> = {
  solid_waste: ['Environment'],
  plastic: ['Environment'],
  e_waste: ['Environment'],
  wastewater: ['Environment', 'Sanitation', 'Drinking Water'],
  water_body: ['Environment', 'Sanitation', 'Drinking Water'],
  air_pollution: ['Environment'],
  green_hydrogen: ['Environment', 'Technology'],
  ai_medtech: ['Healthcare', 'Technology'],
  circular_economy: ['Environment', 'Rural Development'],
};

// Human-readable labels for the UI ("solid_waste" → "Solid Waste").
export const DOMAIN_LABELS: Record<InnovatorDomain, string> = {
  solid_waste: 'Solid Waste', plastic: 'Plastic', wastewater: 'Wastewater',
  air_pollution: 'Air Pollution', e_waste: 'E-Waste', green_hydrogen: 'Green Hydrogen',
  circular_economy: 'Circular Economy', ai_medtech: 'AI MedTech', water_body: 'Water Body',
};

// Domain vocabulary used for the +10 keyword bonus: does the funder's own text
// talk about the innovator's problem space?
export const DOMAIN_KEYWORDS: Record<InnovatorDomain, string[]> = {
  solid_waste: ['solid waste', 'waste management', 'municipal waste', 'garbage', 'landfill'],
  plastic: ['plastic', 'polymer waste', 'single-use'],
  wastewater: ['wastewater', 'waste water', 'sewage', 'effluent', 'water treatment'],
  air_pollution: ['air pollution', 'air quality', 'emission', 'particulate', 'smog'],
  e_waste: ['e-waste', 'electronic waste', 'battery recycling'],
  green_hydrogen: ['green hydrogen', 'hydrogen', 'clean fuel', 'electrolyser', 'electrolyzer'],
  circular_economy: ['circular economy', 'circularity', 'recycl', 'upcycl', 'closed loop', 'zero waste'],
  ai_medtech: ['medtech', 'medical device', 'diagnostic', 'telemedicine', 'health technology', 'ai in health'],
  water_body: ['water body', 'lake', 'river', 'pond', 'water rejuvenation', 'groundwater'],
};

// NCR aliases — "both in Delhi/NCR" counts as a geography match.
const DELHI_NCR_ALIASES = ['delhi', 'new delhi', 'delhi/ncr', 'ncr', 'delhi ncr', 'gurugram', 'gurgaon', 'noida', 'ghaziabad', 'faridabad'];

function isDelhiNCR(geo: string): boolean {
  const g = geo.toLowerCase().trim();
  return DELHI_NCR_ALIASES.some(a => g === a || g.includes(a));
}

function isPanIndia(geo: string): boolean {
  return /pan[\s-]?india|all india|nationwide/i.test(geo);
}

// ─── Inputs ───────────────────────────────────────────────────────────────────

export interface InnovatorMatchInput {
  domain: InnovatorDomain;
  trl_current: number | null;
  geography: string[];
  /** description + usp — searched for funder keyword overlap. */
  text: string;
}

export interface FunderMatchInput {
  id: string;
  kind: 'company' | 'scheme';
  name: string;
  sectors: string[];
  geographies: string[];
  /** TRL range the funder funds ({min:0,max:0} = unknown). */
  trl: { min: number; max: number };
  /** Funder's own text (programs, notes) — searched for domain keywords. */
  text: string;
  contact_email: string | null;
}

export interface MatchResult {
  funderId: string;
  kind: 'company' | 'scheme';
  name: string;
  score: number;          // 0–100
  reasons: string[];      // why matched (sector/geo/TRL/keyword)
  contact_email: string | null;
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Score one innovator/funder pair. Symmetric — used for both match directions.
 *   Sector match  (domain maps to a funder sector)          +40
 *   Geography     (same state, or both Delhi/NCR)           +30
 *                 (funder is Pan-India → partial)           +15
 *   TRL           (funder's funded TRL range includes
 *                  the innovator's current TRL)              +20
 *   Keywords      (funder text mentions the domain)          +10
 */
export function scoreFunderInnovatorPair(inn: InnovatorMatchInput, funder: FunderMatchInput): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  // Sector: innovator domain → CSR sectors ∩ funder sectors
  const mapped = DOMAIN_SECTOR_MAP[inn.domain] ?? [];
  const funderSectors = new Set(funder.sectors.map(s => s.toLowerCase()));
  const sectorHits = mapped.filter(s => funderSectors.has(s.toLowerCase()));
  if (sectorHits.length) {
    score += 40;
    reasons.push(`Sector: ${DOMAIN_LABELS[inn.domain] ?? inn.domain} maps to ${sectorHits.join(', ')} (+40)`);
  }

  // Geography: same state or both Delhi/NCR; Pan-India funder gets partial credit.
  const innGeos = inn.geography.filter(Boolean);
  const shared = innGeos.filter(g =>
    funder.geographies.some(fg =>
      fg.toLowerCase() === g.toLowerCase() || (isDelhiNCR(fg) && isDelhiNCR(g))));
  if (shared.length) {
    score += 30;
    reasons.push(`Geography: both operate in ${shared[0]} (+30)`);
  } else if (innGeos.length && funder.geographies.some(isPanIndia)) {
    score += 15;
    reasons.push(`Geography: funder is Pan-India, covers ${innGeos[0]} (+15)`);
  }

  // TRL: funder's funded range must include the innovator's current TRL.
  if (inn.trl_current != null && funder.trl.max > 0 &&
      inn.trl_current >= funder.trl.min && inn.trl_current <= funder.trl.max) {
    score += 20;
    reasons.push(`TRL: funder supports TRL ${funder.trl.min}-${funder.trl.max}, innovator at TRL ${inn.trl_current} (+20)`);
  }

  // Keywords: funder text mentions the innovator's problem space (or vice versa —
  // the innovator's text names a funder sector keyword).
  const funderText = funder.text.toLowerCase();
  const kwHits = (DOMAIN_KEYWORDS[inn.domain] ?? []).filter(kw => funderText.includes(kw));
  if (kwHits.length) {
    score += 10;
    reasons.push(`Keywords: funder mentions ${kwHits.slice(0, 3).join(', ')} (+10)`);
  }

  return { score: Math.min(100, score), reasons };
}

/** Rank a list of funders for one innovator, best first. */
export function rankFunders(inn: InnovatorMatchInput, funders: FunderMatchInput[], limit = 10): MatchResult[] {
  return funders
    .map(f => {
      const { score, reasons } = scoreFunderInnovatorPair(inn, f);
      return { funderId: f.id, kind: f.kind, name: f.name, score, reasons, contact_email: f.contact_email };
    })
    .filter(m => m.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export interface InnovatorRankResult {
  innovatorId: string;
  name: string;
  domain: InnovatorDomain;
  score: number;
  reasons: string[];
  contact_email: string | null;
}

/** Reverse direction: rank innovators for one funder, best first. */
export function rankInnovators(
  funder: FunderMatchInput,
  innovators: Array<InnovatorMatchInput & { id: string; name: string; contact_email: string | null }>,
  limit = 10,
): InnovatorRankResult[] {
  return innovators
    .map(inn => {
      const { score, reasons } = scoreFunderInnovatorPair(inn, funder);
      return { innovatorId: inn.id, name: inn.name, domain: inn.domain, score, reasons, contact_email: inn.contact_email };
    })
    .filter(m => m.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}
