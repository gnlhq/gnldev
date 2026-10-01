import { defineConfig } from 'vitest/config';

// The upgrade suite runs on its own (`pnpm test:legacy` from the root), not in the root `pnpm test`:
// see README.md. Each file copies its fixture to a temp file, so files may run in parallel.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    server: { deps: { external: [/node:sqlite/, 'node:sqlite'] } },
  },
});
