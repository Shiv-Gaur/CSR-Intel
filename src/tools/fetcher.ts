import axios from 'axios';
import * as cheerio from 'cheerio';
import pdfParse from 'pdf-parse';
import PQueue from 'p-queue';
import { logger } from '../utils/logger.js';
import { config, SEARCH_FREE_MODE } from '../config.js';
import type { FetchResult } from '../types/index.js';

const searchQueue = new PQueue({ concurrency: 1 });

// Full browser-like headers — prevents 403 blocks from corporate websites
const HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Ch-Ua': '"Chromium";v="131", "Google Chrome";v="131"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
};

const DELAY_MS = Math.min(config.fetchDelayMs, 1000); // cap at 1s — we want speed
const MAX_CONTENT_CHARS = 15000;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── HTML fetch + clean ───────────────────────────────────────────────────────

export async function fetchHTML(url: string): Promise<FetchResult> {
  await delay(DELAY_MS);

  try {
    const response = await axios.get(url, {
      headers: HEADERS,
      timeout: 20000,
      maxRedirects: 5,
    });

    const $ = cheerio.load(response.data);
    // Remove non-content elements, including footer-ish/disclaimer/legal blocks
    // that are site-wide boilerplate — Moneycontrol's inline fraud disclaimer
    // (grievanceofficer@nw18.com) sat OUTSIDE <footer> and leaked into the
    // corpus of every company enriched.
    $('nav, header, footer, script, style, iframe, noscript, .cookie-banner, #cookie, .sidebar, .menu, .advertisement, .ad-container').remove();
    $('[class*="footer"], [id*="footer"], [class*="disclaimer"], [id*="disclaimer"], [class*="copyright"], [class*="legal"]').remove();

    // Extract clean text
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    const truncated = text.slice(0, MAX_CONTENT_CHARS);

    logger.debug('Fetched HTML', { url, chars: truncated.length });
    return { url, content: truncated, content_type: 'html', fetched_at: new Date().toISOString(), success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('HTML fetch failed', { url, error: message });
    return { url, content: '', content_type: 'html', fetched_at: new Date().toISOString(), success: false, error: message };
  }
}

// ─── PDF fetch + extract ──────────────────────────────────────────────────────

export async function fetchPDF(url: string): Promise<FetchResult> {
  await delay(DELAY_MS);

  try {
    const response = await axios.get(url, {
      headers: HEADERS,
      responseType: 'arraybuffer',
      timeout: 45000, // PDFs can be large
    });

    const buffer = Buffer.from(response.data);
    const parsed = await pdfParse(buffer, { max: 0 }); // max:0 = all pages

    const fullText = parsed.text;
    const csrSection = extractCSRSection(fullText);

    logger.debug('Fetched PDF', { url, pages: parsed.numpages, chars: csrSection.length });
    return { url, content: csrSection, content_type: 'pdf', fetched_at: new Date().toISOString(), success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('PDF fetch failed', { url, error: message });
    return { url, content: '', content_type: 'pdf', fetched_at: new Date().toISOString(), success: false, error: message };
  }
}

// ─── Content-Type-aware fetch ─────────────────────────────────────────────────
// Single GET, then decide HTML vs PDF from the response Content-Type header —
// NOT from guessing by URL substring. Fixes the bug where any URL containing
// "annual-report" was force-parsed as a PDF and failed on HTML index pages.
export async function fetchAuto(url: string): Promise<FetchResult> {
  await delay(DELAY_MS);

  try {
    const response = await axios.get(url, {
      headers: HEADERS,
      responseType: 'arraybuffer',
      timeout: 45000,
      maxRedirects: 5,
    });

    const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
    const buffer = Buffer.from(response.data);
    const isPDF = contentType.includes('application/pdf');

    if (isPDF) {
      const parsed = await pdfParse(buffer, { max: 0 });
      const csrSection = extractCSRSection(parsed.text);
      logger.debug('Fetched (auto→PDF)', { url, pages: parsed.numpages, chars: csrSection.length });
      return { url, content: csrSection, content_type: 'pdf', fetched_at: new Date().toISOString(), success: true };
    }

    const $ = cheerio.load(buffer.toString('utf-8'));
    // Capture the page's own recency marker BEFORE stripping the footer —
    // Wikipedia's "This page was last edited on …" lives in #footer-info-lastmod
    // and is what lets contacts carry an honest as_of date.
    const lastMod = $('#footer-info-lastmod').text().trim();
    $('nav, header, footer, script, style, iframe, noscript, .cookie-banner, #cookie, .sidebar, .menu, .advertisement, .ad-container').remove();
    let text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, MAX_CONTENT_CHARS);
    if (lastMod) text += ` ${lastMod}`;
    logger.debug('Fetched (auto→HTML)', { url, chars: text.length });
    return { url, content: text, content_type: 'html', fetched_at: new Date().toISOString(), success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('Auto fetch failed', { url, error: message });
    return { url, content: '', content_type: 'html', fetched_at: new Date().toISOString(), success: false, error: message };
  }
}

// Extract the CSR-relevant section from a full annual report
function extractCSRSection(text: string): string {
  const csrKeywords = [
    'corporate social responsibility',
    'csr activities',
    'schedule vii',
    'annexure.*csr',
    'csr policy',
    'csr committee',
    'csr expenditure',
    'csr obligation',
    'section 135',
  ];

  const lines = text.split('\n');
  let startIdx = -1;
  let endIdx = lines.length;

  // Find CSR section start
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (csrKeywords.some(kw => new RegExp(kw).test(lower))) {
      startIdx = Math.max(0, i - 2);
      break;
    }
  }

  if (startIdx === -1) {
    // No clear CSR section — return first 10k chars of full text
    return text.slice(0, 10000);
  }

  // Find section end (next major section heading after CSR)
  const sectionEnders = ['directors report', 'financial statements', 'auditor', 'balance sheet', 'profit and loss', 'management discussion'];
  for (let i = startIdx + 10; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (sectionEnders.some(kw => lower.includes(kw)) && i > startIdx + 50) {
      endIdx = i;
      break;
    }
  }

  const section = lines.slice(startIdx, Math.min(endIdx, startIdx + 1000)).join('\n');
  return section.slice(0, 12000); // cap at 12k chars
}

// ─── Wayback Machine fetch (for historical drift seeding) ─────────────────────

export async function fetchWayback(url: string, year: number): Promise<FetchResult> {
  const timestamp = `${year}0101000000`;
  const cdxUrl = `https://web.archive.org/web/${timestamp}/${url}`;
  logger.debug('Fetching Wayback snapshot', { url, year });
  return fetchHTML(cdxUrl);
}

// ─── Search web (Serper.dev primary → DuckDuckGo fallback) ───────────────────

const SERPER_API_KEY = config.serperApiKey;

async function searchSerper(query: string): Promise<string[]> {
  if (!SERPER_API_KEY) return [];

  const response = await axios.post('https://google.serper.dev/search', { q: query, num: 10 }, {
    headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
    timeout: 10000,
  });

  const organic = response.data?.organic ?? [];
  const urls = organic.map((r: any) => r.link).filter(Boolean).slice(0, 10);
  logger.debug('Serper search complete', { query, results: urls.length });
  return urls;
}

async function searchBraveAPI(query: string): Promise<string[]> {
  const apiKey = config.braveSearchApiKey;
  if (!apiKey) return [];

  try {
    const response = await axios.get('https://api.search.brave.com/res/v1/web/search', {
      params: { q: query, count: 10 },
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
      timeout: 12000,
    });

    const results = response.data?.web?.results ?? [];
    const urls = results.map((r: any) => r.url).filter(Boolean).slice(0, 10);
    logger.debug('Brave API search complete', { query, results: urls.length });
    return urls;
  } catch (err: any) {
    logger.debug('Brave API search failed', { error: err.message });
    return [];
  }
}

// SEARCH-FREE MODE (see config.ts): engine scrapers (DuckDuckGo / Bing / Google
// / Brave) were removed — they are blocked by captcha + rate-limits here and the
// retry loops only wasted time and flooded the logs. Only keyed API providers
// (Serper, Brave API) are used, and only when a key is actually configured.
export async function searchWeb(query: string): Promise<string[]> {
  if (SEARCH_FREE_MODE && !SERPER_API_KEY && !config.braveSearchApiKey) {
    // No keyed provider available — skip immediately, no network calls.
    logger.debug('Web search skipped (search-free mode, no API key configured)', { query });
    return [];
  }

  return searchQueue.add(async () => {
    await delay(Math.min(config.searchDelayMs, 1500));

    // 1. Serper.dev (paid — only if API key is configured)
    try {
      const serperResults = await searchSerper(query);
      if (serperResults.length > 0) return serperResults;
    } catch (err: any) {
      logger.debug('Serper search failed, trying Brave API', { error: err.message });
    }

    // 2. Brave Search API (free tier — 2000 queries/month)
    try {
      const braveApiResults = await searchBraveAPI(query);
      if (braveApiResults.length > 0) return braveApiResults;
    } catch (err: any) {
      logger.debug('Brave API search failed', { error: err.message });
    }

    logger.debug('No keyed search provider returned results', { query });
    return [];
  }) as Promise<string[]>;
}

// ─── Multi-query search helper ───────────────────────────────────────────────

export async function searchMultiple(queries: string[]): Promise<string[]> {
  const allUrls: string[] = [];
  for (const query of queries) {
    const results = await searchWeb(query);
    allUrls.push(...results);
  }
  // Deduplicate
  return [...new Set(allUrls)];
}
