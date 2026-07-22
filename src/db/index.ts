import { getDb, query as sqliteQuery, transaction, uuid, closeDb, SQL_NOW, type QueryResult } from './sqlite.js';
import { logger } from '../utils/logger.js';
import { computeProfileMatch } from '../utils/match.js';
import { computeInnovatorSustainability } from '../utils/sustainability.js';
import { DOMAIN_LABELS } from '../utils/innovator-match.js';
import type { CompanyEntity, Task, ChangeHistoryEntry } from '../types/index.js';

// ─── pg-compatible facade ─────────────────────────────────────────────────────
// The codebase was written against pg's `getPool().query(sql, params)` returning
// a promise of { rows, rowCount }. better-sqlite3 is synchronous; this facade
// keeps every call site's shape (await works fine on plain values) while the
// SQL itself was rewritten to SQLite dialect at each site.

export interface PoolLike {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
}

const poolFacade: PoolLike = {
  async query(text: string, params: unknown[] = []): Promise<QueryResult> {
    return sqliteQuery(text, params);
  },
};

export function getPool(): PoolLike {
  return poolFacade;
}

export { uuid, transaction, SQL_NOW };

// ─── Schema migrations ────────────────────────────────────────────────────────
// SQLite dialect: TEXT primary keys (uuids generated in JS), JSON stored as
// TEXT (see sqlite.ts JSON_COLUMNS for boundary parsing), booleans as 0/1,
// timestamps as ISO-8601 UTC TEXT.

