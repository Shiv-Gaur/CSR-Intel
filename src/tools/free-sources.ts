/**
 * Free, search-engine-free source discovery.
 *
 * Keyless web search (DuckDuckGo / Bing / Google scrapers) is actively blocked
 * in many environments (captcha / 429 / connection reset). These providers are
 * reachable by direct URL — no search engine, no API key — so they survive that
 * blocking. Probed working June 2026: Screener.in, IndiaCSR. (CSRBox 404'd and
 * Wikipedia carried no CSR section for the companies tested — both dropped.)
 *
 * Strategy: build candidate URLs per entity, fetch each with the Content-Type
 * aware fetchAuto(), then COMBINE all returned text and run the deterministic
 * extractor once over the combined corpus.
 */
import axios from 'axios';
import { fetchAuto } from './fetcher.js';
import { logger } from '../utils/logger.js';
import type { FetchResult } from '../types/index.js';

export interface SourceEntity {
  name: string;
  ticker?: string | null;
  cin?: string | null;
  website?: string | null;
  /** Which side of the platform the entity is on — picks the source set. */
  kind?: 'company' | 'innovator';
  /** Innovator type ('startup' | 'research_institute' | 'individual') — adds Google Scholar for institutes. */
  innovatorType?: string | null;
}

export interface SourceFetchResult {
  label: string;
  url: string;
  chars: number;
  success: boolean;
  /** Cleaned text from this source (empty when not usable). */
  text: string;
}

/** Minimum usable text length from a single source (filters error/redirect pages). */
const MIN_SOURCE_CHARS = 100;

/**
 * Build candidate source URLs for an entity from free, keyless providers.
 * Screener requires a ticker; IndiaCSR is name-based.
 */
