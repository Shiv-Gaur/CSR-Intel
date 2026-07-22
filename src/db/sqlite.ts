/**
 * SQLite connection layer — replaces the pg Pool (migrated 2026-07-13).
 *
 * better-sqlite3 is synchronous and handles its own locking, so there is no
 * pool: one Database instance serves the whole process (dashboard + workers
 * already share a process). WAL mode keeps readers unblocked during writes.
 *
 * Compatibility: `query(text, params)` mimics pg's `pool.query` shape
 * ({ rows, rowCount }) so the ~80 existing call sites keep their structure;
 * only the SQL dialect differences (json ops, intervals, arrays) were
 * rewritten at each site. The translator below handles the mechanical bits:
 *   - $1..$N placeholders → named @p1..@pN bindings
 *   - NOW()              → strftime('%Y-%m-%dT%H:%M:%fZ','now')  (ISO-8601 UTC,
 *                          same format JS toISOString() writes, so string
 *                          comparison/ordering across both is consistent)
 *   - TRUE/FALSE         → 1/0
 * Parameter values are converted centrally: arrays/objects → JSON text,
 * booleans → 0/1, Date → ISO string. Reads deserialize known JSON columns
 * (the old JSONB/TEXT[] columns) back to JS values by column name.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

let db: Database.Database | null = null;

/** ISO-8601 UTC "now" with millisecond precision — matches JS toISOString(). */
export const SQL_NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

export function uuid(): string {
  return randomUUID();
}

export function getDb(): Database.Database {
  if (!db) {
    const file = path.resolve(config.sqlitePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
  }
  return db;
}

// Columns that held JSONB or TEXT[] in Postgres — stored as JSON text in
// SQLite and (de)serialized here at the boundary, in ONE place.
const JSON_COLUMNS = new Set([
  // entities
  'name_aliases', 'data', 'source_urls', 'missing_fields', 'conflict_log', 'drift_scores',
  // task_queue / human_review_queue / change_history
  'payload', 'details', 'old_value', 'new_value',
  // match_profile
  'technologies', 'target_sectors', 'target_geographies', 'keywords',
  // innovators
  'geography', 'circularity_indicators', 'mou_history', 'key_contacts',
  'govt_mission_alignment', 'subsidy_land_electricity',
  // search index
  'search_meta',
]);

function toParamValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v) || (typeof v === 'object')) return JSON.stringify(v);
  return v;
}

function deserializeRow(row: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(row)) {
    const v = row[key];
    if (JSON_COLUMNS.has(key) && typeof v === 'string' && v.length && (v[0] === '{' || v[0] === '[')) {
      try { row[key] = JSON.parse(v); } catch { /* leave as text */ }
    }
  }
  return row;
}

/** Mechanical pg→SQLite SQL translation (dialect rewrites happen at call sites). */
function translate(text: string): string {
  return text
    .replace(/\$(\d+)/g, '@p$1')
    .replace(/\bNOW\(\)/g, SQL_NOW)
    .replace(/\bTRUE\b/g, '1')
    .replace(/\bFALSE\b/g, '0');
}

export interface QueryResult {
  rows: any[];
  rowCount: number;
}

/** pg-shaped query executor. Synchronous under the hood; callers may await it. */
export function query(text: string, params: unknown[] = []): QueryResult {
  const stmt = getDb().prepare(translate(text));
  const bound: Record<string, unknown> = {};
  params.forEach((p, i) => { bound[`p${i + 1}`] = toParamValue(p); });
  if (stmt.reader) {
    const rows = (params.length ? stmt.all(bound) : stmt.all()).map(r => deserializeRow(r as Record<string, unknown>));
    return { rows, rowCount: rows.length };
  }
  const info = params.length ? stmt.run(bound) : stmt.run();
  return { rows: [], rowCount: info.changes };
}

/** Run `fn` inside a transaction (replaces BEGIN/COMMIT/ROLLBACK client flows). */
export function transaction<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}

export function closeDb(): void {
  if (db) { db.close(); db = null; }
}