export async function runMigrations(): Promise<void> {
  const db = getDb();
  const now = `DEFAULT (${SQL_NOW})`;
  transaction(() => {
    // Entities table — stores all funders/companies/schemes
    db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        name_aliases TEXT DEFAULT '[]',
        cin TEXT,
        category TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'stub',
        priority INTEGER NOT NULL DEFAULT 4,
        data TEXT NOT NULL DEFAULT '{}',
        source_urls TEXT DEFAULT '[]',
        missing_fields TEXT DEFAULT '[]',
        conflict_log TEXT DEFAULT '[]',
        drift_scores TEXT,
        profile_match_score INTEGER NOT NULL DEFAULT 0,
        created_at TEXT ${now},
        updated_at TEXT ${now}
      )
    `);

    // Change history — every field-level change versioned
    db.exec(`
      CREATE TABLE IF NOT EXISTS change_history (
        id TEXT PRIMARY KEY,
        entity_id TEXT REFERENCES entities(id),
        field_name TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        financial_year TEXT,
        change_type TEXT NOT NULL,
        source_url TEXT,
        detected_at TEXT ${now}
      )
    `);

    // Task queue — all agent work items
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_queue (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        entity_id TEXT REFERENCES entities(id),
        entity_name TEXT,
        priority INTEGER DEFAULT 5,
        payload TEXT DEFAULT '{}',
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        status TEXT DEFAULT 'pending',
        error TEXT,
        created_at TEXT ${now},
        updated_at TEXT ${now}
      )
    `);

    // Human review queue (resolved: 0/1)
    db.exec(`
      CREATE TABLE IF NOT EXISTS human_review_queue (
        id TEXT PRIMARY KEY,
        entity_id TEXT REFERENCES entities(id),
        reason TEXT NOT NULL,
        details TEXT DEFAULT '{}',
        resolved INTEGER DEFAULT 0,
        created_at TEXT ${now}
      )
    `);

    // Match profile — single-row store of the user's targeting profile
    db.exec(`
      CREATE TABLE IF NOT EXISTS match_profile (
        id TEXT PRIMARY KEY,
        singleton INTEGER NOT NULL DEFAULT 1 UNIQUE,
        technologies TEXT NOT NULL DEFAULT '[]',
        target_sectors TEXT NOT NULL DEFAULT '[]',
        target_geographies TEXT NOT NULL DEFAULT '[]',
        keywords TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT ${now}
      )
    `);

    // Innovators — Side B of the platform
    db.exec(`
      CREATE TABLE IF NOT EXISTS innovators (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL DEFAULT 'startup',
        domain TEXT NOT NULL,
        description TEXT,
        website TEXT,
        contact_email TEXT,
        founder_name TEXT,
        trl_current INTEGER CHECK (trl_current BETWEEN 1 AND 9),
        trl_target INTEGER CHECK (trl_target BETWEEN 1 AND 9),
        geography TEXT NOT NULL DEFAULT '[]',
        usp TEXT,
        sustainability_score INTEGER NOT NULL DEFAULT 0 CHECK (sustainability_score BETWEEN 0 AND 100),
        circularity_indicators TEXT NOT NULL DEFAULT '{"closed_loop":false,"zero_waste":false,"renewable_energy":false,"circular_economy":false}',
        ownership_transfer_open INTEGER NOT NULL DEFAULT 0,
        mou_history TEXT NOT NULL DEFAULT '[]',
        key_contacts TEXT NOT NULL DEFAULT '[]',
        innovation_stage TEXT NOT NULL DEFAULT 'prototype',
        annual_revenue_cr REAL,
        funding_raised_cr REAL,
        team_size INTEGER,
        patents_filed INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        robustness_logistics TEXT NOT NULL DEFAULT 'unknown',
        robustness_geographic_scalability TEXT NOT NULL DEFAULT 'unknown',
        indigenous_tech INTEGER,
        govt_mission_alignment TEXT NOT NULL DEFAULT '[]',
        subsidy_land_electricity TEXT NOT NULL DEFAULT '{}',
        capex_subsidy_available INTEGER,
        capex_subsidy_notes TEXT,
        opex_subsidy_available INTEGER,
        opex_subsidy_notes TEXT,
        data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT ${now},
        last_updated_at TEXT ${now}
      )
    `);

    // ── Innovator feasibility columns (added 2026-07-21) ──────────────────────
    // ALTER for DBs created before these columns existed. SQLite has no
    // "ADD COLUMN IF NOT EXISTS", so probe PRAGMA table_info first.
    const innovatorCols = new Set(
      (db.prepare(`PRAGMA table_info(innovators)`).all() as Array<{ name: string }>).map(c => c.name));
    const addCol = (name: string, ddl: string) => {
      if (!innovatorCols.has(name)) db.exec(`ALTER TABLE innovators ADD COLUMN ${ddl}`);
    };
    addCol('robustness_logistics', `robustness_logistics TEXT NOT NULL DEFAULT 'unknown'`);
    addCol('robustness_geographic_scalability', `robustness_geographic_scalability TEXT NOT NULL DEFAULT 'unknown'`);
    addCol('indigenous_tech', `indigenous_tech INTEGER`);
    addCol('govt_mission_alignment', `govt_mission_alignment TEXT NOT NULL DEFAULT '[]'`);
    addCol('subsidy_land_electricity', `subsidy_land_electricity TEXT NOT NULL DEFAULT '{}'`);
    addCol('capex_subsidy_available', `capex_subsidy_available INTEGER`);
    addCol('capex_subsidy_notes', `capex_subsidy_notes TEXT`);
    addCol('opex_subsidy_available', `opex_subsidy_available INTEGER`);
    addCol('opex_subsidy_notes', `opex_subsidy_notes TEXT`);

    // ── Cross-entity full-text search (FTS5) — Stage 2 ────────────────────────
    // Standalone (non-external-content) FTS index over companies + schemes +
    // innovators, repopulated on demand (see rebuildSearchIndex). FTS5 ships
    // enabled in better-sqlite3's bundled SQLite.
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
        entity_type UNINDEXED,
        entity_id UNINDEXED,
        name,
        body
      )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_innovators_domain ON innovators(domain)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_innovators_status ON innovators(status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_profile_match ON entities(profile_match_score DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_priority ON entities(priority)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_category ON entities(category)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status_type ON task_queue(status, type)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_priority ON task_queue(priority, created_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_history_entity ON change_history(entity_id)`);
  });
  logger.info('Database migrations completed successfully (SQLite)');
}

// ─── Entity queries ───────────────────────────────────────────────────────────

export async function upsertEntity(entity: Partial<CompanyEntity> & { name: string; category: string }): Promise<string> {
  const { rows } = await getPool().query(`
    INSERT INTO entities (id, name, name_aliases, cin, category, status, priority, data, source_urls)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (name) DO UPDATE SET
      data = json_patch(entities.data, excluded.data),
      updated_at = NOW()
    RETURNING id
  `, [
    uuid(),
    entity.name,
    entity.name_aliases ?? [],
    entity.cin ?? null,
    entity.category,
    entity.status ?? 'stub',
    entity.priority ?? 4,
    JSON.stringify(entity),
    entity.source_urls ?? [],
  ]);
  return rows[0].id;
}

export async function getEntityById(id: string): Promise<CompanyEntity | null> {
  const { rows } = await getPool().query('SELECT * FROM entities WHERE id = $1', [id]);
  if (!rows.length) return null;
  return { ...rows[0].data, id: rows[0].id, status: rows[0].status, drift_scores: rows[0].drift_scores };
}

export async function updateEntityStatus(id: string, status: string): Promise<void> {
  await getPool().query(
    'UPDATE entities SET status = $1, updated_at = NOW() WHERE id = $2',
    [status, id]
  );
}

export async function updateEntityData(id: string, data: Record<string, unknown>): Promise<void> {
  // json_patch = RFC 7386 merge — same shallow-merge semantics the jsonb ||
  // operator provided, except explicit nulls REMOVE keys (which callers here
  // never rely on; they pass real values or omit the key).
  await getPool().query(
    'UPDATE entities SET data = json_patch(data, $1), updated_at = NOW() WHERE id = $2',
    [JSON.stringify(data), id]
  );
}

/** How many OTHER entities currently carry this exact "latest" CSR spend figure.
 *  Boilerplate leaking from a shared source page shows up as the same figure on
 *  many unrelated companies (the 44.44-Cr incident) — callers log 3+ repeats as
 *  suspicious instead of silently accepting them. */
export async function countEntitiesWithSpendValue(valueCr: number, excludeId: string): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT COUNT(*) AS n FROM entities
     WHERE id != $1
       AND CAST(json_extract(data, '$.csr_spend_cr.value.latest') AS REAL) = CAST($2 AS REAL)`,
    [excludeId, valueCr]
  );
  return Number(rows[0]?.n ?? 0);
}

export async function updateDriftScores(id: string, scores: object): Promise<void> {
  await getPool().query(
    'UPDATE entities SET drift_scores = $1, updated_at = NOW() WHERE id = $2',
    [JSON.stringify(scores), id]
  );
}

// ─── Task queue queries ───────────────────────────────────────────────────────

export async function enqueueTask(task: Omit<Task, 'id' | 'created_at' | 'updated_at' | 'attempts' | 'status'>): Promise<string> {
  const id = uuid();
  await getPool().query(`
    INSERT INTO task_queue (id, type, entity_id, entity_name, priority, payload, max_attempts)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [id, task.type, task.entity_id, task.entity_name, task.priority, JSON.stringify(task.payload), task.max_attempts ?? 3]);
  return id;
}

export async function claimNextTask(type: string): Promise<Task | null> {
  // Single process + synchronous driver → the UPDATE-of-subselect is atomic;
  // pg's FOR UPDATE SKIP LOCKED lock dance is unnecessary here.
  const { rows } = await getPool().query(`
    UPDATE task_queue
    SET status = 'running', attempts = attempts + 1, updated_at = NOW()
    WHERE id = (
      SELECT id FROM task_queue
      WHERE type = $1 AND status = 'pending' AND attempts < max_attempts
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
    )
    RETURNING *
  `, [type]);
  return rows[0] ?? null;
}

/** Claim the next pending task of `type` FOR ONE SPECIFIC ENTITY. Backs the
 *  scoped `--entity-id` CLI path: claiming by priority alone is not scoping,
 *  because any other priority-1 task could be claimed instead. */
export async function claimNextTaskForEntity(type: string, entityId: string): Promise<Task | null> {
  const { rows } = await getPool().query(`
    UPDATE task_queue
    SET status = 'running', attempts = attempts + 1, updated_at = NOW()
    WHERE id = (
      SELECT id FROM task_queue
      WHERE type = $1 AND entity_id = $2 AND status = 'pending' AND attempts < max_attempts
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
    )
    RETURNING *
  `, [type, entityId]);
  return rows[0] ?? null;
}

export async function completeTask(id: string): Promise<void> {
  await getPool().query(`UPDATE task_queue SET status = 'done', updated_at = NOW() WHERE id = $1`, [id]);
}

export async function failTask(id: string, error: string): Promise<void> {
  await getPool().query(
    `UPDATE task_queue SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END, error = $1, updated_at = NOW() WHERE id = $2`,
    [error, id]
  );
}

export async function getTaskQueueStats(): Promise<Record<string, number>> {
  const { rows } = await getPool().query(`
    SELECT type, status, COUNT(*) as count
    FROM task_queue GROUP BY type, status
  `);
  const stats: Record<string, number> = {};
  rows.forEach((r: any) => { stats[`${r.type}:${r.status}`] = Number(r.count); });
  return stats;
}

// ─── Change history ───────────────────────────────────────────────────────────

export async function insertChangeHistory(entry: Omit<ChangeHistoryEntry, 'id'>): Promise<void> {
  await getPool().query(`
    INSERT INTO change_history (id, entity_id, field_name, old_value, new_value, financial_year, change_type, source_url)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [uuid(), entry.entity_id, entry.field_name, JSON.stringify(entry.old_value), JSON.stringify(entry.new_value),
      entry.financial_year, entry.change_type, entry.source_url]);
}

export async function getChangeHistory(entity_id: string): Promise<ChangeHistoryEntry[]> {
  const { rows } = await getPool().query(
    'SELECT * FROM change_history WHERE entity_id = $1 ORDER BY detected_at DESC',
    [entity_id]
  );
  return rows;
}

// ─── Human review ─────────────────────────────────────────────────────────────

export async function addToHumanReview(entity_id: string, reason: string, details: object): Promise<void> {
  await getPool().query(
    'INSERT INTO human_review_queue (id, entity_id, reason, details) VALUES ($1, $2, $3, $4)',
    [uuid(), entity_id, reason, JSON.stringify(details)]
  );
  await updateEntityStatus(entity_id, 'human_review');
  logger.warn('Entity flagged for human review', { entity_id, reason });
}

// ─── Match profile ────────────────────────────────────────────────────────────

export interface MatchProfile {
  technologies: string[];
  target_sectors: string[];
  target_geographies: string[];
  keywords: string[];
  updated_at?: string;
}

const EMPTY_PROFILE: MatchProfile = { technologies: [], target_sectors: [], target_geographies: [], keywords: [] };

export async function getMatchProfile(): Promise<MatchProfile> {
  const { rows } = await getPool().query(`SELECT * FROM match_profile WHERE singleton = TRUE LIMIT 1`);
  if (!rows.length) return { ...EMPTY_PROFILE };
  const r = rows[0];
  return {
    technologies: r.technologies ?? [],
    target_sectors: r.target_sectors ?? [],
    target_geographies: r.target_geographies ?? [],
    keywords: r.keywords ?? [],
    updated_at: r.updated_at,
  };
}

/**
 * Recompute and persist profile_match_score for every company (non-scheme)
 * against the current saved profile. Called after the profile is saved so the
 * dashboard can instantly re-rank by best match.
 */
export async function rerankAllProfileScores(): Promise<number> {
  const profile = await getMatchProfile();
  const { rows } = await getPool().query(`SELECT id, name, data FROM entities WHERE category != 'govt_scheme'`);
  let updated = 0;
  for (const r of rows) {
    const data = r.data || {};
    const sectors: string[] = Array.isArray(data.sector_focus?.value) ? data.sector_focus.value : [];
    const geographies: string[] = Array.isArray(data.geography_focus?.value) ? data.geography_focus.value : [];
    const keyPrograms: string[] = Array.isArray(data.key_programs?.value) ? data.key_programs.value : [];
    const description = [data.raw_notes || '', r.name || '', sectors.join(' '), keyPrograms.join(' ')].join(' ');
    const domainFocus: string[] = Array.isArray(data.domain_focus) ? data.domain_focus : [];
    const pm = computeProfileMatch({ sectors, geographies, description, domain_focus: domainFocus }, profile);
    await getPool().query('UPDATE entities SET profile_match_score = $1 WHERE id = $2', [pm.score, r.id]);
    updated++;
  }
  logger.info('Reranked profile match scores', { updated });
  return updated;
}

export async function upsertMatchProfile(p: MatchProfile): Promise<void> {
  await getPool().query(`
    INSERT INTO match_profile (id, singleton, technologies, target_sectors, target_geographies, keywords, updated_at)
    VALUES ($1, TRUE, $2, $3, $4, $5, NOW())
    ON CONFLICT (singleton) DO UPDATE SET
      technologies = excluded.technologies,
      target_sectors = excluded.target_sectors,
      target_geographies = excluded.target_geographies,
      keywords = excluded.keywords,
      updated_at = NOW()
  `, [uuid(), p.technologies, p.target_sectors, p.target_geographies, p.keywords]);
}

// ─── Manual CRUD support ──────────────────────────────────────────────────────

/** Delete an entity and all rows that reference it (FKs have no ON DELETE CASCADE). */
export async function deleteEntityCascade(id: string): Promise<boolean> {
  return transaction(() => {
    const db = getDb();
    db.prepare('DELETE FROM change_history WHERE entity_id = ?').run(id);
    db.prepare('DELETE FROM task_queue WHERE entity_id = ?').run(id);
    db.prepare('DELETE FROM human_review_queue WHERE entity_id = ?').run(id);
    const r = db.prepare('DELETE FROM entities WHERE id = ?').run(id);
    return r.changes > 0;
  });
}

export interface ManualEdit {
  name?: string;
  sectors?: string[];
  geographies?: string[];
  spend?: number | null;
  score?: number | null;
}

/** Which fields are user-locked, so the pipeline won't overwrite them. */
export async function getManualOverrides(id: string): Promise<Record<string, boolean>> {
  const { rows } = await getPool().query(
    `SELECT json_extract(data, '$.manual_overrides') AS mo FROM entities WHERE id = $1`, [id]);
  const raw = rows[0]?.mo;
  if (!raw) return {};
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return {}; }
}

