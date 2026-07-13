// READ-ONLY diagnostic: component-level trace of profile-match + base-data scores
// for named companies, using the EXACT same code paths the dashboard uses:
//   profile match → flattenCompany fields → companyMatchInput → computeProfileMatch
//   data score    → dashboard.html scoreCompany(c) semantics (client-side displayScore)
// Mirrors the math step-by-step to expose raw-vs-capped values, then asserts the
// mirrored totals equal the real functions' outputs so the trace can't drift.
// CLI: npx tsx scripts/trace-scores.ts

import 'dotenv/config';
import { getPool, closePool, getMatchProfile } from '../../src/db/index.js';
import { computeProfileMatch, type ProfileInput, type CompanyMatchInput } from '../../src/utils/match.js';
import { scoreCompany, pickOfficialContact, SECTOR_KEYWORDS } from '../../src/utils/extractor.js';
import { DOMAIN_LABELS } from '../../src/utils/innovator-match.js';

const TARGETS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['Tata Consultancy', 'Mphasis', 'Siemens', 'Vodafone Idea', 'Federal Bank', 'HCL Technologies', 'Persistent Systems'];

const lc = (s: string) => s.toLowerCase();
const overlap = (a: string[], b: string[]) => { const s = new Set(b.map(lc)); return a.filter(x => s.has(lc(x))); };
const present = (hay: string, needles: string[]) => { const h = lc(hay); return needles.filter(n => n && h.includes(lc(n))); };
function occurrences(text: string, term: string): number {
  if (!term) return 0;
  const t = lc(text), n = lc(term);
  let c = 0, i = t.indexOf(n);
  while (i !== -1) { c++; i = t.indexOf(n, i + n.length); }
  return c;
}
const rankedPoints = (rank: number, first: number, step: number, floor: number) =>
  Math.max(floor, first - step * rank);

function traceProfileMatch(c: CompanyMatchInput, p: ProfileInput): number {
  let total = 0;

  // sectors (cap 35)
  const csLc = c.sectors.map(lc);
  const sectorHits = overlap(c.sectors, p.target_sectors);
  let sRaw = 0;
  const sParts = sectorHits.map(s => {
    const rank = csLc.indexOf(lc(s));
    const pt = rankedPoints(rank, 12, 2, 4);
    sRaw += pt;
    return `${s} (company rank #${rank + 1} → +${pt})`;
  });
  const sPts = Math.min(sRaw, 35);
  total += sPts;
  console.log(`  sectors      : hits=${sectorHits.length} [${sParts.join('; ') || '-'}] raw=${sRaw} capped(35)=${sPts}`);

  // geographies (cap 25) or pan-india fallback
  const cgLc = c.geographies.map(lc);
  const geoHits = overlap(c.geographies, p.target_geographies);
  if (geoHits.length) {
    let gRaw = 0;
    const gParts = geoHits.map(g => {
      const rank = cgLc.indexOf(lc(g));
      const pt = rankedPoints(rank, 13, 2, 5);
      gRaw += pt;
      return `${g} (+${pt})`;
    });
    const gPts = Math.min(gRaw, 25);
    total += gPts;
    console.log(`  geographies  : hits=${geoHits.length} [${gParts.join('; ')}] raw=${gRaw} capped(25)=${gPts}`);
  } else if (p.target_geographies.length && c.geographies.some(g => lc(g).includes('pan-india'))) {
    const pts = 6 + Math.min(c.geographies.length, 6);
    total += pts;
    console.log(`  geographies  : no direct hit; Pan-India fallback (footprint=${c.geographies.length}) → +${pts} (range 7..12, cap 12)`);
  } else {
    console.log(`  geographies  : hits=0, no pan-india fallback → +0 (company geos: [${c.geographies.join(', ') || 'NONE'}])`);
  }

  // keywords (cap 20)
  const kwHits = present(c.description, p.keywords);
  const kwPts = Math.min(kwHits.length * 7, 20);
  total += kwPts;
  console.log(`  keywords     : hits=${kwHits.length}/${p.keywords.length} [${kwHits.join(', ') || '-'}] raw=${kwHits.length * 7} capped(20)=${kwPts}`);

  // technologies (cap 20)
  const techHits = present(c.description, p.technologies);
  const tPts = Math.min(techHits.length * 10, 20);
  total += tPts;
  console.log(`  technologies : hits=${techHits.length}/${p.technologies.length} [${techHits.join(', ') || '-'}] raw=${techHits.length * 10} capped(20)=${tPts}`);

  // affinity (cap 25)
  let aRaw = 0;
  const aParts: string[] = [];
  for (const sector of p.target_sectors) {
    const kws = SECTOR_KEYWORDS[sector] ?? [sector];
    let h = 0;
    for (const kw of kws) h += occurrences(c.description, kw);
    if (h > 0) { const pt = Math.min(h, 3) * 3; aRaw += pt; aParts.push(`${sector} (${h} occ → +${pt})`); }
  }
  for (const geo of p.target_geographies) {
    const h = occurrences(c.description, geo);
    if (h > 0) { const pt = Math.min(h, 3) * 2; aRaw += pt; aParts.push(`${geo} (${h} occ → +${pt})`); }
  }
  const aPts = Math.min(aRaw, 25);
  total += aPts;
  console.log(`  affinity     : [${aParts.join('; ') || '-'}] raw=${aRaw} capped(25)=${aPts}`);

  // domain focus (cap 12)
  const platformDomains = new Set(Object.keys(DOMAIN_LABELS));
  const dHits = (c.domain_focus ?? []).filter(d => platformDomains.has(d));
  const dPts = Math.min(dHits.length * 4, 12);
  total += dPts;
  console.log(`  domain_focus : hits=${dHits.length} [${dHits.join(', ') || '-'}] raw=${dHits.length * 4} capped(12)=${dPts}`);

  const final = Math.min(100, total);
  console.log(`  TOTAL        : sum=${total} → final(min 100)=${final}`);
  return final;
}

