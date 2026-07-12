import { describe, it, expect } from 'vitest';
import {
  computeSectorDrift,
  computeGeographyDrift,
  computeRequirementDrift,
  computeOpennessDrift,
  computeCompositeDrift,
} from '../drift-compute.js';

describe('Drift Compute Engine (FDIE)', () => {
  it('should compute sector drift correctly (cosine similarity)', () => {
    const baseline = [
      { sector: 'Education', spend_pct: 50, financial_year: '2021-22' },
      { sector: 'Health', spend_pct: 50, financial_year: '2021-22' },
    ];
    const currentMatches = [
      { sector: 'Education', spend_pct: 50, financial_year: '2022-23' },
      { sector: 'Health', spend_pct: 50, financial_year: '2022-23' },
    ];
    const driftNoChange = computeSectorDrift(baseline, currentMatches);
    expect(driftNoChange.score).toBe(0);

    const currentChanged = [
      { sector: 'Education', spend_pct: 100, financial_year: '2022-23' },
      { sector: 'Health', spend_pct: 0, financial_year: '2022-23' },
    ];
    const driftChanged = computeSectorDrift(baseline, currentChanged);
    expect(driftChanged.score).toBeGreaterThan(0);
  });

  it('should compute geography drift correctly (set symmetric difference)', () => {
    const baseGeos = ['Maharashtra', 'Gujarat'];
    const currGeosNoChange = ['Maharashtra', 'Gujarat'];
    const geoDriftNoChange = computeGeographyDrift(baseGeos, currGeosNoChange);
    expect(geoDriftNoChange.score).toBe(0);

    const currGeosChanged = ['Maharashtra', 'Karnataka'];
    const geoDriftChanged = computeGeographyDrift(baseGeos, currGeosChanged);
    // Symmetric diff = 2 (Gujarat, Karnataka), Union = 3 (Mah, Guj, Kar). Drift = 2/3 = 67%
    expect(geoDriftChanged.score).toBe(67);
  });

  it('should compute requirement drift correctly', () => {
    const baseReqs = ['12A', '80G'];
    const currReqsNoChange = ['12A', '80G'];
    const reqDriftNoChange = computeRequirementDrift(baseReqs, currReqsNoChange);
    expect(reqDriftNoChange.score).toBe(0);

    const currReqsChanged = ['12A', '80G', 'CSR-1']; // added 1 (1.2), total = 3 -> 1.2/3 = 40%
    const reqDriftChanged = computeRequirementDrift(baseReqs, currReqsChanged);
    expect(reqDriftChanged.score).toBe(40);
  });

  it('should compute openness drift correctly', () => {
    const driftNoChange = computeOpennessDrift(true, true, 'ngo_grant', 'ngo_grant');
    expect(driftNoChange.score).toBe(0);

    const driftChangeAccepts = computeOpennessDrift(true, false, 'ngo_grant', 'ngo_grant');
    expect(driftChangeAccepts.score).toBe(50);

    const driftChangeMode = computeOpennessDrift(true, true, 'ngo_grant', 'foundation');
    expect(driftChangeMode.score).toBe(40);

    const driftBothChanged = computeOpennessDrift(true, false, 'ngo_grant', 'foundation');
    expect(driftBothChanged.score).toBe(90);
  });

  it('should compute composite drift correctly', () => {
    const composite = computeCompositeDrift(10, 50, 40, 90);
    // 0.35*10 + 0.25*50 + 0.25*40 + 0.15*90 = 3.5 + 12.5 + 10 + 13.5 = 39.5 -> rounded to 40
    expect(composite.composite).toBe(40);
  });
});
