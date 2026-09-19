import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts', 'src/server.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node22',
  // @vizion/shared is a workspace-only package (never published), so it must
  // be bundled into the published output rather than left as an external
  // dependency. `ws` is a real npm dependency and stays external.
  noExternal: ['@vizion/shared'],
});
