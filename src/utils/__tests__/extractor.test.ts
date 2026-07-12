import { describe, it, expect } from 'vitest';
import {
  extractSectors, extractGeographies, extractSpend, generateSummary,
  scoreCompany, extractEmail, extractRegistrations, detectAcceptsProposals,
  attributeAcrossSources, sectorsAreRanked,
} from '../extractor.js';

describe('extractSectors', () => {
  it('matches canonical sectors case-insensitively', () => {
    const r = extractSectors('We invest in EDUCATION, rural development and women empowerment');
    expect(r).toContain('Education');
    expect(r).toContain('Rural Development');
    expect(r).toContain('Women Empowerment');
  });
  it('returns empty for no matches', () => {
    expect(extractSectors('quarterly revenue grew')).toEqual([]);
  });
});

describe('sectorsAreRanked', () => {
  it('is true when order breaks the canonical Education-first order (frequency-ranked)', () => {
    expect(sectorsAreRanked(['Environment', 'Education', 'Healthcare'])).toBe(true);
    expect(sectorsAreRanked(['Healthcare', 'Education'])).toBe(true);
  });
  it('trusts a single extracted sector as its own top', () => {
    expect(sectorsAreRanked(['Healthcare'])).toBe(true);
  });
  it('skips non-canonical names instead of treating them as order breaks', () => {
    // known positions Education(0), Environment(2) are still ascending ⇒ not ranked
    expect(sectorsAreRanked(['Education', 'Health', 'Nutrition', 'Environment'])).toBe(false);
    // no recognisable canonical sector ⇒ cannot be called ranked
    expect(sectorsAreRanked(['Health', 'Nutrition'])).toBe(false);
  });
  it('is false for stale canonical-order lists and empty/nullish input', () => {
    expect(sectorsAreRanked(['Education', 'Healthcare', 'Environment'])).toBe(false);
    expect(sectorsAreRanked([])).toBe(false);
    expect(sectorsAreRanked(null)).toBe(false);
  });
});

describe('extractGeographies', () => {
  it('matches states/UTs and pan-india variants', () => {
    const r = extractGeographies('Programs run in Maharashtra and Tamil Nadu, nationwide');
    expect(r).toContain('Maharashtra');
    expect(r).toContain('Tamil Nadu');
    expect(r).toContain('Pan-India');
  });
});

describe('extractSpend', () => {
  it('parses CSR-context Rs/INR/crore patterns into a number in crores', () => {
    expect(extractSpend('CSR spend of Rs. 45.2 crore in FY24')).toBe(45.2);
    expect(extractSpend('INR 120 Cr allocated')).toBe(120);
    expect(extractSpend('community investment of ₹12 crores')).toBe(12);
    expect(extractSpend('donated Rs 8 crore to the foundation')).toBe(8);
  });
  it('returns null when no spend present', () => {
    expect(extractSpend('no financial figures here')).toBeNull();
  });
  it('ignores crore figures in a revenue/profit context (not CSR spend)', () => {
    expect(extractSpend('Total revenue of Rs 90000 crore')).toBeNull();
    expect(extractSpend('Net profit was 12000 crore this year')).toBeNull();
    expect(extractSpend('₹45 crore')).toBeNull(); // bare figure, no CSR context
  });
});

describe('generateSummary', () => {
  it('returns at most 300 chars with collapsed whitespace', () => {
    const s = generateSummary('a\n\n b   c '.repeat(100));
    expect(s.length).toBeLessThanOrEqual(300);
    expect(s).not.toContain('\n');
  });
});

describe('scoreCompany', () => {
  it('scores deterministically out of 100', () => {
    expect(scoreCompany({
      sectors: ['Education', 'Healthcare'], geographies: ['Maharashtra'],
      spend: 45, hasDocument: true, hasContactInfo: true,
    })).toBe(66); // 4 + 2 + 25 + 20 + 15
  });
  it('scores zero with nothing found', () => {
    expect(scoreCompany({ sectors: [], geographies: [], spend: null, hasDocument: false, hasContactInfo: false })).toBe(0);
  });
  it('caps sector/geography contributions at 10 items', () => {
    const many = Array.from({ length: 20 }, (_, i) => `S${i}`);
    expect(scoreCompany({ sectors: many, geographies: many, spend: 1, hasDocument: true, hasContactInfo: true })).toBe(100);
  });
});

describe('attributeAcrossSources', () => {
  it('unions sectors and rates agreement by source count', () => {
    const r = attributeAcrossSources([
      { label: 'screener', text: 'focus on education and healthcare' },
      { label: 'indiacsr', text: 'education programs and sanitation drives' },
      { label: 'wikipedia', text: 'major education initiatives nationwide' },
    ]);
    expect(r.sectors).toEqual(expect.arrayContaining(['Education', 'Healthcare', 'Sanitation']));
    expect(r.sectorSources['Education']).toEqual(expect.arrayContaining(['screener', 'indiacsr', 'wikipedia']));
    expect(r.sectorConfidence['Education']).toBe('high');   // 3 sources
    expect(r.sectorConfidence['Healthcare']).toBe('low');   // 1 source
    expect(r.geographies).toContain('Pan-India');
  });
});

describe('supporting extractors', () => {
  it('extracts an email', () => {
    expect(extractEmail('reach us at csr@acmecorp.in today')).toBe('csr@acmecorp.in');
    expect(extractEmail('no email here')).toBeNull();
  });
  it('skips placeholder emails and returns the first real one', () => {
    expect(extractEmail('e.g. name@example.com — write to csr@acmecorp.in')).toBe('csr@acmecorp.in');
    expect(extractEmail('sample: user@company.com')).toBeNull();
  });
  it('detects NGO registrations', () => {
    const r = extractRegistrations('Registered under 12A, 80G, holds CSR-1 and FCRA');
    expect(r).toEqual(expect.arrayContaining(['12A', '80G', 'CSR-1', 'FCRA']));
  });
  it('detects proposal acceptance posture', () => {
    expect(detectAcceptsProposals('We invite proposals from NGOs')).toBe(true);
    expect(detectAcceptsProposals('We do not accept unsolicited proposals')).toBe(false);
    expect(detectAcceptsProposals('annual report summary')).toBeNull();
  });
});
