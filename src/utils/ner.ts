// Deterministic named-entity recognition for Indian company/organisation names.
// No LLM: matches a run of Capitalized tokens immediately followed by a known
// company suffix (Ltd, Limited, Foundation, Industries, Corporation, ...).

const SUFFIXES = [
  'Ltd', 'Limited', 'Foundation', 'Industries', 'Corporation', 'Corp',
  'Technologies', 'Motors', 'Bank', 'Trust', 'Enterprises', 'Pharma',
];

// 1–4 capitalized words, then a suffix. Allows &, ., - inside a token.
const NAME_RE = new RegExp(
  '\\b([A-Z][A-Za-z&.\\-]+(?:\\s+[A-Z][A-Za-z&.\\-]+){0,4}\\s+(?:' +
    SUFFIXES.map(s => s + '\\.?').join('|') +
  '))\\b',
  'g',
);

// Leading filler words that shouldn't start a company name.
const LEADING_NOISE = /^(The|And|For|In|Of|To|With|Under|By|At|On|As|Youth|Placed)\s+/i;

/**
 * Extract candidate company/organisation names from free text.
 * Returns a de-duplicated, lightly-cleaned list.
 */
export function extractCompanyNames(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  NAME_RE.lastIndex = 0;
  while ((m = NAME_RE.exec(text)) !== null) {
    let name = m[1].replace(/\s+/g, ' ').trim();
    // Strip leading filler words ("Youth Placed Under SBI Foundation" → "SBI Foundation")
    for (let i = 0; i < 4 && LEADING_NOISE.test(name); i++) name = name.replace(LEADING_NOISE, '').trim();
    if (name.length < 4 || name.length > 80) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}
