/**
 * Stages the large binary inputs electron-builder bundles into the installer
 * (PHASE 4). Run via `npm run electron:dist` before electron-builder.
 *
 *  1. build/chromium/chrome-headless-shell-win64 — the active Puppeteer
 *     chrome-headless-shell binary. Packaged machines have no ~/.cache/puppeteer,
 *     so the browser ships inside resources/ and main.ts points the server at it
 *     via PUPPETEER_EXECUTABLE_PATH. We ship chrome-headless-shell (old headless,
 *     ~100MB) rather than full Chrome (new headless, ~400MB): the shell has no
 *     Windows external-protocol/ShellExecute path, so a fetched page firing a
 *     custom-scheme deep-link can't pop the OS app-picker dialog mid-fetch (the
 *     "flashing window" bug — see src/tools/browser-fetcher.ts). The copy is
 *     skipped when the staged version already matches (marker build/chromium/.version).
 *  2. build/seed/csr-intel.db — a consistent snapshot of the current DB
 *     (better-sqlite3 backup API, safe even mid-WAL), bundled as the
 *     first-run seed that main.ts copies to the userData folder.
 */
import puppeteer from 'puppeteer';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function stageChromium(): Promise<void> {
  // Derive chrome-headless-shell from the SAME puppeteer cache + version as the
  // full-chrome path puppeteer resolves. executablePath() only returns the full
  // chrome binary; the shell lives beside it under chrome-headless-shell/<ver>/.
  // Deriving it this way keeps the shell version locked to what dev uses.
  const chromeExe = await puppeteer.executablePath(); // ...\chrome\win64-<ver>\chrome-win64\chrome.exe
  const version = path.basename(path.dirname(path.dirname(chromeExe))); // win64-<ver>
  const cacheRoot = path.dirname(path.dirname(path.dirname(path.dirname(chromeExe)))); // ...\puppeteer
  const srcDir = path.join(cacheRoot, 'chrome-headless-shell', version, 'chrome-headless-shell-win64');
  const shellExe = path.join(srcDir, 'chrome-headless-shell.exe');
  if (!fs.existsSync(shellExe)) {
    throw new Error(
      `chrome-headless-shell not found at ${shellExe} — run \`npx puppeteer browsers install chrome-headless-shell\` first`,
    );
  }
  const destDir = path.join(ROOT, 'build', 'chromium', 'chrome-headless-shell-win64');
  const marker = path.join(ROOT, 'build', 'chromium', '.version');

  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === version && fs.existsSync(destDir)) {
    console.log(`chrome-headless-shell already staged (${version}) — skipping copy`);
    return;
  }
  console.log(`Staging chrome-headless-shell ${version} → build/chromium/chrome-headless-shell-win64 (~100MB, one-time per version)…`);
  fs.rmSync(path.join(ROOT, 'build', 'chromium'), { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(srcDir, destDir, { recursive: true });
  fs.writeFileSync(marker, version);
  console.log('chrome-headless-shell staged');
}

async function stageSeedDb(): Promise<void> {
  const src = path.join(ROOT, 'data', 'csr-intel.db');
  if (!fs.existsSync(src)) {
    throw new Error(`Seed source ${src} not found — the installer bundles the current dataset`);
  }
  const dest = path.join(ROOT, 'build', 'seed', 'csr-intel.db');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const db = new Database(src, { readonly: true });
  try {
    await db.backup(dest); // consistent snapshot, WAL included
  } finally {
    db.close();
  }
  const rows = new Database(dest, { readonly: true });
  try {
    const entities = rows.prepare('SELECT COUNT(*) AS n FROM entities').get() as { n: number };
    const innovators = rows.prepare('SELECT COUNT(*) AS n FROM innovators').get() as { n: number };
    console.log(`Seed DB staged: ${entities.n} entities, ${innovators.n} innovators (${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} MB)`);
  } finally {
    rows.close();
  }
}

/**
 * Force a REAL Electron-ABI rebuild of better-sqlite3.
 *
 * @electron/rebuild writes a `.forge-meta` marker after building and skips
 * the module whenever the marker is present — but `npm rebuild better-sqlite3`
 * (our post-packaging Node-ABI restore) replaces the binary WITHOUT removing
 * the marker. The second packaging run then "finishes" the rebuild as a no-op
 * and ships a Node-ABI binary that crashes the packaged app at boot
 * (NODE_MODULE_VERSION 127 vs 148). Deleting the marker makes every packaging
 * run rebuild for real (prebuilt download — seconds, no compiler needed).
 */
function clearStaleRebuildMarker(): void {
  const marker = path.join(ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release', '.forge-meta');
  if (fs.existsSync(marker)) {
    fs.rmSync(marker);
    console.log('Removed stale @electron/rebuild marker (better-sqlite3 will rebuild for the Electron ABI)');
  }
}

await stageChromium();
await stageSeedDb();
clearStaleRebuildMarker();