function theoreticalCeiling(p: ProfileInput): void {
  // Best case: company lists every profile sector/geo at its top ranks.
  let sMax = 0;
  for (let i = 0; i < p.target_sectors.length; i++) sMax += rankedPoints(i, 12, 2, 4);
  sMax = Math.min(sMax, 35);
  let gMax = 0;
  for (let i = 0; i < p.target_geographies.length; i++) gMax += rankedPoints(i, 13, 2, 5);
  gMax = Math.min(gMax, 25);
  const kwMax = Math.min(p.keywords.length * 7, 20);
  const tMax = Math.min(p.technologies.length * 10, 20);
  const aMax = Math.min(9 * p.target_sectors.length + 6 * p.target_geographies.length, 25);
  const dMax = 12;
  const total = Math.min(100, sMax + gMax + kwMax + tMax + aMax + dMax);
  console.log(`\nTHEORETICAL CEILING for the current profile (perfect company):`);
  console.log(`  sectors max=${sMax}/35  geos max=${gMax}/25  keywords max=${kwMax}/20  tech max=${tMax}/20  affinity max=${aMax}/25  domain max=${dMax}/12`);
  console.log(`  => best possible profile-match score: ${total}/100`);
}

async function main() {
  const profile = await getMatchProfile();
  console.log('══════════════════════ SAVED MATCH PROFILE ══════════════════════');
  console.log(`  target_sectors     (${profile.target_sectors.length}): [${profile.target_sectors.join(', ')}]`);
  console.log(`  target_geographies (${profile.target_geographies.length}): [${profile.target_geographies.join(', ')}]`);
  console.log(`  keywords           (${profile.keywords.length}): [${profile.keywords.join(', ')}]`);
  console.log(`  technologies       (${profile.technologies.length}): [${profile.technologies.join(', ')}]`);
  theoreticalCeiling(profile);

  for (const t of TARGETS) {
    const { rows } = await getPool().query(
      `SELECT id, name, data, source_urls, profile_match_score FROM entities
       WHERE category != 'govt_scheme' AND name LIKE $1 ORDER BY name LIMIT 1`, [`%${t}%`]);
    if (!rows.length) { console.log(`\n### ${t}: NOT FOUND in entities`); continue; }
    const r = rows[0];
    const data = r.data || {};

    // ── replicate flattenCompany field derivation exactly ──
    const sectors: string[] = Array.isArray(data.sector_focus?.value) ? data.sector_focus.value : [];
    const geographies: string[] = Array.isArray(data.geography_focus?.value) ? data.geography_focus.value : [];
    const keyPrograms: string[] = Array.isArray(data.key_programs?.value) ? data.key_programs.value : [];
    const domainFocus: string[] = Array.isArray(data.domain_focus) ? data.domain_focus : [];
    const rawNotes: string = data.raw_notes || '';
    const spendVals = data.csr_spend_cr?.value ? Object.values(data.csr_spend_cr.value) as number[] : [];
    const csrSpendActualCr = spendVals.length > 0 ? spendVals[0] : 0;
    const keyContacts = Array.isArray(data.key_contacts) ? data.key_contacts : [];
    const contactEmail: string | null =
      data.contact_email?.value || pickOfficialContact(keyContacts)?.email || null;
    const sourceUrls: string[] = r.source_urls || [];
    const manualScore = typeof data.manual_score === 'number' ? data.manual_score : null;

    console.log(`\n════════ ${r.name} (${r.id.slice(0, 8)}) ════════`);
    console.log(`raw fields: sectors=${sectors.length} geos=${geographies.length} keyPrograms=${keyPrograms.length} rawNotes=${rawNotes.length} chars, domain_focus=[${domainFocus.join(',') || '-'}]`);

    // ── 1. PROFILE MATCH (dashboard /api/companies path) ──
    const description = [rawNotes, r.name ?? '', sectors.join(' '), keyPrograms.join(' ')].join(' ');
    const input: CompanyMatchInput = { sectors, geographies, description, domain_focus: domainFocus };
    console.log('PROFILE MATCH trace:');
    const traced = traceProfileMatch(input, profile);
    const real = computeProfileMatch(input, profile);
    const stored = typeof r.profile_match_score === 'number' ? r.profile_match_score : null;
    console.log(`  real computeProfileMatch=${real.score} ${traced === real.score ? '(trace matches ✓)' : `(TRACE MISMATCH! traced=${traced})`}  persisted profile_match_score=${stored}`);

    // ── 2. BASE DATA SCORE (dashboard.html displayScore semantics) ──
    const spendKnown = Number(csrSpendActualCr) > 0;
    const hasDocument = sourceUrls.length > 0;
    const hasContactInfo = !!contactEmail;
    const secPts = Math.min(sectors.length, 10) * 2;
    const geoPts = Math.min(geographies.length, 10) * 2;
    console.log('BASE DATA SCORE trace (UI displayScore semantics):');
    console.log(`  sectors found    : ${sectors.length}/10 → +${secPts} (max 20)  [${sectors.slice(0, 8).join(', ') || '-'}]`);
    console.log(`  geographies found: ${geographies.length}/10 → +${geoPts} (max 20)  [${geographies.slice(0, 8).join(', ') || '-'}]`);
    console.log(`  spend known      : ${spendKnown ? `YES (first value=${csrSpendActualCr} Cr of ${spendVals.length} FY entries)` : `NO (csr_spend_cr=${JSON.stringify(data.csr_spend_cr?.value ?? null)})`} → +${spendKnown ? 25 : 0} (max 25)`);
    console.log(`  hasDocument      : ${hasDocument ? `YES (${sourceUrls.length} source_urls)` : 'NO (source_urls empty)'} → +${hasDocument ? 20 : 0} (max 20)`);
    console.log(`  hasContactInfo   : ${hasContactInfo ? `YES (${contactEmail})${data.contact_email?.value ? ' [extracted contact_email]' : ' [official mailbox from key_contacts]'}` : `NO (contact_email null, key_contacts=${keyContacts.length} none official)`} → +${hasContactInfo ? 15 : 0} (max 15)`);
    const realBase = scoreCompany({ sectors, geographies, spend: spendKnown ? Number(csrSpendActualCr) : null, hasDocument, hasContactInfo });
    const displayed = manualScore ?? realBase;
    console.log(`  TOTAL            : ${secPts}+${geoPts}+${spendKnown ? 25 : 0}+${hasDocument ? 20 : 0}+${hasContactInfo ? 15 : 0} = ${realBase} (real scoreCompany=${realBase})${manualScore !== null ? `  ⚠ manualScore override=${manualScore} → displayed=${displayed}` : ''}`);

    // enrichment-time variant (what the agent stores): contact_email ONLY, no key_contacts fallback
    const enrichContact = !!(data.contact_email?.value);
    if (enrichContact !== hasContactInfo) {
      console.log(`  NOTE: enrichment-time hasContactInfo would be ${enrichContact} (agent uses extracted contact_email only; UI adds key_contacts fallback)`);
    }
  }
  await closePool();
}

main().catch(err => { console.error(err); process.exit(1); });
