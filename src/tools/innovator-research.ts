// Deep research for a newly added innovator — same free, keyless sources the
// funder pipeline uses (IndiaCSR, Wikipedia, Screener), then deterministic
// extraction: founding year, founders, awards, TRL, sustainability indicators,
// geography. No LLM, no search engines.

import { gatherSourceText } from './free-sources.js';
import { extractGeographies, generateSummary, extractExecutiveContacts, mergeExecutiveContacts, type ExecutiveContact } from '../utils/extractor.js';
import { detectCircularityIndicators, scoreSustainability } from '../utils/sustainability.js';
import { detectFeasibilitySignals, type FeasibilitySignals } from '../utils/feasibility.js';
import { inferTRL } from '../utils/trl.js';
import { DOMAIN_KEYWORDS } from '../utils/innovator-match.js';
import { getInnovatorById, updateInnovator } from '../db/index.js';
import { beginProgress, setStage, addSource, endProgress } from '../utils/enrichment-progress.js';
import { logger } from '../utils/logger.js';
import type { CircularityIndicators, InnovatorDomain } from '../types/index.js';

// Re-exported for existing callers/tests — the implementations moved to
// utils/sustainability.ts so scoring is available at insert time too.
export { detectCircularityIndicators, scoreSustainability };

const MIN_COMBINED_CHARS = 100;

// Startup HQs are usually named by city, not state — map the big ones.
const CITY_STATE: Record<string, string> = {
  'new delhi': 'Delhi', delhi: 'Delhi', gurugram: 'Haryana', gurgaon: 'Haryana', noida: 'Uttar Pradesh',
  bengaluru: 'Karnataka', bangalore: 'Karnataka', mumbai: 'Maharashtra', pune: 'Maharashtra',
  ahmedabad: 'Gujarat', chennai: 'Tamil Nadu', hyderabad: 'Telangana', kolkata: 'West Bengal',
  kanpur: 'Uttar Pradesh', lucknow: 'Uttar Pradesh', jaipur: 'Rajasthan', kochi: 'Kerala',
};

export interface InnovatorResearch {
  summary: string;
  founding_year: number | null;
  founders: string[];
  awards: string[];
  trl: ReturnType<typeof inferTRL>;
  circularity_indicators: CircularityIndicators;
  sustainability_score: number;
  key_contacts: ExecutiveContact[];
  geographies: string[];
  domain_guess: InnovatorDomain | null;
  feasibility: FeasibilitySignals;
  source_urls: string[];
  combined_chars: number;
}

export function extractFoundingYear(text: string): number | null {
  const m = text.match(/\b(?:founded|established|incorporated|started)\b[^.]{0,60}?\b((?:19|20)\d{2})\b/i);
  return m ? parseInt(m[1]) : null;
}

export function extractFounders(text: string): string[] {
  const m = text.match(/\b(?:founded|co-founded|started)\s+(?:in\s+\d{4}\s+)?by\s+([A-Z][A-Za-z.]+(?:\s+[A-Z][A-Za-z.]+){0,2}(?:\s*(?:,|and)\s*[A-Z][A-Za-z.]+(?:\s+[A-Z][A-Za-z.]+){0,2}){0,3})/);
  if (!m) return [];
  return m[1].split(/\s*(?:,|\band\b)\s*/).map(s => s.trim()).filter(s => s.length > 2).slice(0, 4);
}

export function extractAwards(text: string): string[] {
  const awards: string[] = [];
  const re = /[^.\n]{0,80}\b(award|awarded|recognition|recognised|recognized|winner|prize|laureate)\b[^.\n]{0,80}/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && awards.length < 5) {
    const s = m[0].replace(/\s+/g, ' ').trim();
    if (s.length > 15) awards.push(s);
  }
  return awards;
}

/** Best-hit domain guess from the innovator's corpus (null when nothing matches). */
export function guessDomain(text: string): InnovatorDomain | null {
  const t = text.toLowerCase();
  let best: InnovatorDomain | null = null;
  let bestHits = 0;
  for (const [domain, kws] of Object.entries(DOMAIN_KEYWORDS)) {
    let hits = 0;
    for (const kw of kws) if (t.includes(kw)) hits++;
    if (hits > bestHits) { bestHits = hits; best = domain as InnovatorDomain; }
  }
  return best;
}

/** Geography from state names + HQ city mentions. */
export function extractInnovatorGeography(text: string): string[] {
  const states = new Set(extractGeographies(text).filter(g => g !== 'Pan-India'));
  const t = text.toLowerCase();
  for (const [city, state] of Object.entries(CITY_STATE)) {
    if (new RegExp(`\\b(?:based in|headquarter\\w* in|hq in|located in)\\s+${city}\\b`).test(t)) states.add(state);
  }
  return [...states];
}

/** Run all free sources for a name and extract everything deterministically. */
export async function researchInnovator(
  name: string,
  website?: string | null,
  type?: string | null,
  onProgress?: import('./free-sources.js').SourceProgressFn,
): Promise<InnovatorResearch | null> {
  // Screener is ticker-keyed; a cleaned-name guess lets listed startups resolve
  // (unlisted ones just 404 and are filtered out by gatherSourceText).
  const tickerGuess = name.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 15);
  const { combined, perSource } = await gatherSourceText(
    { name, ticker: tickerGuess, website: website ?? null, kind: 'innovator', innovatorType: type ?? null },
    website ? [website] : [],
    onProgress,
  );
  if (combined.trim().length < MIN_COMBINED_CHARS) {
    logger.warn('Innovator research found no usable source text', { name });
    return null;
  }

  const indicators = detectCircularityIndicators(combined);
  // Per-source contact extraction keeps the source label on each contact;
  // merge applies source-trust priority (own site > filings > aggregators) and
  // labels aggregator-only names as unverified.
  const keyContacts = mergeExecutiveContacts(perSource
    .filter(s => s.success)
    .map(s => extractExecutiveContacts(s.text, s.label, name, website ?? null)));
  return {
    summary: generateSummary(combined),
    founding_year: extractFoundingYear(combined),
    founders: extractFounders(combined),
    awards: extractAwards(combined),
    trl: inferTRL(combined),
    circularity_indicators: indicators,
    sustainability_score: scoreSustainability(combined, indicators),
    key_contacts: keyContacts,
    geographies: extractInnovatorGeography(combined),
    domain_guess: guessDomain(combined),
    feasibility: detectFeasibilitySignals(combined),
    source_urls: perSource.filter(s => s.success).map(s => s.url),
    combined_chars: combined.length,
  };
}