/** Apply manual edits, marking the touched fields as manual overrides (locked). */
export async function applyManualEdits(id: string, edit: ManualEdit): Promise<void> {
  const now = new Date().toISOString();
  const cf = (value: unknown) => ({ value, confidence: 'high', source_url: 'manual', manual: true, extracted_at: now });
  const data: Record<string, unknown> = {};
  const overrides: Record<string, boolean> = {};

  if (edit.sectors) { data.sector_focus = cf(edit.sectors); overrides.sector_focus = true; }
  if (edit.geographies) { data.geography_focus = cf(edit.geographies); overrides.geography_focus = true; }
  if (edit.spend !== undefined && edit.spend !== null) { data.csr_spend_cr = cf({ manual: edit.spend }); overrides.csr_spend_cr = true; }
  if (edit.score !== undefined && edit.score !== null) { data.manual_score = edit.score; overrides.manual_score = true; }

  const existing = await getManualOverrides(id);
  data.manual_overrides = { ...existing, ...overrides };

  if (edit.name) {
    await getPool().query('UPDATE entities SET name = $1, updated_at = NOW() WHERE id = $2', [edit.name, id]);
  }
  await getPool().query('UPDATE entities SET data = json_patch(data, $1), updated_at = NOW() WHERE id = $2', [JSON.stringify(data), id]);
}

