import { describe, it, expect } from 'vitest';
import { inferTRL } from '../trl.js';

describe('inferTRL', () => {
  it('maps research/pilot language to TRL 1-3', () => {
    const r = inferTRL('We fund early-stage research and prototype pilots in rural schools');
    expect(r.band).toBe('research');
    expect(r.min).toBe(1); expect(r.max).toBe(3);
    expect(r.label).toContain('Research');
  });
  it('maps demonstration/trial language to TRL 4-6', () => {
    const r = inferTRL('Field demonstration and validation trials of the device');
    expect(r.band).toBe('development');
    expect(r.min).toBe(4); expect(r.max).toBe(6);
  });
  it('maps deployment/scale language to TRL 7-9', () => {
    const r = inferTRL('Large-scale deployment and implementation across districts at scale');
    expect(r.band).toBe('deployment');
    expect(r.min).toBe(7); expect(r.max).toBe(9);
  });
  it('returns unknown when no readiness signal present', () => {
    const r = inferTRL('A company that makes paints and chemicals');
    expect(r.band).toBe('unknown');
    expect(r.min).toBe(0);
  });
  it('handles empty input', () => {
    expect(inferTRL('').band).toBe('unknown');
    expect(inferTRL(null).band).toBe('unknown');
  });
});
