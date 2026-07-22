// Live curated search across the SAME trusted, keyless sources the enrichment
// pipeline already uses (Wikipedia, Screener, IndiaCSR, YourStory, Inc42).
// Given a free-text query it returns candidate entity LEADS — name + snippet +
// source domain + source URL — NOT verified data. Every source is fetched
// fail-soft: a blocked/empty source contributes nothing and never throws the
// whole search. No search engines, no API keys, no LLM.

import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../utils/logger.js';

export interface SearchLead {
  name: string;
  snippet: string;
  source: string;                 // human label, e.g. "Wikipedia"
  url: string;
  /** Which quick-action to suggest. Screener rows are listed companies; the
   *  rest are ambiguous and default to 'unknown' (UI offers both actions). */
  suggestedType: 'innovator' | 'company' | 'unknown';
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};
const TIMEOUT = 12000;

const clean = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();
export const normName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ─── Individual trusted sources ──────────────────────────────────────────────

/** Wikipedia OpenSearch API (JSON, keyless, reliable): titles + descriptions + urls. */
export async function searchWikipedia(q: string): Promise<SearchLead[]> {
  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=6&search=${encodeURIComponent(q)}`;
  const { data } = await axios.get(url, { headers: HEADERS, timeout: TIMEOUT });
  const titles: string[] = Array.isArray(data?.[1]) ? data[1] : [];
  const descs: string[] = Array.isArray(data?.[2]) ? data[2] : [];
  const urls: string[] = Array.isArray(data?.[3]) ? data[3] : [];
  return titles
    .map((t, i) => ({ name: clean(t), snippet: clean(descs[i]) || 'Wikipedia article', source: 'Wikipedia', url: urls[i] || '', suggestedType: 'unknown' as const }))
    .filter(l => l.name);
}

/** Screener company search API (JSON) — listed Indian companies. */
export async function searchScreener(q: string): Promise<SearchLead[]> {
  const url = `https://www.screener.in/api/company/search/?q=${encodeURIComponent(q)}`;
  const { data } = await axios.get(url, {
    headers: { ...HEADERS, Accept: 'application/json', Referer: 'https://www.screener.in/' },
    timeout: TIMEOUT,
  });
  const arr: any[] = Array.isArray(data) ? data : [];
  return arr.slice(0, 6)
    .map(r => ({ name: clean(r.name), snippet: 'Listed company (Screener financials)', source: 'Screener', url: r.url ? `https://www.screener.in${r.url}` : 'https://www.screener.in/', suggestedType: 'company' as const }))
    .filter(l => l.name);
}

/** Parse article/result titles off an HTML search page via cheerio. */
function scrapeTitles(html: string, source: string, selectors: string[], limit = 5): SearchLead[] {
  const $ = cheerio.load(html);
  const leads: SearchLead[] = [];
  const seen = new Set<string>();
  for (const sel of selectors) {
    $(sel).each((_i, el) => {
      if (leads.length >= limit) return;
      const name = clean($(el).text());
      const href = $(el).attr('href') || '';
      const key = normName(name);
      if (name.length >= 5 && name.length <= 140 && !seen.has(key)) {
        seen.add(key);
        leads.push({ name, snippet: `Mentioned on ${source}`, source, url: href, suggestedType: 'unknown' });
      }
    });
  }
  return leads;
}

/** IndiaCSR ?s= search (WordPress) — article headlines as leads. */
export async function searchIndiaCsr(q: string): Promise<SearchLead[]> {
  const url = `https://indiacsr.in/?s=${encodeURIComponent(q)}`;
  const { data } = await axios.get(url, { headers: HEADERS, timeout: TIMEOUT, responseType: 'text' });
  return scrapeTitles(String(data), 'IndiaCSR', ['h2.entry-title a', 'h3.entry-title a', '.post-title a', 'article a[rel="bookmark"]']);
}

/** YourStory search — startup-focused editorial. */
export async function searchYourStory(q: string): Promise<SearchLead[]> {
  const url = `https://yourstory.com/search?q=${encodeURIComponent(q)}`;
  const { data } = await axios.get(url, { headers: HEADERS, timeout: TIMEOUT, responseType: 'text' });
  return scrapeTitles(String(data), 'YourStory', ['h2 a', 'h3 a', 'article a']).map(l => ({ ...l, suggestedType: 'innovator' as const }));
}

/** Inc42 ?s= search — startup-focused editorial. */
export async function searchInc42(q: string): Promise<SearchLead[]> {
  const url = `https://inc42.com/?s=${encodeURIComponent(q)}`;
  const { data } = await axios.get(url, { headers: HEADERS, timeout: TIMEOUT, responseType: 'text' });
  return scrapeTitles(String(data), 'Inc42', ['h2.entry-title a', 'h3.entry-title a', 'article h2 a', 'article a[rel="bookmark"]']).map(l => ({ ...l, suggestedType: 'innovator' as const }));
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

const SOURCES: Array<{ label: string; run: (q: string) => Promise<SearchLead[]> }> = [
  { label: 'Wikipedia', run: searchWikipedia },
  { label: 'Screener', run: searchScreener },
  { label: 'IndiaCSR', run: searchIndiaCsr },
  { label: 'YourStory', run: searchYourStory },
  { label: 'Inc42', run: searchInc42 },
];

/** Dedupe leads by normalized name, keeping the first (best-ranked) occurrence. */
export function dedupeLeads(leads: SearchLead[], limit = 18): SearchLead[] {
  const seen = new Set<string>();
  const out: SearchLead[] = [];
  for (const l of leads) {
    const key = normName(l.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(l);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Run every trusted source concurrently, fail-soft, and return deduped leads.
 * Order interleaves sources so no single source dominates the top of the list.
 */
export async function curatedWebSearch(query: string): Promise<SearchLead[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const settled = await Promise.allSettled(SOURCES.map(s => s.run(q)));
  const perSource: SearchLead[][] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') perSource.push(r.value);
    else logger.debug('Curated source failed', { source: SOURCES[i].label, error: (r.reason as Error)?.message });
  });

  // Round-robin interleave so results are diverse across sources.
  const interleaved: SearchLead[] = [];
  const maxLen = Math.max(0, ...perSource.map(a => a.length));
  for (let i = 0; i < maxLen; i++) {
    for (const arr of perSource) if (arr[i]) interleaved.push(arr[i]);
  }
  const leads = dedupeLeads(interleaved);
  logger.info('Curated web search complete', { query: q, sources: perSource.length, leads: leads.length });
  return leads;
}
