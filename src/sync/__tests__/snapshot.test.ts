// Snapshot export/import sync. The critical guarantee under test is that an
// import NEVER silently overwrites local data: existing-but-different records
// must surface as conflicts and stay untouched until applyResolutions() runs.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'csr-snap-')), 'test.db');
process.env.SQLITE_PATH = tmpDb;

let db: typeof import('../../db/index.js');
let sqlite: typeof import('../../db/sqlite.js');
let snap: typeof import('../snapshot.js');

beforeAll(async () => {
  db = await import('../../db/index.js');
  sqlite = await import('../../db/sqlite.js');
  snap = await import('../snapshot.js');
  await db.runMigrations();
});

afterAll(() => {
  try { sqlite.closeDb(); } catch { /* best effort */ }
  try { fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true }); } catch { /* best effort */ }
});

// Each test starts from a known, empty-ish DB.
beforeEach(() => {
  sqlite.query('DELETE FROM entities');
  sqlite.query('DELETE FROM innovators');
});

const APP_MAJOR = snapVersionMajor();
function snapVersionMajor(): string {
  // package.json version is read by getAppVersion(); keep test snapshots on the
  // same major so the compatibility gate passes.
  const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
  return String(pkg.version);
}

function validSnapshot(over: Partial<import('../snapshot.js').Snapshot> = {}) {
  return {
    format: 'csr-intel-snapshot',
    schema_version: 1,
    app_version: APP_MAJOR,
    exported_at: '2026-07-28T10:00:00.000Z',
    counts: { companies: 0, schemes: 0, innovators: 0 },
    companies: [],
    schemes: [],
    innovators: [],
    ...over,
  };
}

