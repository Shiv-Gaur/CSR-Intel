import { describe, it, expect } from 'vitest';
import { inferSectorsFromText, inferGeographyFromCIN, estimateSpendFromProfit } from '../inference.js';

describe('inferSectorsFromText', () => {
  it('maps pharma to Healthcare', () => {
    const r = inferSectorsFromText('a leading pharmaceutical and drugs maker');
    expect(r.sectors).toEqual(expect.arrayContaining(['Healthcare', 'Rural Development']));
    expect(r.basis).toContain('Pharma');
  });
  it('maps IT/software to Technology', () => {
    const r = inferSectorsFromText('an information technology and software services firm');
    expect(r.sectors).toContain('Technology');
  });
  it('returns empty when industry unknown', () => {
    expect(inferSectorsFromText('a small bakery').sectors).toEqual([]);
  });
  it('maps named large-caps with no industry keyword in their name', () => {
    expect(inferSectorsFromText('Cipla').sectors[0]).toBe('Healthcare');
    expect(inferSectorsFromText('Reliance Industries').sectors[0]).toBe('Environment');
    expect(inferSectorsFromText('Larsen & Toubro').sectors).toEqual(expect.arrayContaining(['Environment', 'Skill Development']));
    expect(inferSectorsFromText('ITC Limited').sectors[0]).toBe('Rural Development');
    expect(inferSectorsFromText('ONGC').sectors[0]).toBe('Environment');
  });
  it('prefers the foundation mapping over the IT mapping for Infosys Foundation', () => {
    expect(inferSectorsFromText('Infosys Foundation').sectors[0]).toBe('Education');
  });
});

describe('inferGeographyFromCIN', () => {
  it('reads the state code from a CIN', () => {
    expect(inferGeographyFromCIN('L22210MH2004PLC148028').geographies).toEqual(['Maharashtra']);
    expect(inferGeographyFromCIN('L85110KA1981PLC013115').geographies).toEqual(['Karnataka']);
  });
  it('returns empty for missing/short CIN', () => {
    expect(inferGeographyFromCIN(null).geographies).toEqual([]);
    expect(inferGeographyFromCIN('abc').geographies).toEqual([]);
  });
});

describe('estimateSpendFromProfit', () => {
  it('estimates 2% of net profit found in text', () => {
    const r = estimateSpendFromProfit('Net profit of Rs 1000 crore for the year');
    expect(r.estimatedCr).toBe(20);
    expect(r.basis).toContain('2% of net profit');
  });
  it('returns null when no net profit present', () => {
    expect(estimateSpendFromProfit('revenue grew 10%').estimatedCr).toBeNull();
  });
});
