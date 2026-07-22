// Regression test for the `--entity-id` scoping bug: the CLI enqueued the
// target entity at priority 1 and then called runEnrichmentAgent(), which
// drains the ENTIRE pending queue — 22 entities were rewritten across two runs
// when 2 were expected (2026-07-19). The CLI now claims a task scoped to one
// entity and exits; this test pins the claim behaviour that makes that safe.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'csr-claim-')), 'test.db');
process.env.SQLITE_PATH = tmpDb;

let db: typeof import('../index.js');

beforeAll(async () => {
  db = await import('../index.js');
  await db.runMigrations();
});

afterAll(() => {
  try { fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('claimNextTaskForEntity', () => {
  it('claims only the target entity, leaving the backlog untouched', async () => {
    // A backlog that predates the target and would be claimed first by priority.
    const backlogA = await db.upsertEntity({ name: 'Backlog Co A', category: 'company', status: 'stub' });
    const backlogB = await db.upsertEntity({ name: 'Backlog Co B', category: 'company', status: 'stub' });
    const target   = await db.upsertEntity({ name: 'Target Co',    category: 'company', status: 'stub' });

    for (const [id, name] of [[backlogA, 'Backlog Co A'], [backlogB, 'Backlog Co B']] as const) {
      await db.enqueueTask({ type: 'enrich', entity_id: id, entity_name: name, priority: 1, payload: {}, max_attempts: 1 });
    }
    await db.enqueueTask({ type: 'enrich', entity_id: target, entity_name: 'Target Co', priority: 1, payload: {}, max_attempts: 1 });

    const claimed = await db.claimNextTaskForEntity('enrich', target);
    expect(claimed).not.toBeNull();
    expect(claimed!.entity_id).toBe(target);

    // The backlog must still be pending — an unscoped claim would have taken
    // Backlog Co A first, since it shares priority 1 and was created earlier.
    const { rows } = await db.getPool().query(
      `SELECT entity_name, status FROM task_queue WHERE type = 'enrich' ORDER BY created_at`);
    const byName = Object.fromEntries(rows.map((r: any) => [r.entity_name, r.status]));
    expect(byName['Backlog Co A']).toBe('pending');
    expect(byName['Backlog Co B']).toBe('pending');
    expect(byName['Target Co']).toBe('running');

    // Exactly one task left the pending pool.
    expect(rows.filter((r: any) => r.status === 'pending')).toHaveLength(2);
  });

  it('returns null when the entity has no pending task, rather than claiming someone else\'s', async () => {
    const lonely = await db.upsertEntity({ name: 'No Task Co', category: 'company', status: 'stub' });
    const before = await db.getPool().query(`SELECT COUNT(*) AS n FROM task_queue WHERE status = 'pending'`);
    expect(await db.claimNextTaskForEntity('enrich', lonely)).toBeNull();
    const after = await db.getPool().query(`SELECT COUNT(*) AS n FROM task_queue WHERE status = 'pending'`);
    expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n));
  });
});
