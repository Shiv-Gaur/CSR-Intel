/**
 * Manual export/import snapshot sync — a v1 STOPGAP for sharing data between
 * users until server-based sync (Phase 5) exists. See docs/PROJECT_REQUIREMENTS.md.
 *
 * Design guardrails (the project has a history of data-quality incidents):
 *  - Import NEVER silently overwrites existing local data. A record that exists
 *    locally with different data becomes a CONFLICT the user resolves by hand.
 *  - New records are inserted; identical records are skipped; only user-chosen
 *    conflicts are applied via applyResolutions().
 *  - Snapshots are validated (JSON, shape, version) before any write.
 *
 * Matching key: `name` (UNIQUE on both entities and innovators).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rebuildSearchIndex } from '../db/index.js';
// Synchronous query (not the async getPool() facade): better-sqlite3 transactions
// are synchronous, so awaiting inside transaction() would commit before the writes.
import { uuid, transaction, query as dbQuery } from '../db/sqlite.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SNAPSHOT_FORMAT = 'csr-intel-snapshot';
/** Bump only on a breaking snapshot-shape change; import rejects a higher one. */
export const SNAPSHOT_SCHEMA_VERSION = 1;

export function getAppVersion(): string {
  // dist/sync/ and src/sync/ are both two levels below the project root.
  for (const rel of ['../../package.json', '../../../package.json']) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, rel), 'utf8'));
      if (pkg?.version) return String(pkg.version);
    } catch { /* try next */ }
  }
  return '0.0.0';
}

const major = (v: string): number => Number(String(v).split('.')[0]) || 0;

export type EntityRow = Record<string, any>;
export interface Snapshot {
  format: string;
  schema_version: number;
  app_version: string;
  exported_at: string;
  counts: { companies: number; schemes: number; innovators: number };
  companies: EntityRow[];
  schemes: EntityRow[];
  innovators: EntityRow[];
}

// ─── Export ──────────────────────────────────────────────────────────────────

export function buildSnapshot(): Snapshot {
  const entities = dbQuery(`SELECT * FROM entities ORDER BY name ASC`).rows as EntityRow[];
  const companies = entities.filter(e => e.category !== 'govt_scheme');
  const schemes = entities.filter(e => e.category === 'govt_scheme');
  const innovators = dbQuery(`SELECT * FROM innovators ORDER BY name ASC`).rows as EntityRow[];
  return {
    format: SNAPSHOT_FORMAT,
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    app_version: getAppVersion(),
    exported_at: new Date().toISOString(),
    counts: { companies: companies.length, schemes: schemes.length, innovators: innovators.length },
    companies, schemes, innovators,
  };
}

export function suggestedFilename(): string {
  return `csr-intel-snapshot-${new Date().toISOString().slice(0, 10)}.json`;
}

// ─── Validation ──────────────────────────────────────────────────────────────

export class SnapshotError extends Error {}

/** Parse + validate an untrusted snapshot string. Throws SnapshotError with a
 *  user-facing message on any problem — callers must not attempt a partial import. */
export function parseSnapshot(raw: string): Snapshot {
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new SnapshotError('Not a valid JSON file.');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new SnapshotError('File is not a snapshot object.');
  }
  if (obj.format !== SNAPSHOT_FORMAT) {
    throw new SnapshotError('Unrecognised file — not a CSR Intelligence snapshot.');
  }
  const schemaV = Number(obj.schema_version);
  if (!Number.isFinite(schemaV) || schemaV > SNAPSHOT_SCHEMA_VERSION) {
    throw new SnapshotError(
      `Snapshot schema v${obj.schema_version} is newer than this app supports (v${SNAPSHOT_SCHEMA_VERSION}). Update the app first.`);
  }
  if (obj.app_version && major(obj.app_version) !== major(getAppVersion())) {
    throw new SnapshotError(
      `Snapshot is from an incompatible app version (${obj.app_version}); this app is ${getAppVersion()}.`);
  }
  for (const key of ['companies', 'schemes', 'innovators'] as const) {
    if (!Array.isArray(obj[key])) throw new SnapshotError(`Snapshot is missing or has an invalid "${key}" list.`);
  }
  // Every record must at least carry a usable match key.
  for (const key of ['companies', 'schemes', 'innovators'] as const) {
    for (const rec of obj[key]) {
      if (!rec || typeof rec !== 'object' || typeof rec.name !== 'string' || !rec.name.trim()) {
        throw new SnapshotError(`A record in "${key}" is missing a name — file looks corrupt.`);
      }
    }
  }
  return obj as Snapshot;
}

// ─── Diffing ─────────────────────────────────────────────────────────────────

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every(k => deepEqual((a as any)[k], (b as any)[k]));
}

