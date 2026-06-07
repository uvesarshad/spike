import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts', 'src/mcp-server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  clean: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
});
