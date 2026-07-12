import { describe, it, expect } from 'vitest';
import { computeProfileMatch } from '../match.js';

const profile = {
  technologies: ['IoT', 'AI/ML'],
  target_sectors: ['Education', 'Healthcare'],
  target_geographies: ['Maharashtra', 'Karnataka'],
  keywords: ['rural'],
};

describe('computeProfileMatch', () => {
  it('adds graded points and explains each match', () => {
    const r = computeProfileMatch(
      { sectors: ['Education', 'Sports'], geographies: ['Maharashtra'], description: 'rural IoT deployment' },
      profile,
    );
    // sector: Education at rank 0 → 12; geo: Maharashtra at rank 0 → 13;
    // keyword: rural → 7; tech: IoT → 10; affinity: education-vocab hits in text = 0
    expect(r.score).toBe(42);
    expect(r.reasons.some(x => x.startsWith('Sector match'))).toBe(true);
    expect(r.reasons.some(x => x.startsWith('Technology match'))).toBe(true);
  });

  it('scores a match on the company\'s #1 sector higher than on a minor sector', () => {
    const focused = computeProfileMatch(
      { sectors: ['Education'], geographies: [], description: '' }, profile);
    const diluted = computeProfileMatch(
      { sectors: ['Sports', 'Arts', 'Sanitation', 'Environment', 'Education'], geographies: [], description: '' }, profile);
    expect(focused.score).toBeGreaterThan(diluted.score);
    expect(diluted.score).toBeGreaterThan(0);
  });

  it('scores broader profile coverage higher (two target sectors beat one)', () => {
    const one = computeProfileMatch(
      { sectors: ['Education'], geographies: [], description: '' }, profile);
    const two = computeProfileMatch(
      { sectors: ['Education', 'Healthcare'], geographies: [], description: '' }, profile);
    expect(two.score).toBeGreaterThan(one.score);
  });

  it('is case-insensitive and partial', () => {
    const r = computeProfileMatch(
      { sectors: ['healthcare'], geographies: ['Goa'], description: 'no relevant words' },
      profile,
    );
    expect(r.score).toBe(12); // healthcare at rank 0 → 12, nothing else
    expect(r.reasons).toHaveLength(1);
  });

  it('gives pan-india partial geography credit graded by footprint breadth', () => {
    const narrow = computeProfileMatch(
      { sectors: [], geographies: ['Pan-India'], description: '' }, profile);
    const broad = computeProfileMatch(
      { sectors: [], geographies: ['Goa', 'Bihar', 'Assam', 'Punjab', 'Odisha', 'Pan-India'], description: '' }, profile);
    expect(narrow.score).toBe(7);   // 6 + 1
    expect(broad.score).toBe(12);   // 6 + 6 (capped)
    expect(broad.score).toBeGreaterThan(narrow.score);
  });

  it('returns 0 with no overlap', () => {
    const r = computeProfileMatch(
      { sectors: ['Sports'], geographies: ['Goa'], description: 'nothing here' },
      profile,
    );
    expect(r.score).toBe(0);
    expect(r.reasons).toEqual([]);
  });

  it('caps the total at 100', () => {
    const r = computeProfileMatch(
      {
        sectors: ['Education', 'Healthcare'],
        geographies: ['Maharashtra', 'Karnataka'],
        description: 'rural rural rural IoT AI/ML education school healthcare hospital Maharashtra Karnataka ' +
          'education school student healthcare hospital clinic',
      },
      profile,
    );
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.score).toBeGreaterThan(60);
  });
});
