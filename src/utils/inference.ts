// Heuristic inference — produces SYNTHETIC values (industry→sector, HQ→geography,
// spend estimate). These are guesses, NOT extracted facts, and callers MUST store
// them in separate "inferred"/"estimated" fields, never as found-in-source data.

// ─── Industry → CSR sector mapping ───────────────────────────────────────────

interface IndustryRule { label: string; match: RegExp; sectors: string[]; }

// Named-company rules — highest priority. Some large caps have no industry word
// in their NAME (Cipla, Reliance, L&T, ITC, ONGC…), so name-only inference used
// to fall through to a generic "Education" default. These map those companies to
// their real CSR focus. Checked before {@link INDUSTRY_RULES}; ties in hit-count
// resolve to whichever rule was declared first (stable sort), so these win.
const COMPANY_NAME_RULES: IndustryRule[] = [
  { label: 'Foundation (named)', match: /\b(tata trusts?|infosys foundation|wipro foundation|azim premji foundation)\b/i, sectors: ['Education', 'Skill Development'] },
  { label: 'Pharma (named)',     match: /\b(cipla|dr\.?\s*reddy'?s?|sun pharma\w*|lupin|aurobindo|torrent pharma)\b/i, sectors: ['Healthcare'] },
  { label: 'Oil & Energy (named)', match: /\b(reliance industries|reliance foundation|ongc|bpcl|iocl|indian oil|hindustan petroleum|gail\s+(?:india|limited|ltd)|coal india)\b/i, sectors: ['Environment', 'Rural Development'] },
  { label: 'Engineering (named)',  match: /\b(l\s*&\s*t|larsen(?:\s*&\s*toubro)?)\b/i, sectors: ['Environment', 'Skill Development'] },
  { label: 'ITC',                match: /\bitc\b/i, sectors: ['Rural Development', 'Women Empowerment', 'Sanitation'] },
];

// Industry → CSR-sector rules, ordered most-specific first. Mappings are
// deliberately industry-appropriate — banks are NOT mapped to Education, paints
// are NOT mapped to Education, etc. Education is only inferred for industries
// where it is genuinely primary (IT/skilling), never as a catch-all.
const INDUSTRY_RULES: IndustryRule[] = [
  { label: 'Banking/Finance', match: /\b(bank|banking|financial services|financial|insurance|nbfc|finance|mutual fund|securities|prudential|lombard|life insurance|asset management)\b/i, sectors: ['Financial Inclusion', 'Skill Development'] },
  { label: 'Pharma/Healthcare', match: /\b(pharma|pharmaceutical|pharmaceuticals|drugs?|biotech|life ?sciences|laboratories|healthcare|hospital|diagnostics|lifesciences)\b/i, sectors: ['Healthcare', 'Rural Development'] },
  { label: 'IT/Software',     match: /\b(software|it services|information technology|saas|consulting|consultancy|infotech|technolog\w*|systems|digital services|infosys|wipro|mindtree|mphasis|cognizant)\b/i, sectors: ['Technology', 'Skill Development', 'Education'] },
  { label: 'Auto',            match: /\b(automobile|automotive|motors?|two-wheeler|vehicle|\bauto\b|tyres?|tractor)\b/i, sectors: ['Environment', 'Skill Development'] },
  { label: 'Paint/Materials', match: /\b(paints?|cement|steel|metals?|aluminium|aluminum|mining|materials|chemicals?|fertiliser|fertilizer)\b/i, sectors: ['Environment', 'Rural Development'] },
  { label: 'Energy/Power',    match: /\b(energy|power|oil|gas|petroleum|renewable|electricity|coal|solar|thermal|petrochemical)\b/i, sectors: ['Environment', 'Rural Development'] },
  { label: 'FMCG/Consumer',   match: /\b(fmcg|consumer goods|consumer products|detergent|personal care|packaged foods?|beverages?|foods?|dairy|breweries|distilleries)\b/i, sectors: ['Rural Development', 'Women Empowerment', 'Sanitation'] },
  { label: 'Telecom',         match: /\b(telecom|telecommunications?|mobile network|broadband|airtel|vodafone)\b/i, sectors: ['Technology', 'Skill Development'] },
];

export interface SectorInference { sectors: string[]; basis: string; }

// Hard ceiling on inferred sectors — inference is a guess, so keep it tight.
const MAX_INFERRED_SECTORS = 3;

/**
 * Infer CSR sectors from the industry implied by the company's text.
 *
 * Inference is deliberately conservative:
 *  - industries are ranked by how often their keywords appear (more hits = more
 *    confident), and sectors are taken highest-confidence first;
 *  - at most {@link MAX_INFERRED_SECTORS} (3) sectors are ever returned;
 *  - we never infer MORE sectors than were actually found across the real
 *    sources (pass `foundSectorCount`), so guesses can't outweigh evidence.
 *
 * `foundSectorCount` defaults to unbounded for standalone/diagnostic use; the
 * enrichment agent passes the count of extracted `sector_focus` values.
 */
export function inferSectorsFromText(text: string, foundSectorCount = Number.POSITIVE_INFINITY): SectorInference {
  if (!text) return { sectors: [], basis: '' };

  // Named-company rules first, then generic industry rules. Rank by keyword-hit
  // count — the most-mentioned wins; equal hits keep declaration order (stable
  // sort), so a matched company rule outranks a generic industry rule on a tie.
  const ranked = [...COMPANY_NAME_RULES, ...INDUSTRY_RULES]
    .map(rule => ({ rule, hits: (text.match(new RegExp(rule.match.source, 'gi')) ?? []).length }))
    .filter(r => r.hits > 0)
    .sort((a, b) => b.hits - a.hits);

  if (!ranked.length) return { sectors: [], basis: '' };

  const cap = Math.min(MAX_INFERRED_SECTORS, foundSectorCount);
  const sectors: string[] = [];
  const labels: string[] = [];
  for (const { rule } of ranked) {
    if (sectors.length >= cap) break;
    if (!labels.includes(rule.label)) labels.push(rule.label);
    for (const s of rule.sectors) {
      if (sectors.length >= cap) break;
      if (!sectors.includes(s)) sectors.push(s);
    }
  }
  return { sectors, basis: labels.join(', ') };
}

// ─── CIN state code → state (geography inference) ────────────────────────────

const CIN_STATE: Record<string, string> = {
  AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh', AS: 'Assam', BR: 'Bihar', CG: 'Chhattisgarh',
  GA: 'Goa', GJ: 'Gujarat', HR: 'Haryana', HP: 'Himachal Pradesh', JH: 'Jharkhand',
  KA: 'Karnataka', KL: 'Kerala', MP: 'Madhya Pradesh', MH: 'Maharashtra', MN: 'Manipur',
  ML: 'Meghalaya', MZ: 'Mizoram', NL: 'Nagaland', OR: 'Odisha', OD: 'Odisha', PB: 'Punjab',
  RJ: 'Rajasthan', SK: 'Sikkim', TN: 'Tamil Nadu', TG: 'Telangana', TS: 'Telangana',
  TR: 'Tripura', UP: 'Uttar Pradesh', UK: 'Uttarakhand', UA: 'Uttarakhand', WB: 'West Bengal',
  AN: 'Andaman and Nicobar Islands', CH: 'Chandigarh', DL: 'Delhi', JK: 'Jammu and Kashmir',
  LA: 'Ladakh', LD: 'Lakshadweep', PY: 'Puducherry',
};

export interface GeographyInference { geographies: string[]; basis: string; }

/** Infer a likely home state from the CIN's embedded state code (chars 6–7). */
export function inferGeographyFromCIN(cin: string | null | undefined): GeographyInference {
  if (!cin || cin.length < 8) return { geographies: [], basis: '' };
  const code = cin.substring(6, 8).toUpperCase();
  const state = CIN_STATE[code];
  return state ? { geographies: [state], basis: `CIN state code ${code}` } : { geographies: [], basis: '' };
}

// ─── Spend estimation (2% of net profit — Companies Act mandated minimum) ─────

export interface SpendEstimate { estimatedCr: number | null; basis: string; }

/**
 * Estimate CSR spend as 2% of net profit (the statutory minimum), reading net
 * profit in crore from the company's financial text. Returns null if not found.
 */
export function estimateSpendFromProfit(text: string): SpendEstimate {
  if (!text) return { estimatedCr: null, basis: '' };
  const m = text.match(/net profit[^0-9]{0,40}?([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:crores?|cr)\b/i);
  if (!m) return { estimatedCr: null, basis: '' };
  const profit = parseFloat(m[1].replace(/,/g, ''));
  if (Number.isNaN(profit) || profit <= 0) return { estimatedCr: null, basis: '' };
  const est = Math.round(profit * 0.02 * 100) / 100;
  return { estimatedCr: est, basis: `2% of net profit ₹${profit} cr` };
}
