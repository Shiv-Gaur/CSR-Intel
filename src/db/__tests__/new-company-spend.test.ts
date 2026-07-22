// Regression test for the fabricated-spend incident (44.44 Cr appearing on
// unrelated and even brand-new companies): a newly created company that has
// never been enriched must carry NO csr_spend_cr value — null/absent, never a
// number. The bug class this guards: defaults/fixtures/boilerplate leaking a
// numeric spend into rows that have no real extracted data.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'csr-test-')), 'test.db');
process.env.SQLITE_PATH = tmpDb;

// Imported AFTER SQLITE_PATH is set — config reads the env var at import time.
let db: typeof import('../index.js');

beforeAll(async () => {
  db = await import('../index.js');
  await db.runMigrations();
});

afterAll(() => {
  try { fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('newly created company (no enrichment)', () => {
  it('has no csr_spend_cr value — null, never a fabricated number', async () => {
    const id = await db.upsertEntity({ name: 'Brand New Test Co', category: 'company', status: 'stub' });
    const entity = await db.getEntityById(id);
    expect(entity).not.toBeNull();
    const spendField = (entity as any).csr_spend_cr;
    // Field may be absent entirely, or present with a null/empty value — but a
    // numeric spend on a never-enriched company is fabrication by definition.
    const latest = spendField?.value?.latest ?? spendField?.value ?? null;
    expect(latest).toBeNull();
    expect((entity as any).estimated_spend_cr?.value ?? null).toBeNull();
  });

  it('countEntitiesWithSpendValue counts only entities carrying that exact figure', async () => {
    const a = await db.upsertEntity({ name: 'Dup Spend Co A', category: 'company', status: 'stub' });
    const b = await db.upsertEntity({ name: 'Dup Spend Co B', category: 'company', status: 'stub' });
    const c = await db.upsertEntity({ name: 'Dup Spend Co C', category: 'company', status: 'stub' });
    for (const id of [a, b]) {
      await db.updateEntityData(id, {
        csr_spend_cr: { value: { latest: 44.44 }, confidence: 'medium', source_url: 'https://example.test', extracted_at: new Date().toISOString() },
      });
    }
    expect(await db.countEntitiesWithSpendValue(44.44, c)).toBe(2);
    expect(await db.countEntitiesWithSpendValue(44.44, a)).toBe(1); // excludes itself
    expect(await db.countEntitiesWithSpendValue(99.99, c)).toBe(0);
  });
});