function preview(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(none)';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

export interface FieldDiff { field: string; local: string; imported: string; }

// Columns worth comparing (id / timestamps are ignored — they always differ).
const ENTITY_FIELDS = ['cin', 'category', 'status', 'priority', 'profile_match_score',
  'name_aliases', 'source_urls', 'missing_fields'];
const INNOVATOR_FIELDS = ['type', 'domain', 'description', 'website', 'contact_email', 'founder_name',
  'trl_current', 'trl_target', 'geography', 'usp', 'sustainability_score', 'circularity_indicators',
  'ownership_transfer_open', 'mou_history', 'key_contacts', 'innovation_stage', 'annual_revenue_cr',
  'funding_raised_cr', 'team_size', 'patents_filed', 'status', 'robustness_logistics',
  'robustness_geographic_scalability', 'indigenous_tech', 'govt_mission_alignment',
  'subsidy_land_electricity', 'capex_subsidy_available', 'capex_subsidy_notes',
  'opex_subsidy_available', 'opex_subsidy_notes'];

/** Field-level differences between a local and imported record. The big `data`
 *  blob is compared per top-level key so the report reads "data.key_contacts …"
 *  rather than dumping the whole object. Empty result ⇒ records are identical. */
export function diffRecords(local: EntityRow, imported: EntityRow, fields: string[]): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const f of fields) {
    if (!deepEqual(local[f], imported[f])) {
      diffs.push({ field: f, local: preview(local[f]), imported: preview(imported[f]) });
    }
  }
  const ld = local.data ?? {}, id = imported.data ?? {};
  for (const k of new Set([...Object.keys(ld), ...Object.keys(id)])) {
    if (!deepEqual(ld[k], id[k])) diffs.push({ field: `data.${k}`, local: preview(ld[k]), imported: preview(id[k]) });
  }
  return diffs;
}

// ─── Import ──────────────────────────────────────────────────────────────────

export type SyncType = 'company' | 'scheme' | 'innovator';
export interface Conflict { type: SyncType; name: string; diffs: FieldDiff[]; imported: EntityRow; }
export interface ImportResult {
  added: { companies: number; schemes: number; innovators: number };
  upToDate: number;
  conflicts: Conflict[];
  snapshot: { exported_at: string; app_version: string };
}

function localByName(table: 'entities' | 'innovators'): Map<string, EntityRow> {
  const rows = dbQuery(`SELECT * FROM ${table}`).rows as EntityRow[];
  const m = new Map<string, EntityRow>();
  for (const r of rows) m.set(String(r.name).trim().toLowerCase(), r);
  return m;
}

