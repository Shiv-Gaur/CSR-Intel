// Deterministic sustainability scoring for innovators — pure functions, no I/O.
// Lives in utils (not tools/innovator-research.ts) so the DB layer can compute a
// score at INSERT time without importing the research pipeline (which imports db,
// creating a cycle). The seeds/import bug: rows inserted without an explicit
// sustainability_score defaulted to 0 and stayed 0 unless deep research later
// succeeded — scoring at insert closes that gap.

import type { CircularityIndicators } from '../types/index.js';

export function detectCircularityIndicators(text: string): CircularityIndicators {
  const t = text.toLowerCase();
  return {
    closed_loop: /closed[\s-]?loop/.test(t),
    zero_waste: /zero[\s-]?waste/.test(t),
    renewable_energy: /renewable energy|solar|wind energy|clean energy/.test(t),
    circular_economy: /circular economy|circularity/.test(t),
  };
}

// Deterministic 0–100: 15 per circularity indicator (max 60) + up to 40 from
// broader sustainability vocabulary hits.
export function scoreSustainability(text: string, indicators: CircularityIndicators): number {
  const t = text.toLowerCase();
  const indicatorPts = Object.values(indicators).filter(Boolean).length * 15;
  const vocab = ['recycl', 'upcycl', 'sustainab', 'carbon', 'emission', 'biodegradable', 'compost', 'green', 'waste reduction', 'environment'];
  let hits = 0;
  for (const v of vocab) if (t.includes(v)) hits++;
  return Math.min(100, indicatorPts + Math.min(hits * 4, 40));
}

/**
 * Score an innovator from whatever is known at insert/backfill time: its own
 * description/USP text plus any user-provided circularity indicators (which are
 * OR-merged with indicators detected in the text — user claims are kept, text
 * evidence can only add).
 */
export function computeInnovatorSustainability(
  text: string,
  provided?: Partial<CircularityIndicators> | null,
): { score: number; indicators: CircularityIndicators } {
  const detected = detectCircularityIndicators(text);
  const indicators: CircularityIndicators = {
    closed_loop: !!provided?.closed_loop || detected.closed_loop,
    zero_waste: !!provided?.zero_waste || detected.zero_waste,
    renewable_energy: !!provided?.renewable_energy || detected.renewable_energy,
    circular_economy: !!provided?.circular_economy || detected.circular_economy,
  };
  return { score: scoreSustainability(text, indicators), indicators };
}
