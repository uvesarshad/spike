import { defineConfig } from 'tsup';

/* A52 (P2): the published npm tarball shipped a sourcemap that was, on its
 * own, roughly half the unpacked package size (see
 * docs/plan/26-08-27-audit-market-readiness.md A52) for a CLI product whose
 * users never attach a debugger to dist/ — `npm run build` (what
 * `prepublishOnly`/`npm pack` actually run) must ship map-free by default.
 * A local iterative build that DOES want sourcemaps (stepping through dist/
 * output directly, rather than the normal `npm run dev` tsx-over-source
 * loop) can still opt in with `SPIKE_BUILD_SOURCEMAP=1 npm run build` —
 * same "env var override" pattern used elsewhere in this repo (e.g.
 * SPIKE_CHROME_PATH in src/chrome/launch.ts) rather than a second tsup
 * config file. */
const sourcemap = process.env.SPIKE_BUILD_SOURCEMAP === '1';

export default defineConfig({
  entry: ['src/cli.ts', 'src/mcp-server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  clean: true,
  sourcemap,
  banner: { js: '#!/usr/bin/env node' },
  // A52 (P2): tsup auto-externalizes package.json `dependencies` /
  // `peerDependencies` only — now that playwright-core lives in
  // `optionalDependencies` (lazy dynamic import() in src/engine.ts, only
  // resolved for --via playwright), it must be listed here explicitly or
  // esbuild tries to BUNDLE it and chokes on playwright-core's own internal
  // dynamic requires (chromium-bidi). Bundling it would also defeat the
  // point of making it optional/lazy in the first place.
  external: ['playwright-core'],
});
