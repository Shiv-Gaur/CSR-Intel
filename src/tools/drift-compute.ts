import type { DriftScores, DriftDetail, SectorAllocation } from '../types/index.js';


// =============================================================================
// FDIE — Funder Drift Intelligence Engine
// Implements the drift formulas from architecture doc
// =============================================================================

/**
 * Compute sector drift using cosine similarity between allocation vectors
 * SECTOR_DRIFT = 1 − cosine_similarity(sector_vector_t, sector_vector_t−n)
 */
export function computeSectorDrift(
  baseline: SectorAllocation[],
  current: SectorAllocation[],
): DriftDetail {
  const allSectors = new Set<string>();
  baseline.forEach(a => allSectors.add(a.sector));
  current.forEach(a => allSectors.add(a.sector));

  const sectorList = [...allSectors];

  // Build vectors
  const baselineVec = sectorList.map(s => {
    const alloc = baseline.find(a => a.sector === s);
    return alloc?.spend_pct ?? alloc?.spend_cr ?? 0;
  });

  const currentVec = sectorList.map(s => {
    const alloc = current.find(a => a.sector === s);
    return alloc?.spend_pct ?? alloc?.spend_cr ?? 0;
  });

  const similarity = cosineSimilarity(baselineVec, currentVec);
  const score = Math.round((1 - similarity) * 100);

  // Compute per-sector changes
  const changes = sectorList.map(sector => {
    const baseVal = baselineVec[sectorList.indexOf(sector)];
    const currVal = currentVec[sectorList.indexOf(sector)];
    const diff = currVal - baseVal;

    let direction: 'added' | 'removed' | 'increased' | 'decreased' | 'stable';
    if (baseVal === 0 && currVal > 0) direction = 'added';
    else if (baseVal > 0 && currVal === 0) direction = 'removed';
    else if (diff > 0) direction = 'increased';
    else if (diff < 0) direction = 'decreased';
    else direction = 'stable';

    return { item: sector, direction, magnitude: Math.abs(diff) };
  }).filter(c => c.direction !== 'stable');

  return {
    dimension: 'sector',
    score,
    explanation: `Sector allocation cosine distance: ${(1 - similarity).toFixed(3)}. ${changes.length} sectors changed.`,
    changes,
  };
}

/**
 * Compute geography drift using set difference
 * GEO_DRIFT = |current_geo_set Δ baseline_geo_set| / |union|
 */
export function computeGeographyDrift(
  baselineGeos: string[],
  currentGeos: string[],
): DriftDetail {
  const baseSet = new Set(baselineGeos.map(g => g.toLowerCase().trim()));
  const currSet = new Set(currentGeos.map(g => g.toLowerCase().trim()));

  const union = new Set([...baseSet, ...currSet]);
  const intersection = new Set([...baseSet].filter(x => currSet.has(x)));
  const symmetricDiff = union.size - intersection.size;

  const score = union.size > 0
    ? Math.round((symmetricDiff / union.size) * 100)
    : 0;

  const added = [...currSet].filter(g => !baseSet.has(g));
  const removed = [...baseSet].filter(g => !currSet.has(g));

  const changes = [
    ...added.map(g => ({ item: g, direction: 'added' as const, magnitude: 1 })),
    ...removed.map(g => ({ item: g, direction: 'removed' as const, magnitude: 1 })),
  ];

  return {
    dimension: 'geography',
    score,
    explanation: `${added.length} geographies added, ${removed.length} removed. Set difference: ${symmetricDiff}/${union.size}.`,
    changes,
  };
}

/**
 * Compute requirement drift
 * REQ_DRIFT = (added_reqs × 1.2 + dropped_reqs × 0.8 + modified_reqs × 0.5) / total_reqs
 */
export function computeRequirementDrift(
  baselineReqs: string[],
  currentReqs: string[],
  modifiedReqs: string[] = [],
): DriftDetail {
  const baseSet = new Set(baselineReqs.map(r => r.toLowerCase().trim()));
  const currSet = new Set(currentReqs.map(r => r.toLowerCase().trim()));

  const added = [...currSet].filter(r => !baseSet.has(r));
  const dropped = [...baseSet].filter(r => !currSet.has(r));
  const totalReqs = new Set([...baseSet, ...currSet]).size;

  const rawScore = totalReqs > 0
    ? (added.length * 1.2 + dropped.length * 0.8 + modifiedReqs.length * 0.5) / totalReqs
    : 0;

  const score = Math.min(100, Math.round(rawScore * 100));

  const changes = [
    ...added.map(r => ({ item: r, direction: 'added' as const, magnitude: 1.2 })),
    ...dropped.map(r => ({ item: r, direction: 'removed' as const, magnitude: 0.8 })),
    ...modifiedReqs.map(r => ({ item: r, direction: 'increased' as const, magnitude: 0.5 })),
  ];

  return {
    dimension: 'requirement',
    score,
    explanation: `${added.length} requirements added, ${dropped.length} dropped, ${modifiedReqs.length} modified.`,
    changes,
  };
}

/**
 * Compute openness-to-partnership drift
 * OPEN_DRIFT = logit_change(P(accepts_proposals)) + mode_change_flag
 */
export function computeOpennessDrift(
  baselineAccepts: boolean | null,
  currentAccepts: boolean | null,
  baselineMode: string | null,
  currentMode: string | null,
): DriftDetail {
  let score = 0;
  const changes: DriftDetail['changes'] = [];

  // Proposal acceptance change
  if (baselineAccepts !== null && currentAccepts !== null && baselineAccepts !== currentAccepts) {
    score += 50;
    changes.push({
      item: 'accepts_proposals',
      direction: currentAccepts ? 'increased' : 'decreased',
      magnitude: 50,
    });
  }

  // Implementation mode change
  if (baselineMode && currentMode && baselineMode !== currentMode) {
    score += 40;
    changes.push({
      item: `implementing_mode: ${baselineMode} → ${currentMode}`,
      direction: currentMode === 'ngo_grant' ? 'increased' : 'decreased',
      magnitude: 40,
    });
  }

  // Cap at 100
  score = Math.min(100, score);

  return {
    dimension: 'openness',
    score,
    explanation: changes.length > 0
      ? `${changes.length} openness signal(s) changed.`
      : 'No openness changes detected.',
    changes,
  };
}

/**
 * Compute composite drift score with configurable weights
 * COMPOSITE = 0.35·SECTOR + 0.25·GEO + 0.25·REQ + 0.15·OPEN
 */
export function computeCompositeDrift(
  sectorDrift: number,
  geoDrift: number,
  reqDrift: number,
  openDrift: number,
  weights = { sector: 0.35, geography: 0.25, requirement: 0.25, openness: 0.15 },
): DriftScores {
  const composite = Math.round(
    weights.sector * sectorDrift +
    weights.geography * geoDrift +
    weights.requirement * reqDrift +
    weights.openness * openDrift
  );

  return {
    sector: sectorDrift,
    geography: geoDrift,
    requirement: reqDrift,
    openness: openDrift,
    composite,
  };
}

// =============================================================================
// Math helpers
// =============================================================================

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}
