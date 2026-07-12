// Match engine DB wiring — loads funders (companies + govt schemes) and
// innovators from Postgres, shapes them into the pure scoring inputs from
// utils/innovator-match.ts, and returns ranked matches for the API.

import { getPool, getInnovatorById, listInnovators } from '../db/index.js';
import {
  rankFunders, rankInnovators,
  type FunderMatchInput, type InnovatorMatchInput, type MatchResult, type InnovatorRankResult,
} from '../utils/innovator-match.js';
import type { InnovatorDomain } from '../types/index.js';

// ─── Shaping ──────────────────────────────────────────────────────────────────

function asArr(x: unknown): string[] {
  return Array.isArray(x) ? x.map(String) : [];
}

/** Shape one entities row (company OR scheme) into a FunderMatchInput. */
export function funderInputFromRow(row: any): FunderMatchInput {
  const data = row.data || {};
  const sectors = asArr(data.sector_focus?.value);
  const geographies = asArr(data.geography_focus?.value);
  const trl = data.trl && typeof data.trl.min === 'number'
    ? { min: data.trl.min, max: data.trl.max }
    : { min: 0, max: 0 };
  const text = [
    row.name || '', data.raw_notes || '', data.description || '', data.eligibility_text || '',
    asArr(data.key_programs?.value).join(' '), sectors.join(' '),
  ].join(' ');
  return {
    id: row.id,
    kind: row.category === 'govt_scheme' ? 'scheme' : 'company',
    name: row.name,
    sectors,
    geographies,
    trl,
    text,
    contact_email: data.contact_email?.value ?? null,
  };
}

/** Shape one innovators row into the pure scoring input. */
export function innovatorInputFromRow(row: any): InnovatorMatchInput & { id: string; name: string; contact_email: string | null } {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain as InnovatorDomain,
    trl_current: row.trl_current ?? null,
    geography: asArr(row.geography),
    text: [row.description || '', row.usp || '', row.name || ''].join(' '),
    contact_email: row.contact_email ?? null,
  };
}

// ─── Ranked matching (API entry points) ───────────────────────────────────────

async function loadAllFunders(): Promise<FunderMatchInput[]> {
  const { rows } = await getPool().query(`SELECT id, name, category, data FROM entities`);
  return rows.map(funderInputFromRow);
}

/** GET /api/match/:innovatorId — top funders (companies + schemes) for an innovator. */
export async function matchFundersForInnovator(innovatorId: string, limit = 10): Promise<{ innovator: any; matches: MatchResult[] } | null> {
  const row = await getInnovatorById(innovatorId);
  if (!row) return null;
  const inn = innovatorInputFromRow(row);
  const funders = await loadAllFunders();
  return { innovator: row, matches: rankFunders(inn, funders, limit) };
}

/** GET /api/match/funders/:companyId — top innovators for a funder (company or scheme). */
export async function matchInnovatorsForFunder(funderId: string, limit = 10): Promise<{ funder: any; matches: InnovatorRankResult[] } | null> {
  const { rows } = await getPool().query(`SELECT id, name, category, data FROM entities WHERE id = $1`, [funderId]);
  if (!rows.length) return null;
  const funder = funderInputFromRow(rows[0]);
  const innovators = (await listInnovators()).map(innovatorInputFromRow);
  return { funder: rows[0], matches: rankInnovators(funder, innovators, limit) };
}
