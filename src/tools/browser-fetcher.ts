/**
 * Puppeteer-based fetcher — the FALLBACK for JS-rendered sites (PHASE 3).
 *
 * The cheerio pipeline (fetcher.ts) stays primary: it is ~50-100x cheaper.
 * This module is called only when a plain fetch returned suspiciously little
 * text (see BROWSER_FALLBACK_THRESHOLD in free-sources.ts / official-site.ts),
 * which is the signature of an SPA shell whose content arrives via JS.
 *
 * Resource management:
 *  - ONE shared headless browser, launched lazily on first use;
 *  - pages run through a p-queue (concurrency 2) so a full re-enrich-all
 *    cannot stampede Chromium;
 *  - images/fonts/stylesheets/media are blocked (text is all we need);
 *  - the browser closes itself after IDLE_CLOSE_MS without work and on
 *    process shutdown — the Electron shell kills the server child on quit,
 *    and the exit hooks below take Chromium down with it.
 */
import puppeteer, { type Browser } from 'puppeteer';
import PQueue from 'p-queue';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const NAV_TIMEOUT_MS = 8000;
/** Absolute bound on one browser fetch — navigation + settle + text extraction. */
const HARD_CAP_MS = 20_000;
const MAX_CONTENT_CHARS = 15000;
const IDLE_CLOSE_MS = 45_000;
const BLOCKED_RESOURCES = new Set(['image', 'font', 'stylesheet', 'media']);

const pageQueue = new PQueue({ concurrency: 2 });

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser?.connected) return browser;
  if (!launching) {
    launching = puppeteer.launch({
      headless: true,
      // Packaged builds ship Chromium in resources/ (no puppeteer cache on a
      // fresh machine); dev leaves this empty and uses the normal cache.
      ...(config.puppeteerExecutablePath ? { executablePath: config.puppeteerExecutablePath } : {}),
      // Default protocolTimeout is 180s — a bot-walled site that keeps the page
      // in navigation limbo (HDFC/Akamai) made page.evaluate hang ~146s per
      // fetch. Cap CDP calls hard; HARD_CAP_MS below bounds the whole fetch.
      protocolTimeout: 15_000,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    }).then(b => {
      browser = b;
      launching = null;
      logger.info('Puppeteer browser launched (JS-render fallback)');
      return b;
    }).catch(err => { launching = null; throw err; });
  }
  return launching;
}

function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pageQueue.size === 0 && pageQueue.pending === 0) {
      void closeBrowser('idle');
    }
  }, IDLE_CLOSE_MS);
  idleTimer.unref?.();
}

export async function closeBrowser(reason = 'shutdown'): Promise<void> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const b = browser;
  browser = null;
  if (b) {
    try { await b.close(); logger.info('Puppeteer browser closed', { reason }); }
    catch { /* already gone */ }
  }
}

// Take Chromium down with the process — the Electron shell terminates the
// server child on quit; without these hooks a headless Chrome could linger.
process.on('exit', () => { void closeBrowser('process exit'); });
process.on('SIGINT', () => { void closeBrowser('SIGINT').then(() => process.exit(130)); });
process.on('SIGTERM', () => { void closeBrowser('SIGTERM').then(() => process.exit(143)); });

export interface BrowserFetchResult {
  url: string;
  content: string;
  success: boolean;
  error?: string;
}

/**
 * Render `url` in headless Chromium and return the page's text content.
 * Never throws — a failure returns { success: false } so callers treat it
 * exactly like a failed plain fetch.
 */
export async function fetchWithBrowser(url: string): Promise<BrowserFetchResult> {
  const run = async (): Promise<BrowserFetchResult> => {
    const started = Date.now();
    let page;
    try {
      const b = await getBrowser();
      page = await b.newPage();
      await page.setUserAgent(USER_AGENT);
      await page.setViewport({ width: 1366, height: 900 });
      await page.setRequestInterception(true);
      page.on('request', req => {
        if (BLOCKED_RESOURCES.has(req.resourceType())) void req.abort();
        else void req.continue();
      });
      // networkidle2 with a hard cap; SPAs that never go idle still yield
      // whatever rendered before the timeout. The whole extraction races a
      // HARD_CAP_MS timer — bot-walls can hold a page in navigation limbo
      // where individual CDP calls stall far past their own timeouts.
      const extract = async (): Promise<string> => {
        await page!.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS }).catch(() => { /* render what we have */ });
        await new Promise(r => setTimeout(r, 400)); // brief settle for late DOM writes
        // globalThis cast: tsconfig has no DOM lib (this is a Node project);
        // the callback runs inside Chromium where document exists.
        return page!.evaluate(() => (globalThis as any).document?.body?.innerText ?? '');
      };
      const text = await Promise.race([
        extract(),
        new Promise<string>((_, rej) => setTimeout(() => rej(new Error(`hard cap ${HARD_CAP_MS}ms exceeded`)), HARD_CAP_MS)),
      ]);
      const content = text.replace(/\s+/g, ' ').trim().slice(0, MAX_CONTENT_CHARS);
      logger.info('Browser fetch done', { url, chars: content.length, ms: Date.now() - started });
      return { url, content, success: content.length > 0 };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Browser fetch failed', { url, error: message });
      return { url, content: '', success: false, error: message };
    } finally {
      try { await page?.close(); } catch { /* page already closed */ }
      scheduleIdleClose();
    }
  };
  return (await pageQueue.add(run)) as BrowserFetchResult;
}
