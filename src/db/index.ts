import pg from 'pg';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { computeProfileMatch } from '../utils/match.js';
import { computeInnovatorSustainability } from '../utils/sustainability.js';
import type { CompanyEntity, Task, ChangeHistoryEntry } from '../types/index.js';

const { Pool: PGPool } = pg;
let pool: Pool;

export function getPool(): Pool {
  if (!pool) {
    pool = new PGPool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', (err: any) => logger.error('DB pool error', { err }));
  }
  return pool;
}

// ─── Schema migrations ────────────────────────────────────────────────────────

export async function runMigrations(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    // Entities table — stores all funders/companies/schemes
    await client.query(`
      CREATE TABLE IF NOT EXISTS entities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL UNIQUE,
        name_aliases TEXT[] DEFAULT '{}',
        cin TEXT,
        category TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'stub',
        priority INTEGER NOT NULL DEFAULT 4,
        data JSONB NOT NULL DEFAULT '{}',
        source_urls TEXT[] DEFAULT '{}',
        missing_fields TEXT[] DEFAULT '{}',
        conflict_log JSONB DEFAULT '[]',
        drift_scores JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Change history — every field-level change versioned
    await client.query(`
      CREATE TABLE IF NOT EXISTS change_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        entity_id UUID REFERENCES entities(id),
        field_name TEXT NOT NULL,
        old_value JSONB,
        new_value JSONB,
        financial_year TEXT,
        change_type TEXT NOT NULL,
        source_url TEXT,
        detected_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Task queue — all agent work items
    await client.query(`
      CREATE TABLE IF NOT EXISTS task_queue (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        type TEXT NOT NULL,
        entity_id UUID REFERENCES entities(id),
        entity_name TEXT,
        priority INTEGER DEFAULT 5,
        payload JSONB DEFAULT '{}',
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        status TEXT DEFAULT 'pending',
        error TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Human review queue
    await client.query(`
      CREATE TABLE IF NOT EXISTS human_review_queue (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        entity_id UUID REFERENCES entities(id),
        reason TEXT NOT NULL,
        details JSONB DEFAULT '{}',
        resolved BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Match profile — single-row store of the user's targeting profile
    await client.query(`
      CREATE TABLE IF NOT EXISTS match_profile (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        singleton BOOLEAN NOT NULL DEFAULT TRUE UNIQUE,
        technologies TEXT[] NOT NULL DEFAULT '{}',
        target_sectors TEXT[] NOT NULL DEFAULT '{}',
        target_geographies TEXT[] NOT NULL DEFAULT '{}',
        keywords TEXT[] NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Innovators — Side B of the platform: startups / individual innovators /
    // research institutes that get MATCHED to funders (companies + schemes).
    await client.query(`
      CREATE TABLE IF NOT EXISTS innovators (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL DEFAULT 'startup',
        domain TEXT NOT NULL,
        description TEXT,
        website TEXT,
        contact_email TEXT,
        founder_name TEXT,
        trl_current INTEGER CHECK (trl_current BETWEEN 1 AND 9),
        trl_target INTEGER CHECK (trl_target BETWEEN 1 AND 9),
        geography TEXT[] NOT NULL DEFAULT '{}',
        usp TEXT,
        sustainability_score INTEGER NOT NULL DEFAULT 0 CHECK (sustainability_score BETWEEN 0 AND 100),
        circularity_indicators JSONB NOT NULL DEFAULT '{"closed_loop":false,"zero_waste":false,"renewable_energy":false,"circular_economy":false}',
        ownership_transfer_open BOOLEAN NOT NULL DEFAULT FALSE,
        mou_history JSONB NOT NULL DEFAULT '[]',
        innovation_stage TEXT NOT NULL DEFAULT 'prototype',
        annual_revenue_cr NUMERIC,
        funding_raised_cr NUMERIC,
        team_size INTEGER,
        patents_filed INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        data JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_innovators_domain ON innovators(domain)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_innovators_status ON innovators(status)`);

    // Executive/leadership contacts (CEO, MD, CSR Head …) extracted from sources.
    // Companies store theirs inside entities.data (key_contacts); innovators get
    // a dedicated column like their other structured fields.
    await client.query(`ALTER TABLE innovators ADD COLUMN IF NOT EXISTS key_contacts JSONB NOT NULL DEFAULT '[]'`);

    // Indexes
    // Persisted profile-match score (recomputed whenever the profile is saved).
    await client.query(`ALTER TABLE entities ADD COLUMN IF NOT EXISTS profile_match_score INTEGER NOT NULL DEFAULT 0`);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_entities_profile_match ON entities(profile_match_score DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_entities_priority ON entities(priority)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_entities_category ON entities(category)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tasks_status_type ON task_queue(status, type)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tasks_priority ON task_queue(priority, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_history_entity ON change_history(entity_id)`);

    await client.query('COMMIT');
    logger.info('Database migrations completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Entity queries ───────────────────────────────────────────────────────────

export async function upsertEntity(entity: Partial<CompanyEntity> & { name: string; category: string }): Promise<string> {
  const { rows } = await getPool().query(`
    INSERT INTO entities (name, name_aliases, cin, category, status, priority, data, source_urls)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (name) DO UPDATE SET
      data = entities.data || EXCLUDED.data,
      updated_at = NOW()
    RETURNING id
  `, [
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
  await getPool().query(
    'UPDATE entities SET data = data || $1::jsonb, updated_at = NOW() WHERE id = $2',
    [JSON.stringify(data), id]
  );
}

export async function updateDriftScores(id: string, scores: object): Promise<void> {
  await getPool().query(
    'UPDATE entities SET drift_scores = $1, updated_at = NOW() WHERE id = $2',
    [JSON.stringify(scores), id]
  );
}

// ─── Task queue queries ───────────────────────────────────────────────────────

export async function enqueueTask(task: Omit<Task, 'id' | 'created_at' | 'updated_at' | 'attempts' | 'status'>): Promise<string> {
  const { rows } = await getPool().query(`
    INSERT INTO task_queue (type, entity_id, entity_name, priority, payload, max_attempts)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id
  `, [task.type, task.entity_id, task.entity_name, task.priority, JSON.stringify(task.payload), task.max_attempts ?? 3]);
  return rows[0].id;
}

export async function claimNextTask(type: string): Promise<Task | null> {
  // Atomic claim: UPDATE ... RETURNING to avoid race conditions between parallel workers
  const { rows } = await getPool().query(`
    UPDATE task_queue
    SET status = 'running', attempts = attempts + 1, updated_at = NOW()
    WHERE id = (
      SELECT id FROM task_queue
      WHERE type = $1 AND status = 'pending' AND attempts < max_attempts
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `, [type]);
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
  rows.forEach((r: any) => { stats[`${r.type}:${r.status}`] = parseInt(r.count); });
  return stats;
}

// ─── Change history ───────────────────────────────────────────────────────────

export async function insertChangeHistory(entry: Omit<ChangeHistoryEntry, 'id'>): Promise<void> {
  await getPool().query(`
    INSERT INTO change_history (entity_id, field_name, old_value, new_value, financial_year, change_type, source_url)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [entry.entity_id, entry.field_name, JSON.stringify(entry.old_value), JSON.stringify(entry.new_value),
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
    'INSERT INTO human_review_queue (entity_id, reason, details) VALUES ($1, $2, $3)',
    [entity_id, reason, JSON.stringify(details)]
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
    INSERT INTO match_profile (singleton, technologies, target_sectors, target_geographies, keywords, updated_at)
    VALUES (TRUE, $1, $2, $3, $4, NOW())
    ON CONFLICT (singleton) DO UPDATE SET
      technologies = EXCLUDED.technologies,
      target_sectors = EXCLUDED.target_sectors,
      target_geographies = EXCLUDED.target_geographies,
      keywords = EXCLUDED.keywords,
      updated_at = NOW()
  `, [p.technologies, p.target_sectors, p.target_geographies, p.keywords]);
}

// ─── Manual CRUD support ──────────────────────────────────────────────────────

/** Delete an entity and all rows that reference it (FKs have no ON DELETE CASCADE). */
export async function deleteEntityCascade(id: string): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM change_history WHERE entity_id = $1', [id]);
    await client.query('DELETE FROM task_queue WHERE entity_id = $1', [id]);
    await client.query('DELETE FROM human_review_queue WHERE entity_id = $1', [id]);
    const r = await client.query('DELETE FROM entities WHERE id = $1', [id]);
    await client.query('COMMIT');
    return (r.rowCount ?? 0) > 0;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
  const { rows } = await getPool().query(`SELECT data->'manual_overrides' AS mo FROM entities WHERE id = $1`, [id]);
  return (rows[0]?.mo as Record<string, boolean> | null) ?? {};
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
  await getPool().query('UPDATE entities SET data = data || $1::jsonb, updated_at = NOW() WHERE id = $2', [JSON.stringify(data), id]);
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
  data?: Record<string, unknown>;
}

export async function insertInnovator(inn: InnovatorInsert): Promise<string> {
  // No explicit score supplied → compute one now from the innovator's own
  // description/USP text + any provided circularity indicators. Previously the
  // column silently defaulted to 0 and stayed 0 unless deep research succeeded
  // later — which is why every seed showed 0/100 in the UI.
  const computed = computeInnovatorSustainability(
    [inn.description ?? '', inn.usp ?? ''].join(' '),
    inn.circularity_indicators ?? null,
  );
  const sustainabilityScore = inn.sustainability_score ?? computed.score;
  const indicators = inn.circularity_indicators ?? computed.indicators;

  const { rows } = await getPool().query(`
    INSERT INTO innovators (
      name, type, domain, description, website, contact_email, founder_name,
      trl_current, trl_target, geography, usp, sustainability_score,
      circularity_indicators, ownership_transfer_open, mou_history,
      innovation_stage, annual_revenue_cr, funding_raised_cr, team_size,
      patents_filed, status, data
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
    ON CONFLICT (name) DO UPDATE SET last_updated_at = NOW()
    RETURNING id
  `, [
    inn.name, inn.type ?? 'startup', inn.domain, inn.description ?? null,
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
]);

/** Patch scalar/array columns; only whitelisted keys present in `patch` are updated. */
export async function updateInnovator(id: string, patch: Partial<InnovatorInsert>): Promise<void> {
  const jsonCols = new Set(['circularity_indicators', 'mou_history', 'key_contacts', 'data']);
  const cols = Object.keys(patch).filter(k =>
    INNOVATOR_PATCH_COLS.has(k) && (patch as Record<string, unknown>)[k] !== undefined);
  if (!cols.length) return;
  const sets = cols.map((c, i) => `${c} = $${i + 2}${jsonCols.has(c) ? '::jsonb' : ''}`);
  const vals = cols.map(c => {
    const v = (patch as Record<string, unknown>)[c];
    return jsonCols.has(c) ? JSON.stringify(v) : v;
  });
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
  rows.forEach((r: any) => { counts[r.status] = parseInt(r.count); });
  return counts;
}

export async function testConnection(): Promise<boolean> {
  try {
    const client = await getPool().connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch (err) {
    logger.error('Database connection failed', { err });
    return false;
  }
}

export async function closePool(): Promise<void> {
  await getPool().end();
}