// ─── Innovators (Side B) ──────────────────────────────────────────────────────

/** Fields accepted on insert; everything else defaults in the schema. */
export interface InnovatorInsert {
  name: string;
  type?: string;
  domain: string;
  description?: string | null;
  website?: string | null;
  contact_email?: string | null;
  founder_name?: string | null;
  trl_current?: number | null;
  trl_target?: number | null;
  geography?: string[];
  usp?: string | null;
  sustainability_score?: number;
  circularity_indicators?: Record<string, boolean>;
  ownership_transfer_open?: boolean;
  mou_history?: unknown[];
  key_contacts?: unknown[];
  innovation_stage?: string;
  annual_revenue_cr?: number | null;
  funding_raised_cr?: number | null;
  team_size?: number | null;
  patents_filed?: number;
  status?: string;
  // Feasibility (2026-07-21)
  robustness_logistics?: string;
  robustness_geographic_scalability?: string;
  indigenous_tech?: boolean | null;
  govt_mission_alignment?: string[];
  subsidy_land_electricity?: Record<string, unknown>;
  capex_subsidy_available?: boolean | null;
  capex_subsidy_notes?: string | null;
  opex_subsidy_available?: boolean | null;
  opex_subsidy_notes?: string | null;
  data?: Record<string, unknown>;
}

