import { describe, it, expect } from 'vitest';
import { scoreFieldConfidence, scoreEntityConfidence } from '../confidence-scorer.js';

describe('Confidence Scorer', () => {
  it('should score fields with single source correctly', () => {
    const result = scoreFieldConfidence('csr_spend_cr', [
      { value: 100, source: 'sourceA', confidence: 'medium' }
    ]);
    expect(result.agreedValue).toBe(100);
    expect(result.confidence).toBe('medium');
    expect(result.conflict).toBe(false);
  });

  it('should score string field agreement correctly', () => {
    const result = scoreFieldConfidence('name', [
      { value: 'Tata Consultancy Services', source: 'sourceA', confidence: 'medium' },
      { value: ' tata consultancy services ', source: 'sourceB', confidence: 'low' }
    ]);
    expect(result.agreedValue).toBe('Tata Consultancy Services');
    expect(result.confidence).toBe('high');
    expect(result.conflict).toBe(false);
  });

  it('should score numeric field agreement with 10% tolerance', () => {
    const resultAgree = scoreFieldConfidence('csr_spend_cr', [
      { value: 100, source: 'sourceA', confidence: 'medium' },
      { value: 105, source: 'sourceB', confidence: 'low' }
    ]);
    expect(resultAgree.confidence).toBe('high');
    expect(resultAgree.conflict).toBe(false);

    const resultDisagree = scoreFieldConfidence('csr_spend_cr', [
      { value: 100, source: 'sourceA', confidence: 'medium' },
      { value: 120, source: 'sourceB', confidence: 'low' }
    ]);
    expect(resultDisagree.confidence).toBe('low');
    expect(resultDisagree.conflict).toBe(true);
  });

  it('should score array field agreement with 60% overlap tolerance', () => {
    const resultAgree = scoreFieldConfidence('sector_focus', [
      { value: ['Education', 'Health', 'Environment'], source: 'sourceA', confidence: 'medium' },
      { value: ['Education', 'Health', 'Skilling'], source: 'sourceB', confidence: 'low' }
    ]);
    // Union = 4 (Edu, Health, Env, Skill), Intersection = 2 (Edu, Health) -> overlap = 2/4 = 50%
    // 50% < 60% -> conflict
    expect(resultAgree.conflict).toBe(true);

    const resultAgreeHigh = scoreFieldConfidence('sector_focus', [
      { value: ['Education', 'Health', 'Environment', 'Skilling'], source: 'sourceA', confidence: 'medium' },
      { value: ['Education', 'Health', 'Environment'], source: 'sourceB', confidence: 'low' }
    ]);
    // Union = 4, Intersection = 3 -> overlap = 3/4 = 75% >= 60% -> match!
    expect(resultAgreeHigh.conflict).toBe(false);
    expect(resultAgreeHigh.confidence).toBe('high');
  });

  it('should score overall entity confidence correctly', () => {
    const entityScore = scoreEntityConfidence({
      field1: 'high',
      field2: 'high',
      field3: 'high',
      field4: 'high',
      field5: 'medium',
      field6: 'low',
    });
    // total = 6, high = 4 (67% < 70%), low = 1 -> overall should be medium
    expect(entityScore.overall).toBe('medium');
    expect(entityScore.completeness).toBeCloseTo(5/6);
  });
});
