/**
 * Official-website contact discovery.
 *
 * Finds contact/leadership/board pages on a company's OWN domain and returns
 * their text. The output feeds ONLY executive-contact extraction
 * (extractExecutiveContacts) — never sectors, geography, spend, or any other
 * financial extraction; those keep their existing sources untouched.
 *
 * Page discovery is deliberately layered, because company sites do not share
 * a URL structure (hardcoded paths silently fail on a large share of sites):
 *   1. sitemap.xml — parse every listed URL, filter by contact/leadership
 *      keywords (handles sites whose nav is JS-rendered);
 *   2. homepage links — cheerio over the raw HTML, same keyword filter;
 *   3. common path guesses (/contact-us, /leadership, …) — LAST resort only,
 *      and their 404s are expected outcomes, not errors.
 * At most MAX_CANDIDATE_PAGES candidate pages are fetched per company.
 */
import axios from 'axios';
import * as cheerio from 'cheerio';
import { fetchHTML } from './fetcher.js';
import { logger } from '../utils/logger.js';

/** URL-path keywords that mark a page as contact/leadership-relevant. */
const PAGE_KEYWORDS = /contact|leadership|management|board|investor|about|governance|team/i;

/** Hard cap on candidate-page fetches per company (homepage + sitemap excluded). */
const MAX_CANDIDATE_PAGES = 4;

/** Last-resort path guesses — tried only when sitemap AND homepage links yield nothing. */
const FALLBACK_PATHS = ['contact-us', 'contact', 'investors', 'investor-relations', 'leadership', 'about-us', 'board-of-directors'];

/** PSU/government/bank sites almost always publish a photo-grid "Board of
 *  Directors" page under one of a few conventional paths, and are typically
 *  server-rendered (cheerio-friendly). With `thorough`, these are ALWAYS tried
 *  in addition to whatever the sitemap/homepage yielded. */
const BOARD_PATHS = [
  'about-us/board-of-directors', 'board-of-directors', 'leadership',
  'organisation/board-of-directors', 'about-us/leadership', 'about/board-of-directors',
];

/** Minimum usable text per page (same spirit as free-sources MIN_SOURCE_CHARS). */
const MIN_PAGE_CHARS = 100;

const HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export interface OfficialSitePage {
  url: string;
  text: string;
}

function normaliseRoot(domain: string): string {
  let root = domain.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(root)) root = `https://${root}`;
  return root;
}

function sameHost(root: string, url: string): boolean {
  try {
    const a = new URL(root).hostname.replace(/^www\./, '');
    const b = new URL(url).hostname.replace(/^www\./, '');
    return a === b;
  } catch {
    return false;
  }
}

/** Raw GET that tolerates failure — 404s on guessed paths are expected, not errors. */
async function rawGet(url: string): Promise<string | null> {
  try {
    const res = await axios.get(url, { headers: HEADERS, timeout: 15000, maxRedirects: 5, responseType: 'text' });
    return typeof res.data === 'string' ? res.data : null;
  } catch {
    return null;
  }
}

/** Collect keyword-matching URLs from sitemap.xml (one level of sitemap-index nesting). */
async function candidatesFromSitemap(root: string): Promise<string[]> {
  const xml = await rawGet(`${root}/sitemap.xml`);
  if (!xml) return [];
  const locs = (doc: string): string[] => {
    const $ = cheerio.load(doc, { xmlMode: true });
    return $('loc').map((_, el) => $(el).text().trim()).get().filter(Boolean);
  };
  let urls = locs(xml);
  // Sitemap index: entries are themselves .xml sitemaps — expand the ones most
  // likely to hold page URLs (keyword-matching first), max 2 extra fetches.
  const children = urls.filter(u => u.endsWith('.xml'));
  if (children.length && children.length === urls.length) {
    const ordered = [...children.filter(u => PAGE_KEYWORDS.test(u)), ...children.filter(u => !PAGE_KEYWORDS.test(u))];
    urls = [];
    for (const child of ordered.slice(0, 2)) {
      const childXml = await rawGet(child);
      if (childXml) urls.push(...locs(childXml));
    }
  }
  return urls.filter(u => !u.endsWith('.xml') && sameHost(root, u) && PAGE_KEYWORDS.test(new URL(u).pathname));
}

/** Collect keyword-matching same-host links from the homepage HTML. */
function candidatesFromHomepage(root: string, html: string): string[] {
  const $ = cheerio.load(html);
  const found = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = String($(el).attr('href') ?? '').trim();
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return;
    try {
      const abs = new URL(href, `${root}/`).toString().split('#')[0];
      if (sameHost(root, abs) && PAGE_KEYWORDS.test(new URL(abs).pathname)) found.add(abs);
    } catch { /* unparseable href — skip */ }
  });
  return [...found];
}

/**
 * Fetch the company's official-site pages that plausibly carry contact or
 * leadership information. Returns cleaned per-page text (homepage included
 * when it has usable text — footers often carry the only public email).
 * Fails soft: an unreachable site returns [] and costs a few fetches.
 */
export async function fetchCompanyOfficialContacts(domain: string, opts?: { thorough?: boolean }): Promise<OfficialSitePage[]> {
  const root = normaliseRoot(domain);
  const pages: OfficialSitePage[] = [];

  const homepageHtml = await rawGet(root);
  if (homepageHtml) {
    const $ = cheerio.load(homepageHtml);
    $('script, style, iframe, noscript').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 15000);
    if (text.length >= MIN_PAGE_CHARS) pages.push({ url: root, text });
  }

  // Discovery layers: sitemap first, homepage links second, guesses last.
  let candidates = await candidatesFromSitemap(root);
  if (!candidates.length && homepageHtml) candidates = candidatesFromHomepage(root, homepageHtml);
  if (!candidates.length) candidates = FALLBACK_PATHS.map(p => `${root}/${p}`);

  // Prefer shorter paths (top-level pages) and dedupe; cap the fetch count.
  candidates = [...new Set(candidates)]
    .filter(u => u !== root && u !== `${root}/`)
    .sort((a, b) => a.length - b.length)
    .slice(0, MAX_CANDIDATE_PAGES);

  // PSU mode: conventional board-page paths are tried ON TOP of the cap —
  // a leadership page that 404s costs one cheap request, a hit costs a wrong CEO.
  if (opts?.thorough) {
    const have = new Set(candidates.map(u => u.replace(/\/+$/, '')));
    for (const p of BOARD_PATHS) {
      const u = `${root}/${p}`;
      if (!have.has(u)) candidates.push(u);
    }
  }

  for (const url of candidates) {
    const r = await fetchHTML(url); // fails soft; guessed-path 404s are expected
    if (r.success && r.content.length >= MIN_PAGE_CHARS) pages.push({ url, text: r.content });
  }

  logger.info('Official-site contact pages fetched', {
    root, candidatesTried: candidates.length, usablePages: pages.length,
  });
  return pages;
}
