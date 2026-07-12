// One-off, idempotent cleanup: remove stored key_contacts that came ONLY from
// Wikipedia or LinkedIn with no independent confirmation (same name or same
// email also found by any other source). Those two sources produced the wrong/
// stale executive names — an unconfirmed entry from them is not trustworthy
// enough to keep showing. Companies (entities.data.key_contacts) and
// innovators (innovators.key_contacts) are both cleaned.
//
// Run: npx tsx scripts/purge-unconfirmed-wiki-contacts.ts
import 'dotenv/config';
import { getPool } from '../../src/db/index.js';
import { logger } from '../../src/utils/logger.js';

const PURGE_SOURCES = new Set(['wikipedia', 'linkedin']);

interface StoredContact {
  name: string | null;
  title: string;
  email: string | null;
  source: string;
  [k: string]: unknown;
}

/** Keep a wiki/linkedin contact only when another source found the same person/email. */
function filterContacts(list: StoredContact[]): { kept: StoredContact[]; removed: StoredContact[] } {
  const confirmedNames = new Set<string>();
  const confirmedEmails = new Set<string>();
  for (const c of list) {
    if (!PURGE_SOURCES.has(String(c.source))) {
      if (c.name) confirmedNames.add(c.name.toLowerCase());
      if (c.email) confirmedEmails.add(c.email.toLowerCase());
    }
  }
  const kept: StoredContact[] = [];
  const removed: StoredContact[] = [];
  for (const c of list) {
    if (!PURGE_SOURCES.has(String(c.source))) { kept.push(c); continue; }
    const nameOk = c.name && confirmedNames.has(c.name.toLowerCase());
    const emailOk = c.email && confirmedEmails.has(c.email.toLowerCase());
    if (nameOk || emailOk) kept.push(c);
    else removed.push(c);
  }
  return { kept, removed };
}

async function main(): Promise<void> {
  const pool = getPool();
  let entitiesTouched = 0, entityContactsRemoved = 0;

  const ents = await pool.query(
    `SELECT id, name, data->'key_contacts' AS contacts FROM entities
     WHERE category != 'govt_scheme' AND jsonb_array_length(COALESCE(data->'key_contacts','[]'::jsonb)) > 0`);
  for (const row of ents.rows) {
    const list: StoredContact[] = Array.isArray(row.contacts) ? row.contacts : [];
    const { kept, removed } = filterContacts(list);
    if (!removed.length) continue;
    await pool.query(
      `UPDATE entities SET data = jsonb_set(data, '{key_contacts}', $1::jsonb), updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(kept), row.id]);
    entitiesTouched++;
    entityContactsRemoved += removed.length;
    logger.info('Purged unconfirmed wiki/linkedin contacts', {
      entity: row.name, removed: removed.map(c => `${c.name ?? c.email} (${c.title}, ${c.source})`),
    });
  }

  let innovatorsTouched = 0, innovatorContactsRemoved = 0;
  const inns = await pool.query(
    `SELECT id, name, key_contacts FROM innovators
     WHERE jsonb_array_length(COALESCE(key_contacts,'[]'::jsonb)) > 0`);
  for (const row of inns.rows) {
    const list: StoredContact[] = Array.isArray(row.key_contacts) ? row.key_contacts : [];
    const { kept, removed } = filterContacts(list);
    if (!removed.length) continue;
    await pool.query(
      `UPDATE innovators SET key_contacts = $1::jsonb, last_updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(kept), row.id]);
    innovatorsTouched++;
    innovatorContactsRemoved += removed.length;
    logger.info('Purged unconfirmed wiki/linkedin contacts (innovator)', {
      innovator: row.name, removed: removed.map(c => `${c.name ?? c.email} (${c.title}, ${c.source})`),
    });
  }

  logger.info('Purge complete', {
    entitiesTouched, entityContactsRemoved, innovatorsTouched, innovatorContactsRemoved,
  });
  await pool.end();
}

main().catch(err => { logger.error('Purge failed', { error: err.message }); process.exit(1); });
