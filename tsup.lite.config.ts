/* Second tsup build: bundles the daemon-free LITE engine into a single ESM module
 * the extension service worker imports (extension/lite-engine.js). Browser target,
 * Buffer polyfilled via inject, and clean:false so the hand-written extension/*.js
 * files are never wiped. Kept separate from tsup.config.ts (which targets Node and
 * cleans dist/). */

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { 'lite-engine': 'src/extension/lite-engine.ts' },
  format: ['esm'],
  platform: 'browser',
  target: 'chrome120',
  outDir: 'extension',
  splitting: false, // single self-contained file the SW can static-import
  sourcemap: false,
  clean: false, // NEVER wipe extension/ (sw.js, panel.*, manifest.json live here)
  dts: false,
  banner: {}, // no Node shebang
  esbuildOptions(o) {
    // rewire bare `Buffer` references to the feross/buffer polyfill
    o.inject = ['./src/extension/buffer-shim.ts'];
    // a couple of libs branch on process.env.NODE_ENV; define it so no `process`
    // global is needed at runtime in the service worker
    o.define = { 'process.env.NODE_ENV': '"production"' };
  },
});
