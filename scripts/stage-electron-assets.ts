/**
 * Stages the large binary inputs electron-builder bundles into the installer
 * (PHASE 4). Run via `npm run electron:dist` before electron-builder.
 *
 *  1. build/chromium/chrome-win64 — the active Puppeteer Chromium. Packaged
 *     machines have no ~/.cache/puppeteer, so the browser ships inside
 *     resources/ and main.ts points the server at it via
 *     PUPPETEER_EXECUTABLE_PATH. The ~400MB copy is skipped when the staged
 *     version already matches (marker file build/chromium/.version).
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
  const chromeExe = await puppeteer.executablePath();
  if (!fs.existsSync(chromeExe)) {
    throw new Error(
      `Puppeteer Chromium not found at ${chromeExe} — run \`npx puppeteer browsers install chrome\` first`,
    );
  }
  const srcDir = path.dirname(chromeExe); // ...\chrome\win64-<ver>\chrome-win64
  const version = path.basename(path.dirname(srcDir)); // win64-<ver>
  const destDir = path.join(ROOT, 'build', 'chromium', 'chrome-win64');
  const marker = path.join(ROOT, 'build', 'chromium', '.version');

  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === version && fs.existsSync(destDir)) {
    console.log(`Chromium already staged (${version}) — skipping copy`);
    return;
  }
  console.log(`Staging Chromium ${version} → build/chromium/chrome-win64 (~400MB, one-time per version)…`);
  fs.rmSync(path.join(ROOT, 'build', 'chromium'), { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(srcDir, destDir, { recursive: true });
  fs.writeFileSync(marker, version);
  console.log('Chromium staged');
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

await stageChromium();
await stageSeedDb();
