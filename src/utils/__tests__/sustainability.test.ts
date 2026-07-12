import { describe, it, expect } from 'vitest';
import {
  detectCircularityIndicators, scoreSustainability, computeInnovatorSustainability,
} from '../sustainability.js';

describe('detectCircularityIndicators', () => {
  it('detects each indicator from text', () => {
    const r = detectCircularityIndicators('A closed-loop, zero waste process powered by renewable energy for the circular economy');
    expect(r).toEqual({ closed_loop: true, zero_waste: true, renewable_energy: true, circular_economy: true });
  });
  it('detects nothing in unrelated text', () => {
    expect(detectCircularityIndicators('quarterly revenue grew 12%'))
      .toEqual({ closed_loop: false, zero_waste: false, renewable_energy: false, circular_economy: false });
  });
});

describe('scoreSustainability', () => {
  it('scores 15 per indicator plus 4 per vocabulary hit (capped)', () => {
    const indicators = { closed_loop: true, zero_waste: false, renewable_energy: false, circular_economy: true };
    // 2 indicators = 30; vocab hits: 'emission' = 4 → 34
    expect(scoreSustainability('capturing emission from generators', indicators)).toBe(34);
  });
  it('caps at 100', () => {
    const all = { closed_loop: true, zero_waste: true, renewable_energy: true, circular_economy: true };
    const text = 'recycle upcycle sustainability carbon emission biodegradable compost green waste reduction environment';
    expect(scoreSustainability(text, all)).toBe(100);
  });
});

describe('computeInnovatorSustainability (insert-time scoring)', () => {
  it('produces a non-zero score for the Chakr-style seed data that used to show 0', () => {
    // Mirrors the Chakr Innovation seed: indicators provided, descriptive text.
    const { score } = computeInnovatorSustainability(
      'Deep-tech company capturing particulate emissions from diesel generators and converting captured soot into inks and paints. Retrofit emission-capture device — pollution control with a circular output.',
      { closed_loop: true, zero_waste: false, renewable_energy: false, circular_economy: true },
    );
    expect(score).toBeGreaterThan(0);
  });
  it('OR-merges provided indicators with text-detected ones (user claims kept)', () => {
    const { indicators } = computeInnovatorSustainability(
      'zero waste production line', { closed_loop: true });
    expect(indicators.closed_loop).toBe(true);   // provided
    expect(indicators.zero_waste).toBe(true);    // detected
  });
  it('scores 0 only when there is genuinely no signal', () => {
    const { score } = computeInnovatorSustainability('b2b saas analytics platform', null);
    expect(score).toBe(0);
  });
});