describe('buildSnapshot', () => {
  it('returns the expected envelope and splits companies from schemes', async () => {
    await db.upsertEntity({ name: 'Acme Corp', category: 'company', status: 'stub' });
    await db.upsertEntity({ name: 'Beta Foundation', category: 'foundation', status: 'stub' });
    await db.upsertEntity({ name: 'PM Awas Yojana', category: 'govt_scheme', status: 'stub' });
    await db.insertInnovator({ name: 'Chakr Innovation', domain: 'air_pollution' });

    const s = snap.buildSnapshot();

    expect(s.format).toBe('csr-intel-snapshot');
    expect(s.schema_version).toBe(1);
    expect(s.app_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(new Date(s.exported_at).toString()).not.toBe('Invalid Date');

    // govt_scheme goes to schemes; every other category is a company.
    expect(s.companies.map(c => c.name).sort()).toEqual(['Acme Corp', 'Beta Foundation']);
    expect(s.schemes.map(c => c.name)).toEqual(['PM Awas Yojana']);
    expect(s.innovators.map(c => c.name)).toEqual(['Chakr Innovation']);

    // counts must agree with the arrays they describe.
    expect(s.counts).toEqual({ companies: 2, schemes: 1, innovators: 1 });
  });

  it('produces a JSON-serialisable snapshot of an empty DB', () => {
    const s = snap.buildSnapshot();
    expect(s.counts).toEqual({ companies: 0, schemes: 0, innovators: 0 });
    expect(() => JSON.parse(JSON.stringify(s))).not.toThrow();
  });

  it('suggests a dated .json filename', () => {
    expect(snap.suggestedFilename()).toMatch(/^csr-intel-snapshot-\d{4}-\d{2}-\d{2}\.json$/);
  });
});

describe('parseSnapshot validation', () => {
  it('accepts a well-formed snapshot', () => {
    const parsed = snap.parseSnapshot(JSON.stringify(validSnapshot()));
    expect(parsed.format).toBe('csr-intel-snapshot');
  });

  it('rejects non-JSON input', () => {
    expect(() => snap.parseSnapshot('not json at all')).toThrow(snap.SnapshotError);
    expect(() => snap.parseSnapshot('not json at all')).toThrow(/valid JSON/i);
  });

  it('rejects JSON that is not an object', () => {
    expect(() => snap.parseSnapshot('[1,2,3]')).toThrow(/not a snapshot object/i);
    expect(() => snap.parseSnapshot('"hello"')).toThrow(/not a snapshot object/i);
  });

  it('rejects a file with the wrong format marker', () => {
    const bad = JSON.stringify(validSnapshot({ format: 'some-other-tool' } as any));
    expect(() => snap.parseSnapshot(bad)).toThrow(/not a CSR Intelligence snapshot/i);
  });

  it('rejects a snapshot from a newer schema version', () => {
    const bad = JSON.stringify(validSnapshot({ schema_version: 99 } as any));
    expect(() => snap.parseSnapshot(bad)).toThrow(/newer than this app supports/i);
  });

  it('rejects a snapshot from an incompatible app major version', () => {
    const bad = JSON.stringify(validSnapshot({ app_version: '99.0.0' } as any));
    expect(() => snap.parseSnapshot(bad)).toThrow(/incompatible app version/i);
  });

  it('rejects a snapshot missing an entity list', () => {
    const obj: any = validSnapshot();
    delete obj.innovators;
    expect(() => snap.parseSnapshot(JSON.stringify(obj))).toThrow(/invalid "innovators" list/i);
  });

  it('rejects a record with no usable name', () => {
    const bad = JSON.stringify(validSnapshot({ companies: [{ cin: 'X' }] as any }));
    expect(() => snap.parseSnapshot(bad)).toThrow(/missing a name/i);
    const blank = JSON.stringify(validSnapshot({ companies: [{ name: '   ' }] as any }));
    expect(() => snap.parseSnapshot(blank)).toThrow(/missing a name/i);
  });
});

describe('importSnapshot diffing', () => {
  it('inserts records that do not exist locally', () => {
    const s = snap.parseSnapshot(JSON.stringify(validSnapshot({
      companies: [{ name: 'New Co', category: 'company', status: 'stub', priority: 2 }],
      schemes: [{ name: 'New Scheme', category: 'govt_scheme', status: 'stub' }],
      innovators: [{ name: 'New Innovator', domain: 'plastic', type: 'startup' }],
    } as any)));

    const result = snap.importSnapshot(s);

    expect(result.added).toEqual({ companies: 1, schemes: 1, innovators: 1 });
    expect(result.upToDate).toBe(0);
    expect(result.conflicts).toHaveLength(0);

    const rows = sqlite.query('SELECT name, category, priority FROM entities ORDER BY name').rows;
    expect(rows.map((r: any) => r.name)).toEqual(['New Co', 'New Scheme']);
    expect(rows.find((r: any) => r.name === 'New Co').priority).toBe(2);
    expect(sqlite.query('SELECT name FROM innovators').rows[0].name).toBe('New Innovator');
  });

  it('counts identical records as up to date and does not duplicate them', async () => {
    await db.upsertEntity({ name: 'Acme Corp', category: 'company', status: 'stub' });
    const exported = snap.buildSnapshot();

    const result = snap.importSnapshot(snap.parseSnapshot(JSON.stringify(exported)));

    expect(result.added.companies).toBe(0);
    expect(result.upToDate).toBe(1);
    expect(result.conflicts).toHaveLength(0);
    expect(sqlite.query('SELECT COUNT(*) AS n FROM entities').rows[0].n).toBe(1);
  });

  it('reports a conflict WITHOUT touching local data when a record differs', async () => {
    const id = await db.upsertEntity({ name: 'Acme Corp', category: 'company', status: 'stub' });
    await db.updateEntityData(id, { sector_focus: { value: ['Education'] } } as any);
    sqlite.query('UPDATE entities SET priority = 4 WHERE id = $1', [id]);

    const s = snap.parseSnapshot(JSON.stringify(validSnapshot({
      companies: [{ name: 'Acme Corp', category: 'company', status: 'enriched', priority: 1 }],
    } as any)));
    const result = snap.importSnapshot(s);

    expect(result.added.companies).toBe(0);
    expect(result.upToDate).toBe(0);
    expect(result.conflicts).toHaveLength(1);

    const c = result.conflicts[0];
    expect(c.type).toBe('company');
    expect(c.name).toBe('Acme Corp');
    const fields = c.diffs.map(d => d.field);
    expect(fields).toContain('status');
    expect(fields).toContain('priority');
    const prio = c.diffs.find(d => d.field === 'priority')!;
    expect(prio.local).toBe('4');
    expect(prio.imported).toBe('1');

    // The local row must be exactly as it was.
    const row: any = sqlite.query('SELECT status, priority, data FROM entities WHERE id = $1', [id]).rows[0];
    expect(row.status).toBe('stub');
    expect(row.priority).toBe(4);
    expect(row.data.sector_focus.value).toEqual(['Education']);
  });

  it('surfaces per-key differences inside the data blob', async () => {
    const id = await db.upsertEntity({ name: 'Acme Corp', category: 'company', status: 'stub' });
    await db.updateEntityData(id, { website: 'https://old.example' } as any);

    const s = snap.parseSnapshot(JSON.stringify(validSnapshot({
      companies: [{ name: 'Acme Corp', category: 'company', status: 'stub', priority: 4,
        data: { website: 'https://new.example' } }],
    } as any)));
    const result = snap.importSnapshot(s);

    expect(result.conflicts).toHaveLength(1);
    const diff = result.conflicts[0].diffs.find(d => d.field === 'data.website')!;
    expect(diff.local).toBe('https://old.example');
    expect(diff.imported).toBe('https://new.example');
  });

  it('matches names case- and whitespace-insensitively', async () => {
    await db.upsertEntity({ name: 'Acme Corp', category: 'company', status: 'stub' });
    const s = snap.parseSnapshot(JSON.stringify(validSnapshot({
      companies: [{ name: '  acme corp  ', category: 'company', status: 'enriched' }],
    } as any)));

    const result = snap.importSnapshot(s);

    // Recognised as the same record — a conflict, not a second insert.
    expect(result.added.companies).toBe(0);
    expect(result.conflicts).toHaveLength(1);
    expect(sqlite.query('SELECT COUNT(*) AS n FROM entities').rows[0].n).toBe(1);
  });

  it('detects conflicting innovators on innovator-specific fields', async () => {
    await db.insertInnovator({ name: 'Chakr Innovation', domain: 'air_pollution', trl_current: 6 });
    const s = snap.parseSnapshot(JSON.stringify(validSnapshot({
      innovators: [{ name: 'Chakr Innovation', domain: 'air_pollution', trl_current: 9 }],
    } as any)));

    const result = snap.importSnapshot(s);

    expect(result.added.innovators).toBe(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].type).toBe('innovator');
    expect(result.conflicts[0].diffs.map(d => d.field)).toContain('trl_current');
  });

  it('handles a mixed snapshot: new + identical + conflicting together', async () => {
    await db.upsertEntity({ name: 'Same Co', category: 'company', status: 'stub' });
    await db.upsertEntity({ name: 'Differs Co', category: 'company', status: 'stub' });
    const exported = snap.buildSnapshot();
    const same = exported.companies.find(c => c.name === 'Same Co');
    const differs = { ...exported.companies.find(c => c.name === 'Differs Co'), status: 'enriched' };

    const s = snap.parseSnapshot(JSON.stringify(validSnapshot({
      companies: [same, differs, { name: 'Brand New Co', category: 'company', status: 'stub' }],
    } as any)));
    const result = snap.importSnapshot(s);

    expect(result.added.companies).toBe(1);
    expect(result.upToDate).toBe(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].name).toBe('Differs Co');
    expect(result.snapshot.exported_at).toBe('2026-07-28T10:00:00.000Z');
  });
});

