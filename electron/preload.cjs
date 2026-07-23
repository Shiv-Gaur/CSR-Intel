/**
 * Preload bridge — deliberately minimal. The dashboard is plain HTTP + DOM;
 * the only Electron surface exposed is the auto-update control for the gear
 * panel. contextIsolation stays on.
 *
 * Plain CommonJS (.cjs) on purpose: sandboxed preload scripts must be CJS, and
 * the package is "type": "module", so a compiled .js would be mis-parsed as ESM.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('csrDesktop', {
  isDesktop: true,
  version: process.versions.electron,
  appVersion: () => ipcRenderer.invoke('app:version'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  onUpdateStatus: (cb) => {
    ipcRenderer.on('updates:status', (_event, text) => cb(String(text)));
  },
  // Structured state for the sidebar update strip: {state, version}.
  onUpdateState: (cb) => {
    ipcRenderer.on('updates:state', (_event, payload) => cb(payload));
  },
  restartToUpdate: () => ipcRenderer.invoke('updates:restart'),
});
