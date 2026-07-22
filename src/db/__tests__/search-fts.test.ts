// Stage 2: local FTS5 cross-entity search. Confirms the "plastic waste" → Nepra
// case from the spec, cross-entity grouping, and safe handling of junk queries.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'csr-fts-')), 'test.db');
process.env.SQLITE_PATH = tmpDb;

let db: typeof import('../index.js');

beforeAll(async () => {
  db = await import('../index.js');
  await db.runMigrations();

  await db.insertInnovator({
    name: 'Nepra Resource Management',
    domain: 'plastic',
    description: 'Dry waste management company channeling plastic and other dry waste into recycling.',
    usp: 'End-to-end dry-waste supply chain with traceable plastic credit generation.',
    geography: ['Delhi'],
  });
  await db.insertInnovator({
    name: 'Chakr Innovation',
    domain: 'air_pollution',
    description: 'Captures particulate emissions from diesel generators and converts soot into ink.',
    geography: ['Delhi'],
  });

  // A company + a scheme so we can assert cross-entity grouping.
  const coId = await db.upsertEntity({ name: 'GreenPoly Recyclers', category: 'company', status: 'stub' });
  await db.updateEntityData(coId, {
    sector_focus: { value: ['Environment'] },
    raw_notes: 'plastic waste collection and recycling operations',
  } as any);
  const schId = await db.upsertEntity({ name: 'Plastic Waste Management Scheme', category: 'govt_scheme', status: 'stub' });
  await db.updateEntityData(schId, {
    description: 'Government support for plastic waste segregation and recycling infrastructure.',
  } as any);
});

afterAll(() => {
  try { fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('searchEntities (FTS5)', () => {
  it('finds Nepra Resource Management for "plastic waste"', () => {
    const hits = db.searchEntities('plastic waste');
    const names = hits.map(h => h.name);
    expect(names).toContain('Nepra Resource Management');
    const nepra = hits.find(h => h.name === 'Nepra Resource Management');
    expect(nepra!.entity_type).toBe('innovator');
  });

  it('returns matches across all three entity types', () => {
    const hits = db.searchEntities('plastic waste');
    const types = new Set(hits.map(h => h.entity_type));
    expect(types.has('innovator')).toBe(true);
    expect(types.has('company')).toBe(true);
    expect(types.has('scheme')).toBe(true);
  });

  it('does not match unrelated innovators', () => {
    const hits = db.searchEntities('plastic waste');
    expect(hits.map(h => h.name)).not.toContain('Chakr Innovation');
  });

  it('returns nothing for a zero-coverage query (no crash)', () => {
    expect(db.searchEntities('quantumteleportation')).toHaveLength(0);
  });

  it('safely handles FTS operator characters in the query', () => {
    // Raw '"' / '*' / '(' would be an FTS syntax error if not sanitized.
    expect(() => db.searchEntities('plastic" OR (waste*')).not.toThrow();
  });

  it('returns empty for a blank query', () => {
    expect(db.searchEntities('   ')).toHaveLength(0);
  });
});