export async function insertInnovator(inn: InnovatorInsert): Promise<string> {
  // No explicit score supplied → compute one now from the innovator's own
  // description/USP text + any provided circularity indicators.
  const computed = computeInnovatorSustainability(
    [inn.description ?? '', inn.usp ?? ''].join(' '),
    inn.circularity_indicators ?? null,
  );
  const sustainabilityScore = inn.sustainability_score ?? computed.score;
  const indicators = inn.circularity_indicators ?? computed.indicators;

  const { rows } = await getPool().query(`
    INSERT INTO innovators (
      id, name, type, domain, description, website, contact_email, founder_name,
      trl_current, trl_target, geography, usp, sustainability_score,
      circularity_indicators, ownership_transfer_open, mou_history,
      innovation_stage, annual_revenue_cr, funding_raised_cr, team_size,
      patents_filed, status, data
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
    ON CONFLICT (name) DO UPDATE SET last_updated_at = NOW()
    RETURNING id
  `, [
    uuid(), inn.name, inn.type ?? 'startup', inn.domain, inn.description ?? null,
    inn.website ?? null, inn.contact_email ?? null, inn.founder_name ?? null,
    inn.trl_current ?? null, inn.trl_target ?? null, inn.geography ?? [],
    inn.usp ?? null, sustainabilityScore,
    JSON.stringify(indicators),
    inn.ownership_transfer_open ?? false, JSON.stringify(inn.mou_history ?? []),
    inn.innovation_stage ?? 'prototype', inn.annual_revenue_cr ?? null,
    inn.funding_raised_cr ?? null, inn.team_size ?? null, inn.patents_filed ?? 0,
    inn.status ?? 'active', JSON.stringify(inn.data ?? {}),
  ]);
  return rows[0].id;
}

