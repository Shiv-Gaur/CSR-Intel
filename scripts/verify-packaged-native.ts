/**
 * Post-packaging gate: load better-sqlite3 inside the PACKAGED app exactly the
 * way the production server child does (the app's own Electron binary under
 * ELECTRON_RUN_AS_NODE). Catches ABI mismatches — a Node-ABI binary slipping
 * into the package crashes the installed app at boot but is invisible to
 * `npm test` (which runs under system Node). Runs at the end of
 * `electron:dist` / `release`; a failure fails the build.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const unpacked = path.join(ROOT, 'release', 'win-unpacked');
const exe = path.join(unpacked, 'CSR Funding Intelligence.exe');
const moduleDir = path.join(unpacked, 'resources', 'app', 'node_modules', 'better-sqlite3');

if (!fs.existsSync(exe)) throw new Error(`packaged exe not found: ${exe}`);
if (!fs.existsSync(moduleDir)) throw new Error(`packaged better-sqlite3 not found: ${moduleDir}`);

const probe = `const D = require(${JSON.stringify(moduleDir)}); const db = new D(':memory:'); db.exec('CREATE TABLE t(x)'); db.close(); console.log('ABI-OK');`;
const res = spawnSync(exe, ['-e', probe], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
  timeout: 30_000,
});

if (res.status === 0 && res.stdout.includes('ABI-OK')) {
  console.log('Packaged better-sqlite3 loads under the app Electron binary — ABI verified');
} else {
  console.error(res.stdout || '');
  console.error(res.stderr || '');
  throw new Error('Packaged better-sqlite3 FAILED to load under ELECTRON_RUN_AS_NODE — wrong ABI shipped');
}
