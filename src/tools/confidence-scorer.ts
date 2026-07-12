import { createAgentLogger } from '../utils/logger-core.js';
import type { ConfidenceLevel } from '../types/index.js';

const log = createAgentLogger('confidence-scorer');

interface SourceValue {
  value: unknown;
  source: string;
  confidence: ConfidenceLevel;
}

interface ConfidenceResult {
  agreedValue: unknown;
  confidence: ConfidenceLevel;
  conflict: boolean;
  sources: string[];
  conflictDetail?: string;
}

/**
 * Compare field values across multiple source extractions
 * Returns agreed value + confidence level + conflict flags
 */
export function scoreFieldConfidence(
  fieldName: string,
  sources: SourceValue[],
): ConfidenceResult {
  if (sources.length === 0) {
    return {
      agreedValue: null,
      confidence: 'low',
      conflict: false,
      sources: [],
    };
  }

  if (sources.length === 1) {
    return {
      agreedValue: sources[0].value,
      confidence: sources[0].confidence,
      conflict: false,
      sources: [sources[0].source],
    };
  }

  // Compare values across sources
  const nonNullSources = sources.filter(s => s.value != null);
  if (nonNullSources.length === 0) {
    return {
      agreedValue: null,
      confidence: 'low',
      conflict: false,
      sources: sources.map(s => s.source),
    };
  }

  // Check for agreement
  const valuesMatch = checkValuesMatch(fieldName, nonNullSources);

  if (valuesMatch.match) {
    return {
      agreedValue: nonNullSources[0].value,
      confidence: 'high', // Sources agree → high confidence
      conflict: false,
      sources: nonNullSources.map(s => s.source),
    };
  }

  // Conflict detected
  log.warn({
    fieldName,
    values: nonNullSources.map(s => ({ source: s.source, value: s.value })),
  }, 'Field conflict detected');

  return {
    agreedValue: nonNullSources[0].value, // Use first source as default
    confidence: 'low',
    conflict: true,
    sources: nonNullSources.map(s => s.source),
    conflictDetail: valuesMatch.detail,
  };
}

/**
 * Check if values from multiple sources agree
 */
function checkValuesMatch(
  fieldName: string,
  sources: SourceValue[],
): { match: boolean; detail?: string } {
  const values = sources.map(s => s.value);

  // Boolean fields — direct comparison
  if (typeof values[0] === 'boolean') {
    const allSame = values.every(v => v === values[0]);
    return {
      match: allSame,
      detail: allSame ? undefined : `Conflicting boolean values: ${values.join(', ')}`,
    };
  }

  // Numeric fields — allow 10% variance
  if (typeof values[0] === 'number') {
    const nums = values.filter(v => typeof v === 'number') as number[];
    if (nums.length < 2) return { match: true };

    const max = Math.max(...nums);
    const min = Math.min(...nums);
    const variance = max > 0 ? (max - min) / max : 0;

    return {
      match: variance <= 0.10,
      detail: variance > 0.10
        ? `Numeric variance ${(variance * 100).toFixed(1)}% exceeds 10% threshold: ${nums.join(' vs ')}`
        : undefined,
    };
  }

  // Array fields (sectors, geographies) — check set overlap
  if (Array.isArray(values[0])) {
    const sets = values.map(v => new Set((v as string[]).map(s => s.toLowerCase().trim())));
    if (sets.length < 2) return { match: true };

    const intersection = new Set([...sets[0]].filter(x => sets[1].has(x)));
    const union = new Set([...sets[0], ...sets[1]]);
    const overlap = union.size > 0 ? intersection.size / union.size : 1;

    return {
      match: overlap >= 0.6, // 60% overlap is "agreement" for arrays
      detail: overlap < 0.6
        ? `Array overlap ${(overlap * 100).toFixed(0)}% below 60% threshold`
        : undefined,
    };
  }

  // String fields — normalize and compare
  if (typeof values[0] === 'string') {
    const normalized = values.map(v => (v as string).toLowerCase().trim());
    const allSame = normalized.every(v => v === normalized[0]);
    return {
      match: allSame,
      detail: allSame ? undefined : `String mismatch: "${values[0]}" vs "${values[1]}"`,
    };
  }

  // Default — assume match if types don't match known patterns
  return { match: true };
}

/**
 * Score overall entity confidence based on field-level confidences
 */
export function scoreEntityConfidence(
  fieldConfidences: Record<string, ConfidenceLevel>,
): {
  overall: ConfidenceLevel;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  completeness: number;
} {
  const values = Object.values(fieldConfidences);
  const total = values.length;
  const highCount = values.filter(v => v === 'high').length;
  const mediumCount = values.filter(v => v === 'medium').length;
  const lowCount = values.filter(v => v === 'low').length;

  const completeness = total > 0 ? (total - lowCount) / total : 0;

  let overall: ConfidenceLevel;
  if (highCount >= total * 0.7) {
    overall = 'high';
  } else if (lowCount >= total * 0.3) {
    overall = 'low';
  } else {
    overall = 'medium';
  }

  return { overall, highCount, mediumCount, lowCount, completeness };
}
