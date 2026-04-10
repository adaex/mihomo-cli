import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  shims: false,
  dts: false,
  sourcemap: false,
  banner: { js: '#!/usr/bin/env node' },
  noExternal: [/.*/],
});