describe('applyResolutions', () => {
  it('overwrites only the records the user chose', async () => {
    const keepId = await db.upsertEntity({ name: 'Keep Co', category: 'company', status: 'stub' });
    const useId = await db.upsertEntity({ name: 'Use Co', category: 'company', status: 'stub' });

    const s = snap.parseSnapshot(JSON.stringify(validSnapshot({
      companies: [
        { name: 'Keep Co', category: 'company', status: 'enriched', priority: 1 },
        { name: 'Use Co', category: 'company', status: 'enriched', priority: 1 },
      ],
    } as any)));
    const result = snap.importSnapshot(s);
    expect(result.conflicts).toHaveLength(2);

    // Only "Use Co" is resolved as use-imported; "Keep Co" is never sent.
    const chosen = result.conflicts
      .filter(c => c.name === 'Use Co')
      .map(c => ({ type: c.type, name: c.name, imported: c.imported }));
    const applied = snap.applyResolutions(chosen);

    expect(applied.applied).toBe(1);
    const keep: any = sqlite.query('SELECT status, priority FROM entities WHERE id = $1', [keepId]).rows[0];
    const use: any = sqlite.query('SELECT status, priority FROM entities WHERE id = $1', [useId]).rows[0];
    expect(keep.status).toBe('stub');
    expect(keep.priority).toBe(4);
    expect(use.status).toBe('enriched');
    expect(use.priority).toBe(1);
  });

  it('updates in place — never inserts a duplicate row', async () => {
    await db.upsertEntity({ name: 'Acme Corp', category: 'company', status: 'stub' });
    const applied = snap.applyResolutions([
      { type: 'company', name: 'Acme Corp', imported: { name: 'Acme Corp', category: 'company', status: 'enriched' } },
    ]);
    expect(applied.applied).toBe(1);
    expect(sqlite.query('SELECT COUNT(*) AS n FROM entities').rows[0].n).toBe(1);
  });

  it('applies innovator resolutions to innovator-specific columns', async () => {
    await db.insertInnovator({ name: 'Chakr Innovation', domain: 'air_pollution', trl_current: 6 });
    snap.applyResolutions([
      { type: 'innovator', name: 'Chakr Innovation',
        imported: { name: 'Chakr Innovation', domain: 'air_pollution', trl_current: 9, usp: 'soot to ink' } },
    ]);
    const row: any = sqlite.query('SELECT trl_current, usp FROM innovators WHERE name = $1', ['Chakr Innovation']).rows[0];
    expect(row.trl_current).toBe(9);
    expect(row.usp).toBe('soot to ink');
  });

  it('ignores malformed resolution entries instead of throwing', () => {
    const applied = snap.applyResolutions([
      null as any,
      { type: 'company', name: '', imported: {} } as any,
      { type: 'company', name: 'Ghost Co', imported: null } as any,
    ]);
    expect(applied.applied).toBe(0);
  });

  it('is a no-op for an empty resolution list', () => {
    expect(snap.applyResolutions([]).applied).toBe(0);
  });
});