/**
 * Research an innovator by id and merge the findings into its row. User-provided
 * values always win — research only fills gaps (and always refreshes the
 * research payload in `data`).
 */
export async function enrichInnovator(id: string): Promise<boolean> {
  const row = await getInnovatorById(id);
  if (!row) return false;

  // Live per-source progress under the innovator's id — the dashboard's batch
  // status endpoint reads it for "Currently: <name> — fetching <source>".
  beginProgress(id, row.name);
  let research;
  try {
    research = await researchInnovator(row.name, row.website, row.type, ev => {
      if (ev.phase === 'fetching') setStage(id, `Fetching ${ev.label}…`);
      else addSource(id, { label: ev.label, url: ev.url, success: !!ev.success, chars: ev.chars ?? 0 });
    });
  } catch (err) {
    endProgress(id, err instanceof Error ? err.message : String(err));
    throw err;
  }
  if (!research) {
    await updateInnovator(id, { data: { ...row.data, research_at: new Date().toISOString(), research_empty: true } });
    endProgress(id, 'No usable source text found');
    return false;
  }

  const patch: Parameters<typeof updateInnovator>[1] = {
    data: {
      ...row.data,
      research_at: new Date().toISOString(),
      founding_year: research.founding_year,
      founders: research.founders,
      awards: research.awards,
      source_urls: research.source_urls,
      research_summary: research.summary,
      trl_detected: research.trl,
      domain_guess: research.domain_guess,
    },
    key_contacts: research.key_contacts,
  };
  if (!row.description) patch.description = research.summary;
  if (!row.founder_name && research.founders.length) patch.founder_name = research.founders.join(', ');
  if (row.trl_current == null && research.trl.band !== 'unknown') {
    patch.trl_current = Math.round((research.trl.min + research.trl.max) / 2);
  }
  if ((!row.geography || !row.geography.length) && research.geographies.length) {
    patch.geography = research.geographies;
  }
  // Indicators/score: only upgrade — never downgrade user-entered values.
  const existing = row.circularity_indicators || {};
  patch.circularity_indicators = {
    closed_loop: !!existing.closed_loop || research.circularity_indicators.closed_loop,
    zero_waste: !!existing.zero_waste || research.circularity_indicators.zero_waste,
    renewable_energy: !!existing.renewable_energy || research.circularity_indicators.renewable_energy,
    circular_economy: !!existing.circular_economy || research.circularity_indicators.circular_economy,
  };
  patch.sustainability_score = Math.max(row.sustainability_score ?? 0, research.sustainability_score);

  // ── Feasibility signals (best-effort, low-confidence) ────────────────────────
  // Only fill fields that are still empty/unknown AND not manually locked. Users
  // correct these via the Feasibility tab; corrections lock the field in
  // data.feasibility_overrides so re-enrichment never overwrites them.
  const locks = (row.data?.feasibility_overrides || {}) as Record<string, boolean>;
  const f = research.feasibility;
  if (!locks.indigenous_tech && row.indigenous_tech == null && f.indigenous_tech != null) {
    patch.indigenous_tech = f.indigenous_tech;
  }
  if (!locks.govt_mission_alignment && f.govt_mission_alignment.length) {
    const existing = Array.isArray(row.govt_mission_alignment) ? row.govt_mission_alignment : [];
    patch.govt_mission_alignment = [...new Set([...existing, ...f.govt_mission_alignment])];
  }
  if (!locks.subsidy_land_electricity) {
    const cur = (row.subsidy_land_electricity || {}) as Record<string, unknown>;
    const det = f.subsidy_land_electricity;
    const land = cur.land_subsidy != null ? cur.land_subsidy : det.land_subsidy;
    const power = cur.electricity_subsidy != null ? cur.electricity_subsidy : det.electricity_subsidy;
    if (land != null || power != null) {
      patch.subsidy_land_electricity = {
        land_subsidy: land, electricity_subsidy: power,
        notes: (cur.notes as string) ?? det.notes,
      };
    }
  }
  if (!locks.capex_subsidy_available && row.capex_subsidy_available == null && f.capex_subsidy_available != null) {
    patch.capex_subsidy_available = f.capex_subsidy_available;
    patch.capex_subsidy_notes = f.capex_subsidy_notes;
  }
  if (!locks.opex_subsidy_available && row.opex_subsidy_available == null && f.opex_subsidy_available != null) {
    patch.opex_subsidy_available = f.opex_subsidy_available;
    patch.opex_subsidy_notes = f.opex_subsidy_notes;
  }
  (patch.data as Record<string, unknown>).feasibility_detected_at = new Date().toISOString();

  await updateInnovator(id, patch);
  endProgress(id);
  logger.info('Innovator research merged', { id, name: row.name, chars: research.combined_chars, sources: research.source_urls.length });
  return true;
}
