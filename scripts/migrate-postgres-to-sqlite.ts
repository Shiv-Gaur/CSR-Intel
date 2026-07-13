// ONE-TIME data migration: Postgres (docker csr-postgres) → SQLite file.
// Reads every row from every table and inserts it into the SQLite DB created
// by runMigrations(). Postgres is only READ — nothing is modified there.
//
// Run:  npx tsx scripts/migrate-postgres-to-sqlite.ts
// Note: requires the `pg` package; after the migration pg was removed from
// package.json, so re-running later needs `npm i pg` first.
import 'dotenv/config';
import pg from 'pg';
import { runMigrations } from '../src/db/index.js';
import { getDb, closeDb } from '../src/db/sqlite.js';
import { logger } from '../src/utils/logger.js';

const { Client } = pg;

// Value conversion pg → SQLite storage:
//  - objects/arrays (jsonb, text[]) → JSON text
//  - Date → ISO-8601 UTC text
//  - boolean → 0/1
//  - NUMERIC comes back from pg as string → Number
const NUMERIC_COLS = new Set(['annual_revenue_cr', 'funding_raised_cr']);

function convert(col: string, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Array.isArray(v) || typeof v === 'object') return JSON.stringify(v);
  if (NUMERIC_COLS.has(col) && typeof v === 'string') return Number(v);
  return v;
}

const TABLES = ['entities', 'change_history', 'task_queue', 'human_review_queue', 'match_profile', 'innovators'];

async function main(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  await runMigrations(); // create SQLite schema
  const db = getDb();

  const existing = (db.prepare('SELECT COUNT(*) AS n FROM entities').get() as any).n;
  if (existing > 0 && !process.argv.includes('--force')) {
    logger.error('Target SQLite DB already has entities — aborting (pass --force to wipe and re-import)');
    process.exit(1);
  }
  if (existing > 0) {
    for (const t of [...TABLES].reverse()) db.prepare(`DELETE FROM ${t}`).run();
    logger.warn('Wiped existing SQLite rows (--force)');
  }

  const counts: Record<string, { pg: number; sqlite: number }> = {};
  db.pragma('foreign_keys = OFF'); // rows arrive in bulk; FK order not guaranteed within tables

  for (const table of TABLES) {
    const { rows } = await client.query(`SELECT * FROM ${table}`);
    if (!rows.length) { counts[table] = { pg: 0, sqlite: 0 }; continue; }
    const cols = Object.keys(rows[0]);
    const stmt = db.prepare(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
    const insertAll = db.transaction((rs: any[]) => {
      for (const r of rs) stmt.run(cols.map(c => convert(c, r[c])));
    });
    insertAll(rows);
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n;
    counts[table] = { pg: rows.length, sqlite: n };
    logger.info(`Migrated ${table}`, counts[table]);
  }

  db.pragma('foreign_keys = ON');
  await client.end();

  let mismatch = false;
  for (const [t, c] of Object.entries(counts)) {
    if (c.pg !== c.sqlite) { mismatch = true; logger.error(`ROW COUNT MISMATCH in ${t}`, c); }
  }
  logger.info(mismatch ? 'MIGRATION FINISHED WITH MISMATCHES — do not delete Postgres' : 'Migration complete — all row counts match', counts);
  closeDb();
  process.exit(mismatch ? 1 : 0);
}

main().catch(err => { logger.error('Migration failed', { error: err.message, stack: err.stack }); process.exit(1); });
