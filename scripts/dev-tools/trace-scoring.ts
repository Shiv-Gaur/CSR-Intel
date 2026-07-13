// Diagnostic: trace real companies through computeProfileMatch and
// scoreFunderInnovatorPair to explain score collapse. Run: tsx scripts/trace-scoring.ts
import 'dotenv/config';
import { getPool, getMatchProfile } from '../../src/db/index.js';
import { computeProfileMatch } from '../../src/utils/match.js';
import { funderInputFromRow, innovatorInputFromRow } from '../../src/tools/match-engine.js';
import { scoreFunderInnovatorPair } from '../../src/utils/innovator-match.js';

const NAMES = ['Infosys', 'Tata Motors', 'Hindustan Zinc', 'Cipla', 'Wipro'];

async function main() {
  const profile = await getMatchProfile();
  console.log('=== MATCH PROFILE ===');
  console.log(JSON.stringify(profile, null, 1));

  const { rows: inns } = await getPool().query(`SELECT * FROM innovators WHERE name = 'Chakr Innovation'`);
  const chakr = innovatorInputFromRow(inns[0]);

  for (const name of NAMES) {
    const { rows } = await getPool().query(
      `SELECT * FROM entities WHERE name LIKE $1 AND category != 'govt_scheme' LIMIT 1`, ['%' + name + '%']);
    if (!rows.length) { console.log(`\n### ${name}: NOT FOUND`); continue; }
    const row = rows[0];
    const data = row.data || {};
    const f = funderInputFromRow(row);
    console.log(`\n### ${row.name}`);
    console.log('  sectors:', JSON.stringify(f.sectors));
    console.log('  geographies:', JSON.stringify(f.geographies));
    console.log('  trl:', JSON.stringify(f.trl), '| data.trl raw:', JSON.stringify(data.trl));
    console.log('  text length:', f.text.length, '| raw_notes length:', String(data.raw_notes || '').length);
    const pm = computeProfileMatch(
      { sectors: f.sectors, geographies: f.geographies, description: f.text }, profile);
    console.log('  computeProfileMatch →', pm.score, JSON.stringify(pm.reasons));
    const pair = scoreFunderInnovatorPair(chakr, f);
    console.log('  scoreFunderInnovatorPair(Chakr) →', pair.score, JSON.stringify(pair.reasons));
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
