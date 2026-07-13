/**
 * Preload bridge — deliberately minimal. The dashboard is plain HTTP + DOM and
 * needs no Node/Electron APIs; contextIsolation stays on and nothing is
 * exposed beyond a marker the UI could use to detect the desktop shell.
 *
 * Plain CommonJS (.cjs) on purpose: sandboxed preload scripts must be CJS, and
 * the package is "type": "module", so a compiled .js would be mis-parsed as ESM.
 */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('csrDesktop', {
  isDesktop: true,
  version: process.versions.electron,
});
