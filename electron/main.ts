/**
 * Electron main process — wraps the CSR Funding Intelligence dashboard in a
 * native desktop window.
 *
 * Architecture: the existing HTTP server (dashboard + queue workers + cron
 * scheduler, all in src/index.ts) runs as a CHILD Node process rather than
 * in-process. Two reasons:
 *   1. better-sqlite3 is a native module compiled for the Node ABI — loading
 *      it inside Electron's renderer/main would require an electron-rebuild;
 *      a plain `node dist/index.js` child sidesteps ABI mismatches entirely.
 *   2. Lifecycle is trivially clean: killing the child stops the server, the
 *      workers AND the node-cron jobs in one shot, so an app restart can never
 *      accumulate duplicate cron schedules (each child is a fresh process and
 *      only one child exists per app instance — enforced by the single-instance
 *      lock below).
 *
 * Attach mode: if something is already serving the dashboard on the port
 * (e.g. `npm run dev` during development), the window just attaches to it and
 * does NOT own its lifecycle (no kill on quit).
 */
import { app, BrowserWindow } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.DASHBOARD_PORT || 3000);
const URL = `http://localhost:${PORT}`;

let serverChild: ChildProcess | null = null;
let ownsServer = false;
let mainWindow: BrowserWindow | null = null;

// Only one app instance — a second launch focuses the existing window instead
// of spawning a second server (and a second set of cron jobs).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function probeServer(): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get(`${URL}/api/stats`, { timeout: 1500 }, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** SQLite path: dev uses ./data as always; packaged builds keep the DB in the
 *  per-user app-data folder (writable, survives reinstall). On first packaged
 *  run, a bundled snapshot (resources/csr-intel.db) is copied there if present. */
function resolveSqlitePath(): string | undefined {
  if (!app.isPackaged) return undefined; // dev: config default ./data/csr-intel.db
  const userDb = path.join(app.getPath('userData'), 'csr-intel.db');
  if (!fs.existsSync(userDb)) {
    const bundled = path.join(process.resourcesPath, 'csr-intel.db');
    if (fs.existsSync(bundled)) fs.copyFileSync(bundled, userDb);
  }
  return userDb;
}

async function startServer(): Promise<void> {
  if (await probeServer()) {
    ownsServer = false; // attach to an already-running dev server
    return;
  }
  ownsServer = true;
  const serverEntry = path.join(PROJECT_ROOT, 'dist', 'index.js');
  const env: NodeJS.ProcessEnv = { ...process.env, DASHBOARD_PORT: String(PORT) };
  const sqlitePath = resolveSqlitePath();
  if (sqlitePath) env.SQLITE_PATH = sqlitePath;

  // Packaged machines have no `node` on PATH — run the app's own Electron
  // binary as Node (ELECTRON_RUN_AS_NODE). This is also why electron-builder
  // rebuilds better-sqlite3 for the Electron ABI at package time: the child
  // shares Electron's NODE_MODULE_VERSION, not the system Node's.
  let nodeBin = 'node';
  if (app.isPackaged) {
    nodeBin = process.execPath;
    env.ELECTRON_RUN_AS_NODE = '1';
    // Bundled Chromium for the Puppeteer fallback (a fresh machine has no
    // ~/.cache/puppeteer). browser-fetcher reads this through config.ts.
    const bundledChrome = path.join(process.resourcesPath, 'chrome', 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(bundledChrome)) env.PUPPETEER_EXECUTABLE_PATH = bundledChrome;
  }

  serverChild = spawn(nodeBin, [serverEntry], {
    cwd: PROJECT_ROOT,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  serverChild.on('exit', code => {
    serverChild = null;
    if (code !== null && code !== 0 && mainWindow) {
      mainWindow.loadURL(`data:text/html,<h2 style="font-family:sans-serif">Server exited (code ${code}) — check logs and restart the app.</h2>`);
    }
  });

  // Wait for the server to answer (workers + migrations can take a few seconds).
  for (let i = 0; i < 60; i++) {
    if (await probeServer()) return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Server did not come up on ${URL} within 30s`);
}

function stopServer(): void {
  if (ownsServer && serverChild && serverChild.pid) {
    serverChild.kill(); // plain node child, no shell wrapper → no orphans
    serverChild = null;
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: 'CSR Funding Intelligence',
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    icon: path.join(__dirname, '..', 'electron', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      // .cjs source, not compiled: sandboxed preloads must be CommonJS.
      preload: path.join(PROJECT_ROOT, 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL(URL);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  try {
    await startServer();
  } catch (err) {
    console.error(String(err));
  }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  stopServer();
  app.quit();
});

app.on('before-quit', stopServer);
