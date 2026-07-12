// Deterministic Technology Readiness Level (TRL) inference from free text.
// No LLM — keyword bands mapped to the three coarse readiness ranges the UI
// shows as badges. The strongest-signal band (most keyword hits) wins; ties
// resolve to the more advanced band.

export type TRLBand = 'research' | 'development' | 'deployment' | 'unknown';

export interface TRLResult {
  band: TRLBand;
  min: number;        // TRL lower bound (0 when unknown)
  max: number;        // TRL upper bound (0 when unknown)
  label: string;      // e.g. "TRL 1-3: Research"
  basis: string;      // which keywords triggered the band
}

interface BandRule { band: Exclude<TRLBand, 'unknown'>; min: number; max: number; label: string; keywords: string[]; }

const BANDS: BandRule[] = [
  {
    band: 'research', min: 1, max: 3, label: 'TRL 1-3: Research',
    keywords: ['research', 'pilot', 'prototype', 'r&d', 'feasibility', 'proof of concept', 'concept', 'early stage', 'incubat'],
  },
  {
    band: 'development', min: 4, max: 6, label: 'TRL 4-6: Development',
    keywords: ['demonstration', 'demo', 'trial', 'validation', 'field test', 'develop', 'testing'],
  },
  {
    band: 'deployment', min: 7, max: 9, label: 'TRL 7-9: Deployment',
    keywords: ['deployment', 'deploy', 'scale', 'scaling', 'scale-up', 'implementation', 'implement', 'rollout', 'roll-out', 'adoption', 'commercial', 'at scale'],
  },
];

const UNKNOWN: TRLResult = { band: 'unknown', min: 0, max: 0, label: 'TRL: Unknown', basis: '' };

/** Infer a TRL band from a project/eligibility description. */
export function inferTRL(text: string | null | undefined): TRLResult {
  if (!text || !text.trim()) return { ...UNKNOWN };
  const lower = text.toLowerCase();

  let best: { rule: BandRule; hits: string[] } | null = null;
  for (const rule of BANDS) {
    const hits = rule.keywords.filter(kw => lower.includes(kw));
    if (!hits.length) continue;
    // More hits wins; tie → more advanced band (BANDS is ordered least→most advanced).
    if (!best || hits.length >= best.hits.length) best = { rule, hits };
  }

  if (!best) return { ...UNKNOWN };
  return { band: best.rule.band, min: best.rule.min, max: best.rule.max, label: best.rule.label, basis: best.hits.join(', ') };
}
