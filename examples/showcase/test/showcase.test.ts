// The showcase is the tour the README sends a newcomer on: `pnpm demo`, 22 features, no API key. It
// exits non-zero when a feature fails, and nothing ran it — so when the working-memory section broke
// (it read the store's key layout instead of the memory's own API), the tour printed "21/22" to the
// first person who tried it and every gate stayed green. This runs the tour as that person does.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tsx = createRequire(import.meta.url).resolve('tsx/cli');

describe('the showcase tour', () => {
  it('runs every feature to the end', () => {
    const r = spawnSync(process.execPath, [tsx, join(here, '../src/demo.ts')], { cwd: join(here, '..'), encoding: 'utf8', timeout: 120_000 });
    const failed = (r.stdout ?? '').split('\n').filter((l) => l.startsWith('✗'));
    expect(failed, r.stderr?.slice(-500)).toEqual([]);
    expect(r.stdout).toContain('(all passed)');
    expect(r.status).toBe(0);
  }, 150_000);
});
