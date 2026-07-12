import { describe, it, expect } from 'vitest';
import { extractCompanyNames } from '../ner.js';

describe('extractCompanyNames', () => {
  it('extracts names ending in company suffixes', () => {
    const r = extractCompanyNames(
      'Reliance Industries Limited partnered with Tata Motors and the Infosys Foundation on a project.'
    );
    expect(r).toEqual(expect.arrayContaining(['Reliance Industries Limited', 'Tata Motors', 'Infosys Foundation']));
  });

  it('de-duplicates case-insensitively', () => {
    const r = extractCompanyNames('Wipro Ltd and WIPRO LTD and Wipro Ltd again');
    expect(r.filter(n => /wipro/i.test(n)).length).toBe(1);
  });

  it('strips leading filler words', () => {
    const r = extractCompanyNames('Youth Placed Under SBI Foundation programs');
    expect(r).toContain('SBI Foundation');
  });

  it('returns empty when no company-like names', () => {
    expect(extractCompanyNames('the quick brown fox runs daily')).toEqual([]);
  });
});
