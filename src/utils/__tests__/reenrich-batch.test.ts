import { describe, it, expect } from 'vitest';
import { createCompanyBatch, getBatch, startInnovatorBatch, batchTiming } from '../reenrich-batch.js';

describe('batchTiming', () => {
  it('returns null avg/estimate before anything completes', () => {
    const t = batchTiming(Date.now() - 10_000, 0, 173);
    expect(t.elapsed_seconds).toBe(10);
    expect(t.avg_seconds_per_company).toBeNull();
    expect(t.estimated_seconds_remaining).toBeNull();
  });

  it('computes running average and remaining estimate', () => {
    // 5 done in 100s → 20s avg → 10 remaining ≈ 200s
    const t = batchTiming(Date.now() - 100_000, 5, 10);
    expect(t.elapsed_seconds).toBe(100);
    expect(t.avg_seconds_per_company).toBeCloseTo(20, 0);
    expect(t.estimated_seconds_remaining).toBeCloseTo(200, -1);
  });

  it('freezes elapsed at finishedAt for completed batches', () => {
    const created = Date.now() - 500_000;
    const finished = created + 60_000;
    const t = batchTiming(created, 6, 0, finished);
    expect(t.elapsed_seconds).toBe(60);
    expect(t.avg_seconds_per_company).toBe(10);
    expect(t.estimated_seconds_remaining).toBe(0);
  });
});

describe('createCompanyBatch / getBatch', () => {
  it('stores task ids and total, retrievable by id', () => {
    const b = createCompanyBatch(['a', 'b', 'c']);
    expect(b.total).toBe(3);
    const got = getBatch(b.id);
    expect(got).not.toBeNull();
    expect(got!.kind).toBe('company');
  });

  it('returns null for unknown ids', () => {
    expect(getBatch('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe('startInnovatorBatch', () => {
  it('runs items sequentially and counts done/failed', async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const enrich = async (id: string): Promise<boolean> => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 5));
      order.push(id);
      active--;
      if (id === 'bad') throw new Error('boom');
      return true;
    };
    const b = startInnovatorBatch(
      [{ id: 'x', name: 'X' }, { id: 'bad', name: 'Bad' }, { id: 'y', name: 'Y' }],
      enrich,
    );
    expect(b.total).toBe(3);
    // Wait for the internal queue to drain (finishedAt is set on idle).
    await new Promise<void>(resolve => {
      const check = () => (b.finishedAt ? resolve() : setTimeout(check, 10));
      check();
    });
    expect(order).toEqual(['x', 'bad', 'y']); // sequential, in submission order
    expect(maxActive).toBe(1);                // concurrency 1 — never parallel
    expect(b.done).toBe(2);
    expect(b.failed).toBe(1);
    expect(b.currentName).toBeNull();
  });
});