function insertEntity(e: EntityRow): void {
  const nowIso = new Date().toISOString();
  dbQuery(
    `INSERT INTO entities (id, name, name_aliases, cin, category, status, priority, data,
       source_urls, missing_fields, conflict_log, drift_scores, profile_match_score, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [uuid(), e.name, e.name_aliases ?? [], e.cin ?? null, e.category ?? 'company', e.status ?? 'stub',
     e.priority ?? 4, e.data ?? {}, e.source_urls ?? [], e.missing_fields ?? [], e.conflict_log ?? [],
     e.drift_scores ?? null, e.profile_match_score ?? 0, e.created_at ?? nowIso, nowIso]);
}

function insertInnovatorRow(n: EntityRow): void {
  const nowIso = new Date().toISOString();
  dbQuery(
    `INSERT INTO innovators (id, name, type, domain, description, website, contact_email, founder_name,
       trl_current, trl_target, geography, usp, sustainability_score, circularity_indicators,
       ownership_transfer_open, mou_history, key_contacts, innovation_stage, annual_revenue_cr,
       funding_raised_cr, team_size, patents_filed, status, robustness_logistics,
       robustness_geographic_scalability, indigenous_tech, govt_mission_alignment,
       subsidy_land_electricity, capex_subsidy_available, capex_subsidy_notes, opex_subsidy_available,
       opex_subsidy_notes, data, created_at, last_updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35)`,
    [uuid(), n.name, n.type ?? 'startup', n.domain ?? 'circular_economy', n.description ?? null,
     n.website ?? null, n.contact_email ?? null, n.founder_name ?? null, n.trl_current ?? null,
     n.trl_target ?? null, n.geography ?? [], n.usp ?? null, n.sustainability_score ?? 0,
     n.circularity_indicators ?? {}, n.ownership_transfer_open ?? 0, n.mou_history ?? [],
     n.key_contacts ?? [], n.innovation_stage ?? 'prototype', n.annual_revenue_cr ?? null,
     n.funding_raised_cr ?? null, n.team_size ?? null, n.patents_filed ?? 0, n.status ?? 'active',
     n.robustness_logistics ?? 'unknown', n.robustness_geographic_scalability ?? 'unknown',
     n.indigenous_tech ?? null, n.govt_mission_alignment ?? [], n.subsidy_land_electricity ?? {},
     n.capex_subsidy_available ?? null, n.capex_subsidy_notes ?? null, n.opex_subsidy_available ?? null,
     n.opex_subsidy_notes ?? null, n.data ?? {}, n.created_at ?? nowIso, nowIso]);
}

/** Classify every record in `snap`: insert new ones, skip identical ones, and
 *  collect conflicts (existing-but-different) WITHOUT touching local data. */
export function importSnapshot(snap: Snapshot): ImportResult {
  const added = { companies: 0, schemes: 0, innovators: 0 };
  let upToDate = 0;
  const conflicts: Conflict[] = [];

  transaction(() => {
    const entities = localByName('entities');
    for (const [key, type] of [['companies', 'company'], ['schemes', 'scheme']] as const) {
      for (const rec of snap[key]) {
        const local = entities.get(rec.name.trim().toLowerCase());
        if (!local) { insertEntity(rec); type === 'company' ? added.companies++ : added.schemes++; continue; }
        const diffs = diffRecords(local, rec, ENTITY_FIELDS);
        if (diffs.length === 0) { upToDate++; continue; }
        conflicts.push({ type, name: local.name, diffs, imported: rec });
      }
    }
    const innovators = localByName('innovators');
    for (const rec of snap.innovators) {
      const local = innovators.get(rec.name.trim().toLowerCase());
      if (!local) { insertInnovatorRow(rec); added.innovators++; continue; }
      const diffs = diffRecords(local, rec, INNOVATOR_FIELDS);
      if (diffs.length === 0) { upToDate++; continue; }
      conflicts.push({ type: 'innovator', name: local.name, diffs, imported: rec });
    }
  });

  rebuildSearchIndex();
  logger.info('Snapshot import processed', { added, upToDate, conflicts: conflicts.length });
  return { added, upToDate, conflicts, snapshot: { exported_at: snap.exported_at, app_version: snap.app_version } };
}

// ─── Conflict resolution (only "use imported" reaches here) ──────────────────

export interface Resolution { type: SyncType; name: string; imported: EntityRow; }

function updateEntity(e: EntityRow): void {
  dbQuery(
    `UPDATE entities SET name_aliases=$1, cin=$2, category=$3, status=$4, priority=$5, data=$6,
       source_urls=$7, missing_fields=$8, conflict_log=$9, drift_scores=$10, profile_match_score=$11,
       updated_at=NOW() WHERE lower(name)=lower($12)`,
    [e.name_aliases ?? [], e.cin ?? null, e.category ?? 'company', e.status ?? 'stub', e.priority ?? 4,
     e.data ?? {}, e.source_urls ?? [], e.missing_fields ?? [], e.conflict_log ?? [], e.drift_scores ?? null,
     e.profile_match_score ?? 0, e.name]);
}

function updateInnovatorRow(n: EntityRow): void {
  dbQuery(
    `UPDATE innovators SET type=$1, domain=$2, description=$3, website=$4, contact_email=$5, founder_name=$6,
       trl_current=$7, trl_target=$8, geography=$9, usp=$10, sustainability_score=$11, circularity_indicators=$12,
       ownership_transfer_open=$13, mou_history=$14, key_contacts=$15, innovation_stage=$16, annual_revenue_cr=$17,
       funding_raised_cr=$18, team_size=$19, patents_filed=$20, status=$21, robustness_logistics=$22,
       robustness_geographic_scalability=$23, indigenous_tech=$24, govt_mission_alignment=$25,
       subsidy_land_electricity=$26, capex_subsidy_available=$27, capex_subsidy_notes=$28,
       opex_subsidy_available=$29, opex_subsidy_notes=$30, data=$31, last_updated_at=NOW()
     WHERE lower(name)=lower($32)`,
    [n.type ?? 'startup', n.domain ?? 'circular_economy', n.description ?? null, n.website ?? null,
     n.contact_email ?? null, n.founder_name ?? null, n.trl_current ?? null, n.trl_target ?? null,
     n.geography ?? [], n.usp ?? null, n.sustainability_score ?? 0, n.circularity_indicators ?? {},
     n.ownership_transfer_open ?? 0, n.mou_history ?? [], n.key_contacts ?? [], n.innovation_stage ?? 'prototype',
     n.annual_revenue_cr ?? null, n.funding_raised_cr ?? null, n.team_size ?? null, n.patents_filed ?? 0,
     n.status ?? 'active', n.robustness_logistics ?? 'unknown', n.robustness_geographic_scalability ?? 'unknown',
     n.indigenous_tech ?? null, n.govt_mission_alignment ?? [], n.subsidy_land_electricity ?? {},
     n.capex_subsidy_available ?? null, n.capex_subsidy_notes ?? null, n.opex_subsidy_available ?? null,
     n.opex_subsidy_notes ?? null, n.data ?? {}, n.name]);
}

/** Apply ONLY the conflicts the user chose "use imported" for. Others (keep
 *  local / skip) never reach here. Overwrites the matched local record wholesale. */
export function applyResolutions(resolutions: Resolution[]): { applied: number } {
  let applied = 0;
  transaction(() => {
    for (const r of resolutions) {
      if (!r || !r.imported || !r.name) continue;
      if (r.type === 'innovator') updateInnovatorRow(r.imported);
      else updateEntity(r.imported);
      applied++;
    }
  });
  rebuildSearchIndex();
  logger.info('Snapshot conflict resolutions applied', { applied });
  return { applied };
}
