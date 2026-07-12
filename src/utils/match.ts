// Deterministic profile-match scoring: how well a company fits the user's
// targeting profile (technologies offered, target sectors/geographies, keywords).
// Separate from the data-completeness score in extractor.ts.

import { SECTOR_KEYWORDS } from './extractor.js';
import { DOMAIN_LABELS } from './innovator-match.js';

// The platform's own focus domains — companies whose text shows work in these
// problem spaces are better funding fits regardless of formal sector labels.
const PLATFORM_FOCUS_DOMAINS = new Set(Object.keys(DOMAIN_LABELS));

export interface ProfileInput {
  technologies: string[];
  target_sectors: string[];
  target_geographies: string[];
  keywords: string[];
}

export interface CompanyMatchInput {
  sectors: string[];
  geographies: string[];
  description: string;
  /** Auto-detected focus domains (solid_waste, plastic, …) — optional. */
  domain_focus?: string[];
}

export interface ProfileMatch {
  score: number;        // 0–100
  reasons: string[];    // "WHY THIS MATCH" lines
}

const lc = (s: string) => s.toLowerCase();

function overlap(a: string[], b: string[]): string[] {
  const setB = new Set(b.map(lc));
  return a.filter(x => setB.has(lc(x)));
}

function present(haystack: string, needles: string[]): string[] {
  const h = lc(haystack);
  return needles.filter(n => n && h.includes(lc(n)));
}

// Count non-overlapping, case-insensitive occurrences of `term` in `text`.
function occurrences(text: string, term: string): number {
  if (!term) return 0;
  const t = lc(text);
  const n = lc(term);
  let count = 0, i = t.indexOf(n);
  while (i !== -1) { count++; i = t.indexOf(n, i + n.length); }
  return count;
}

/**
 * Graded textual-relevance ("affinity") to the target sectors/geographies. Unlike
 * the flat overlap bonuses, this scales with how strongly the company's own text
 * relates to each target, so companies that don't formally list a target sector
 * still spread across a range of scores instead of all collapsing to 0. A target
 * sector's vocabulary is the same keyword set the extractor uses to detect it.
 */
function affinityScore(description: string, p: ProfileInput): { points: number; hits: string[] } {
  let points = 0;
  const hits: string[] = [];
  for (const sector of p.target_sectors) {
    const kws = SECTOR_KEYWORDS[sector] ?? [sector];
    let h = 0;
    for (const kw of kws) h += occurrences(description, kw);
    if (h > 0) { points += Math.min(h, 3) * 3; hits.push(sector); } // up to +9 per sector
  }
  for (const geo of p.target_geographies) {
    const h = occurrences(description, geo);
    if (h > 0) { points += Math.min(h, 3) * 2; hits.push(geo); }   // up to +6 per geography
  }
  return { points: Math.min(points, 25), hits };
}

// Points for one matched item, graded by where it sits in the company's own
// ranked list (extraction ranks by frequency, so index 0 = the company's main
// focus). A match on a company's #1 sector is worth more than on its #6.
function rankedPoints(rank: number, first: number, step: number, floor: number): number {
  return Math.max(floor, first - step * rank);
}

/**
 * Score a company against the targeting profile. Every component is graded —
 * by how MUCH of the profile the company covers and how PROMINENT each match
 * is in the company's own ranked lists — so near-identical portfolios still
 * spread across distinct scores instead of collapsing onto one flat number
 * (the old flat +30/+20 bonuses put >60% of companies on the same score).
 *   sectors      → up to 35 (per target hit: 12,10,8,… by company rank)
 *   geographies  → up to 25 (per target hit: 13,11,9,… by company rank;
 *                  Pan-India with no direct hit → 7..12 by footprint breadth)
 *   keywords     → up to 20 (7 per distinct hit)
 *   technologies → up to 20 (10 per distinct hit)
 *   affinity     → up to 25 (occurrence-graded textual relevance)
 */
export function computeProfileMatch(c: CompanyMatchInput, p: ProfileInput): ProfileMatch {
  let score = 0;
  const reasons: string[] = [];

  const companySectorsLc = c.sectors.map(lc);
  const sectorHits = overlap(c.sectors, p.target_sectors);
  if (sectorHits.length) {
    let pts = 0;
    const parts = sectorHits.map(s => {
      const rank = companySectorsLc.indexOf(lc(s));
      const pt = rankedPoints(rank, 12, 2, 4);
      pts += pt;
      return `${s} (#${rank + 1} focus +${pt})`;
    });
    pts = Math.min(pts, 35);
    score += pts;
    reasons.push(`Sector match: ${parts.join(', ')}`);
  }

  const companyGeosLc = c.geographies.map(lc);
  const geoHits = overlap(c.geographies, p.target_geographies);
  if (geoHits.length) {
    let pts = 0;
    const parts = geoHits.map(g => {
      const rank = companyGeosLc.indexOf(lc(g));
      const pt = rankedPoints(rank, 13, 2, 5);
      pts += pt;
      return `${g} (+${pt})`;
    });
    pts = Math.min(pts, 25);
    score += pts;
    reasons.push(`Geography match: ${parts.join(', ')}`);
  } else if (p.target_geographies.length && c.geographies.some(g => lc(g).includes('pan-india'))) {
    // A nationally-operating funder reaches the target region too — partial
    // credit, graded by how broad its stated footprint is (more states named ⇒
    // more likely to actively serve a niche target region).
    const pts = 6 + Math.min(c.geographies.length, 6); // 7..12
    score += pts; reasons.push(`Pan-India reach covers target geography (+${pts})`);
  }

  const kwHits = present(c.description, p.keywords);
  if (kwHits.length) {
    const pts = Math.min(kwHits.length * 7, 20);
    score += pts; reasons.push(`Keyword match: ${kwHits.join(', ')} (+${pts})`);
  }

  const techHits = present(c.description, p.technologies);
  if (techHits.length) {
    const pts = Math.min(techHits.length * 10, 20);
    score += pts; reasons.push(`Technology match: ${techHits.join(', ')} (+${pts})`);
  }

  // Graded relevance so niche profiles produce a spread rather than all-zeros.
  const aff = affinityScore(c.description, p);
  if (aff.points > 0) { score += aff.points; reasons.push(`Textual relevance: ${aff.hits.join(', ')} (+${aff.points})`); }

  // Domain focus: the company's own text shows work in the platform's problem
  // domains (solid waste, plastic, wastewater…) — +4 per domain, capped at 12.
  const domainHits = (c.domain_focus ?? []).filter(d => PLATFORM_FOCUS_DOMAINS.has(d));
  if (domainHits.length) {
    const pts = Math.min(domainHits.length * 4, 12);
    score += pts;
    reasons.push(`Domain focus: ${domainHits.map(d => (DOMAIN_LABELS as Record<string, string>)[d] ?? d).join(', ')} (+${pts})`);
  }

  return { score: Math.min(100, score), reasons };
}
