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
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import electronUpdater from 'electron-updater';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// electron-updater is CJS; default-import + destructure is the ESM-safe form.
const { autoUpdater } = electronUpdater;

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
    // Bundled chrome-headless-shell for the Puppeteer fallback (a fresh machine
    // has no ~/.cache/puppeteer). The shell binary (not full Chrome) avoids the
    // OS external-protocol dialog flash — see src/tools/browser-fetcher.ts.
    // browser-fetcher reads this through config.ts.
    const bundledChrome = path.join(process.resourcesPath, 'chrome', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
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

// ─── Auto-update (electron-updater ← GitHub Releases) ────────────────────────
// Production only: checks on launch and every 4 hours. Updates download in the
// background; the user chooses "Restart now" or "Later" (Later = the update
// applies on next launch). Every failure path is caught — a dead network or a
// repo with no releases yet must never crash the app.
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

function sendUpdateStatus(text: string): void {
  mainWindow?.webContents.send('updates:status', text);
}

/** Structured state for the sidebar update strip (renderer: updT1/updT2). The
 *  `downloading` state carries a percent so the strip can show live progress. */
type UpdateState = 'none' | 'available' | 'downloading' | 'downloaded' | 'error';
function sendUpdateState(state: UpdateState, version?: string, percent?: number): void {
  mainWindow?.webContents.send('updates:state', { state, version: version ?? null, percent: percent ?? null });
}

/** electron-updater errors embed multi-line HTTP header dumps — keep the gist. */
function briefError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0].trim().slice(0, 160);
}

/** The ONLY quitAndInstall call site. Frees the port/Chromium, then hands off to
 *  the oneClick NSIS installer with isSilent=true (passes `/S` → no installer
 *  window) and isForceRunAfter=true (relaunch after install). Routing both the
 *  automatic post-download flow AND the manual restart IPC through here guarantees
 *  no code path can ever pop the installer UI during an update. */
function applyUpdateAndRestart(): void {
  stopServer(); // free port + kill Chromium before the installer relaunches us
  autoUpdater.quitAndInstall(true, true);
}

function setupAutoUpdater(): void {
  if (!app.isPackaged) return;
  autoUpdater.logger = console;
  autoUpdater.autoDownload = true;

  autoUpdater.on('update-available', info => {
    sendUpdateStatus(`Update ${info.version} found — downloading in the background…`);
    sendUpdateState('available', info.version);
  });
  autoUpdater.on('download-progress', progress => {
    const percent = Math.max(0, Math.min(100, Math.round(progress?.percent ?? 0)));
    sendUpdateStatus(`Downloading update… ${percent}%`);
    sendUpdateState('downloading', undefined, percent);
  });
  autoUpdater.on('update-not-available', () => {
    sendUpdateStatus(`You are on the latest version (${app.getVersion()}).`);
    sendUpdateState('none', app.getVersion());
  });
  autoUpdater.on('error', err => {
    console.error('Auto-update error (non-fatal):', err?.message ?? err);
    sendUpdateStatus(`Update check failed: ${briefError(err ?? 'unknown error')}`);
    sendUpdateState('error');
  });
  // Fully automatic, zero-UI update: no dialog, no NSIS wizard. Show the strip a
  // brief "Update ready — Restarting…" then quitAndInstall(isSilent=true,
  // isForceRunAfter=true). isSilent=true passes `/S` to the oneClick NSIS
  // installer (silent, no window); isForceRunAfter=true relaunches the app after.
  autoUpdater.on('update-downloaded', info => {
    sendUpdateStatus(`Update ${info.version} downloaded — restarting to apply…`);
    sendUpdateState('downloaded', info.version);
    // Brief pause so the "Restarting…" strip is visible before teardown.
    setTimeout(() => applyUpdateAndRestart(), 2500);
  });

  const check = (): void => {
    autoUpdater.checkForUpdates().catch(err => {
      console.error('Update check failed (non-fatal):', err instanceof Error ? err.message : String(err));
    });
  };
  // Fires on EVERY app launch (setupAutoUpdater runs from app.whenReady) —
  // the 10s delay only lets the window and server settle first.
  setTimeout(check, 10_000);
  setInterval(check, UPDATE_CHECK_INTERVAL_MS).unref?.();
}

// IPC for the dashboard's "Check for updates" button (Settings panel) and the
// sidebar update strip's Restart action.
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('updates:restart', () => {
  if (!app.isPackaged) return 'Restart-to-update only works in the installed app.';
  applyUpdateAndRestart();
  return 'Restarting…';
});
ipcMain.handle('updates:check', async (): Promise<string> => {
  if (!app.isPackaged) return 'Update checks only run in the installed app (dev mode detected).';
  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo?.version;
    if (!latest) return 'No update information available.';
    return latest === app.getVersion()
      ? `You are on the latest version (${latest}).`
      : `Update ${latest} found — downloading in the background…`;
  } catch (err) {
    return `Update check failed: ${briefError(err)}`;
  }
});

// Native Save/Open dialogs for snapshot sync. The renderer owns the HTTP calls
// (it knows the server URL); main only owns the file picker + disk I/O, which
// the sandboxed renderer cannot do. Both return null when the user cancels.
ipcMain.handle('sync:save', async (_event, filename: string, contents: string) => {
  const win = mainWindow;
  const opts = {
    title: 'Export snapshot',
    defaultPath: path.join(app.getPath('documents'), String(filename || 'snapshot.json')),
    filters: [{ name: 'Snapshot (JSON)', extensions: ['json'] }],
  };
  const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (result.canceled || !result.filePath) return null;
  await fs.promises.writeFile(result.filePath, String(contents), 'utf8');
  return result.filePath;
});

ipcMain.handle('sync:open', async () => {
  const win = mainWindow;
  const opts = {
    title: 'Import snapshot',
    properties: ['openFile' as const],
    filters: [{ name: 'Snapshot (JSON)', extensions: ['json'] }],
  };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (result.canceled || !result.filePaths.length) return null;
  const filePath = result.filePaths[0];
  return { path: filePath, name: path.basename(filePath), contents: await fs.promises.readFile(filePath, 'utf8') };
});

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
  setupAutoUpdater();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  stopServer();
  app.quit();
});

app.on('before-quit', stopServer);