export function buildFreeSourceUrls(entity: SourceEntity): Array<{ label: string; url: string }> {
  const list: Array<{ label: string; url: string }> = [];

  if (entity.ticker && entity.ticker.trim()) {
    list.push({
      label: 'screener',
      url: `https://www.screener.in/company/${encodeURIComponent(entity.ticker.trim())}/`,
    });
  }

  list.push({
    label: 'indiacsr',
    url: `https://indiacsr.in/?s=${encodeURIComponent(entity.name)}`,
  });

  // Wikipedia article (full body) — the only "extreme enrichment" source from the
  // wider list that returns usable text (CSRBox/Tofler/Zauba/MCA/BSE/PRNewswire
  // were all blocked or empty when probed, June 2026).
  list.push({
    label: 'wikipedia',
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(entity.name.replace(/\s+/g, '_'))}`,
  });

  // ── Additional free sources (July 2026) ──────────────────────────────────
  // All keyless and fetched via fetchAuto(); dead/blocked pages return little
  // text and are dropped by the MIN_SOURCE_CHARS filter, so a wrong URL guess
  // costs one fetch, never corrupt data.
  const q = encodeURIComponent(entity.name);
  const slug = entity.name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  if (entity.kind === 'innovator') {
    // Startup/innovator-oriented sources.
    list.push({ label: 'crunchbase', url: `https://www.crunchbase.com/organization/${slug}` });
    list.push({ label: 'yourstory', url: `https://yourstory.com/search?q=${q}` });
    list.push({ label: 'inc42', url: `https://inc42.com/?s=${q}` });
    list.push({ label: 'startupindia', url: `https://www.startupindia.gov.in/content/sih/en/search.html?roles=Startup&page=0&query=${q}` });
    list.push({ label: 'linkedin', url: `https://www.linkedin.com/company/${slug}` });
    list.push({ label: 'nasscom', url: `https://nasscom.in/search/node?keys=${q}` });
    if (entity.innovatorType === 'research_institute') {
      list.push({ label: 'scholar', url: `https://scholar.google.com/scholar?q=${q}` });
    }
  } else {
    // Company/funder-oriented sources.
    list.push({ label: 'moneycontrol', url: `https://www.moneycontrol.com/stocks/cptmarket/compsearchnew.php?topsearch_type=1&search_str=${q}` });
    list.push({ label: 'linkedin', url: `https://www.linkedin.com/company/${slug}` });
    list.push({ label: 'nasscom', url: `https://nasscom.in/search/node?keys=${q}` });

    // Contact-focused pages on the company's OWN site — the only free places
    // that reliably publish emails (Company Secretary per SEBI rules, IR, CSR
    // mailboxes). Wikipedia/LinkedIn/NASSCOM list names but never emails.
    // (BSE was probed July 2026: the site is an Angular shell whose compliance-
    // officer data loads via scrip-code-keyed XHR — not fetchable keylessly.)
    if (entity.website) {
      const root = entity.website.replace(/\/+$/, '');
      list.push({ label: 'contact-page', url: `${root}/contact-us` });
      list.push({ label: 'ir-page', url: `${root}/investor-relations` });
      list.push({ label: 'investors-page', url: `${root}/investors` });
    }

    // Zauba Corp mirrors MCA filings: CURRENT directors with appointment dates —
    // far more reliable for executive names than a possibly-stale wiki edit.
    // URL is /company/<SLUG>/<CIN>; Zauba routes by the CIN, so a best-effort
    // slug is fine. Only attempted when we actually know the CIN.
    // (MCA itself — mca.gov.in master data — is captcha-gated: not scriptable.)
    if (entity.cin) {
      const zslug = entity.name.toUpperCase().replace(/&/g, 'AND').replace(/[^A-Z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      list.push({ label: 'zauba-directors', url: `https://www.zaubacorp.com/company/${zslug}/${entity.cin.trim()}` });
    }
  }

  return list;
}

// ─── Exchange announcement feeds (dated, updated daily) ──────────────────────
// BSE/NSE corporate filings are the most CURRENT public source about a listed
// company. Both sites are bot-hostile (Angular shells, cookie-gated JSON APIs);
// these helpers speak to the underlying APIs directly and fail soft — a block
// costs one fetch and the MIN_SOURCE_CHARS gate drops the empty result.

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

const ymd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

/** BSE: resolve the scrip code by name, then pull the last 90 days of corporate announcements. */
export async function fetchBseAnnouncements(companyName: string): Promise<FetchResult> {
  const listUrl = 'https://api.bseindia.com/BseIndiaAPI/api/AnnGetData/w';
  const fetchedAt = new Date().toISOString();
  try {
    const search = await axios.get('https://api.bseindia.com/BseIndiaAPI/api/PeerSmartSearch/w', {
      params: { Type: 'SS', text: companyName },
      headers: { ...BROWSER_HEADERS, Referer: 'https://www.bseindia.com/' },
      timeout: 15000,
    });
    const scrip = String(search.data ?? '').match(/\b(5\d{5})\b/)?.[1];
    if (!scrip) throw new Error('no scrip code found for name');

    const to = new Date();
    const from = new Date(to.getTime() - 90 * 24 * 3600 * 1000);
    const ann = await axios.get(listUrl, {
      params: {
        pageno: 1, strCat: '-1', strPrevDate: ymd(from), strScrip: scrip,
        strSearch: 'P', strToDate: ymd(to), strType: 'C',
      },
      headers: { ...BROWSER_HEADERS, Referer: 'https://www.bseindia.com/' },
      timeout: 15000,
    });
    const rows: any[] = ann.data?.Table ?? [];
    const text = rows.map(r =>
      `BSE announcement ${String(r.NEWS_DT ?? '').slice(0, 10)}: ${r.NEWSSUB ?? ''} ${r.HEADLINE ?? ''}`.trim()
    ).join('\n');
    return { url: `${listUrl}?strScrip=${scrip}`, content: text, content_type: 'html', fetched_at: fetchedAt, success: text.length > 0 };
  } catch (err: any) {
    logger.debug('BSE announcements fetch failed', { companyName, error: err.message });
    return { url: listUrl, content: '', content_type: 'html', fetched_at: fetchedAt, success: false, error: err.message };
  }
}

/** NSE: cookie-warmup then the corporate-announcements JSON API (needs the ticker symbol). */
export async function fetchNseAnnouncements(ticker: string): Promise<FetchResult> {
  const apiUrl = `https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(ticker)}`;
  const fetchedAt = new Date().toISOString();
  try {
    const warm = await axios.get('https://www.nseindia.com', {
      headers: { ...BROWSER_HEADERS, Accept: 'text/html' }, timeout: 15000,
    });
    const cookies = (warm.headers['set-cookie'] ?? []).map(c => c.split(';')[0]).join('; ');
    const res = await axios.get(apiUrl, {
      headers: { ...BROWSER_HEADERS, Accept: 'application/json', Referer: 'https://www.nseindia.com/companies-listing/corporate-filings-announcements', Cookie: cookies },
      timeout: 15000,
    });
    const rows: any[] = Array.isArray(res.data) ? res.data : [];
    const text = rows.map(r =>
      `NSE announcement ${r.an_dt ?? r.exchdisstime ?? ''}: ${r.desc ?? ''} ${r.attchmntText ?? ''}`.trim()
    ).join('\n');
    return { url: apiUrl, content: text.slice(0, 15000), content_type: 'html', fetched_at: fetchedAt, success: text.length > 0 };
  } catch (err: any) {
    logger.debug('NSE announcements fetch failed', { ticker, error: err.message });
    return { url: apiUrl, content: '', content_type: 'html', fetched_at: fetchedAt, success: false, error: err.message };
  }
}

/** Live per-source progress events, consumed by the dashboard's enrichment-status endpoint. */
export type SourceProgressFn = (ev: {
  phase: 'fetching' | 'fetched';
  label: string;
  url: string;
  success?: boolean;
  chars?: number;
}) => void;

/**
 * Fetch every candidate source (free providers first, then any extra/known URLs,
 * then the BSE/NSE exchange feeds for companies), and return the combined text
 * plus per-source diagnostics. Deduplicates by URL.
 */
export async function gatherSourceText(
  entity: SourceEntity,
  extraUrls: string[] = [],
  onProgress?: SourceProgressFn,
): Promise<{ combined: string; perSource: SourceFetchResult[] }> {
  const jobs: Array<{ label: string; url: string; run: () => Promise<FetchResult> }> = [
    ...buildFreeSourceUrls(entity),
    ...extraUrls.filter(Boolean).map(url => ({ label: 'known', url })),
  ].map(c => ({ ...c, run: () => fetchAuto(c.url) }));

  // Exchange filings — dated, updated daily, the most current public record.
  if (entity.kind !== 'innovator') {
    jobs.push({
      label: 'bse-announcements',
      url: 'https://www.bseindia.com/corporates/ann.html',
      run: () => fetchBseAnnouncements(entity.name),
    });
    if (entity.ticker && entity.ticker.trim()) {
      jobs.push({
        label: 'nse-announcements',
        url: `https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(entity.ticker.trim())}`,
        run: () => fetchNseAnnouncements(entity.ticker!.trim()),
      });
    }
  }

  const seen = new Set<string>();
  const perSource: SourceFetchResult[] = [];
  const chunks: string[] = [];

  for (const c of jobs) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);

    onProgress?.({ phase: 'fetching', label: c.label, url: c.url });
    const r = await c.run();
    const usable = r.success && r.content.trim().length >= MIN_SOURCE_CHARS;
    perSource.push({ label: c.label, url: r.url || c.url, chars: r.content.length, success: usable, text: usable ? r.content : '' });
    onProgress?.({ phase: 'fetched', label: c.label, url: r.url || c.url, success: usable, chars: r.content.length });

    if (usable) chunks.push(`=== ${c.label}: ${c.url} ===\n${r.content}`);
  }

  const combined = chunks.join('\n\n');
  logger.info('Free-source gather complete', {
    entity: entity.name,
    sources: perSource.length,
    usable: perSource.filter(s => s.success).length,
    combinedChars: combined.length,
  });

  return { combined, perSource };
}