export async function listInnovators(): Promise<any[]> {
  const { rows } = await getPool().query(`SELECT * FROM innovators ORDER BY name ASC`);
  return rows;
}

export async function getInnovatorById(id: string): Promise<any | null> {
  const { rows } = await getPool().query(`SELECT * FROM innovators WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

// Only these columns may be patched — keys become SQL identifiers, so they are
// whitelisted rather than trusted from the caller.
const INNOVATOR_PATCH_COLS = new Set([
  'name', 'type', 'domain', 'description', 'website', 'contact_email', 'founder_name',
  'trl_current', 'trl_target', 'geography', 'usp', 'sustainability_score',
  'circularity_indicators', 'ownership_transfer_open', 'mou_history', 'key_contacts', 'innovation_stage',
  'annual_revenue_cr', 'funding_raised_cr', 'team_size', 'patents_filed', 'status', 'data',
  // Feasibility (2026-07-21)
  'robustness_logistics', 'robustness_geographic_scalability', 'indigenous_tech',
  'govt_mission_alignment', 'subsidy_land_electricity',
  'capex_subsidy_available', 'capex_subsidy_notes', 'opex_subsidy_available', 'opex_subsidy_notes',
]);

/** Patch scalar/array columns; only whitelisted keys present in `patch` are updated. */
export async function updateInnovator(id: string, patch: Partial<InnovatorInsert>): Promise<void> {
  const cols = Object.keys(patch).filter(k =>
    INNOVATOR_PATCH_COLS.has(k) && (patch as Record<string, unknown>)[k] !== undefined);
  if (!cols.length) return;
  // Arrays/objects/booleans are converted centrally by the sqlite param layer.
  const sets = cols.map((c, i) => `${c} = $${i + 2}`);
  const vals = cols.map(c => (patch as Record<string, unknown>)[c]);
  await getPool().query(
    `UPDATE innovators SET ${sets.join(', ')}, last_updated_at = NOW() WHERE id = $1`,
    [id, ...vals]
  );
}

export async function deleteInnovator(id: string): Promise<boolean> {
  const r = await getPool().query(`DELETE FROM innovators WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

export async function getInnovatorCounts(): Promise<Record<string, number>> {
  const { rows } = await getPool().query(`SELECT status, COUNT(*) AS count FROM innovators GROUP BY status`);
  const counts: Record<string, number> = {};
  rows.forEach((r: any) => { counts[r.status] = Number(r.count); });
  return counts;
}

// ─── Cross-entity full-text search (FTS5) — Stage 2 ───────────────────────────

export interface SearchHit {
  entity_type: 'company' | 'scheme' | 'innovator';
  entity_id: string;
  name: string;
  snippet: string;
}

const asStrArr = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : []);

/** Turn a user query into a safe FTS5 MATCH expression (prefix-AND of tokens).
 *  Raw user text can contain FTS operators that throw a syntax error, so we
 *  extract alphanumeric tokens and quote each. Empty when nothing usable. */
export function toFtsQuery(q: string): string {
  const tokens = (q.toLowerCase().match(/[a-z0-9]+/gi) || []).slice(0, 12);
  if (!tokens.length) return '';
  return tokens.map(t => `"${t}"*`).join(' ');
}

/** Rebuild the FTS index from the three entity tables. Cheap at this data scale
 *  (hundreds of rows); called before each search so results are always fresh. */
export function rebuildSearchIndex(): void {
  const db = getDb();
  const ents = sqliteQuery(`SELECT id, name, category, data FROM entities`).rows;
  const inns = sqliteQuery(`SELECT id, name, domain, description, usp, geography FROM innovators`).rows;
  transaction(() => {
    db.exec(`DELETE FROM search_fts`);
    const ins = db.prepare(`INSERT INTO search_fts (entity_type, entity_id, name, body) VALUES (?, ?, ?, ?)`);
    for (const e of ents) {
      const data = (e.data || {}) as Record<string, any>;
      const isScheme = e.category === 'govt_scheme';
      const body = isScheme
        ? [data.description, data.eligibility_text, asStrArr(data.sector_focus?.value).join(' '),
           asStrArr(data.geography_focus?.value).join(' ')].filter(Boolean).join(' ')
        : [asStrArr(data.sector_focus?.value).join(' '), asStrArr(data.domain_focus).join(' '),
           data.raw_notes, asStrArr(data.key_programs?.value).join(' ')].filter(Boolean).join(' ');
      ins.run(isScheme ? 'scheme' : 'company', e.id, e.name, body);
    }
    for (const n of inns) {
      const domainLabel = (DOMAIN_LABELS as Record<string, string>)[n.domain] || n.domain || '';
      const body = [n.description, n.usp, domainLabel, asStrArr(n.geography).join(' ')].filter(Boolean).join(' ');
      ins.run('innovator', n.id, n.name, body);
    }
  });
}

/** Ranked cross-entity matches for `q`, best (bm25) first. */
export function searchEntities(q: string, limit = 30): SearchHit[] {
  const match = toFtsQuery(q);
  if (!match) return [];
  rebuildSearchIndex();
  const rows = getDb().prepare(
    `SELECT entity_type, entity_id, name,
            snippet(search_fts, 3, '', '', '…', 12) AS snippet
     FROM search_fts WHERE search_fts MATCH ? ORDER BY rank LIMIT ?`
  ).all(match, limit) as any[];
  return rows.map(r => ({
    entity_type: r.entity_type as SearchHit['entity_type'],
    entity_id: r.entity_id, name: r.name, snippet: r.snippet || '',
  }));
}

export async function testConnection(): Promise<boolean> {
  try {
    await getPool().query('SELECT 1');
    return true;
  } catch (err) {
    logger.error('Database connection failed', { err });
    return false;
  }
}

export async function closePool(): Promise<void> {
  closeDb();
}
