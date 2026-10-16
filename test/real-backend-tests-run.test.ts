// Every test that needs a real Postgres is run by a gate that has one.
//
// Such a test skips itself without the server, so the default run is green whether it ran or not. The
// CI `integration` job and scripts/check-real-backends.mjs named these files by hand; measured on
// 12 Oct 2026, 50 were named by neither. This holds both gates to the files the rule finds
// (scripts/real-backend-tests.mjs): a new real-Postgres test is run without anyone listing it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — a plain .mjs script, no declarations.
import { realBackendTests } from '../scripts/real-backend-tests.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_PATH = /(?:packages|examples)\/[\w.-]+\/test\/[\w./-]+\.test\.tsx?|test\/[\w./-]+\.test\.tsx?/g;

/** The files a gate runs: the ones it names, plus each group of the rule it runs (`--run alone|shared`). */
function runBy(source: string, discovered: { path: string; alone: boolean }[]): Set<string> {
  const named = new Set(source.match(TEST_PATH) ?? []);
  for (const group of ['alone', 'shared'] as const) {
    if (!new RegExp(`real-backend-tests\\.mjs['",\\s]+--run['",\\s]+${group}\\b`).test(source)) continue;
    for (const f of discovered) if (f.alone === (group === 'alone')) named.add(f.path);
  }
  return named;
}

/** The CI job that has the servers: the `integration:` block of ci.yml, up to the next job. */
function integrationJob(): string {
  const yml = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const start = yml.indexOf('\n  integration:');
  expect(start, 'ci.yml has an integration job').toBeGreaterThan(0);
  const next = yml.slice(start + 1).search(/\n  [\w-]+:\n/);
  return next < 0 ? yml.slice(start) : yml.slice(start, start + 1 + next);
}

describe('every real-Postgres test is run by a gate that has the server', () => {
  const found: { path: string; alone: boolean }[] = realBackendTests();
  const discovered = found.map((f) => f.path);

  it('the rule finds the files that read the server directly and through a local helper', () => {
    // Directly: reads GNL_PG_URL itself.
    expect(discovered).toContain('packages/queue/test/a-stalled-worker-keeps-its-job.test.ts');
    // Through a helper: detached/harness.ts reads it, the test only imports the harness.
    expect(discovered).toContain('packages/durable/test/a-background-tool-across-processes.test.ts');
    expect(discovered).toContain('packages/memory/test/dependents-model.test.ts');
    // Not a test that never touches a server, and not the upgrade suite, which has its own job.
    expect(discovered).not.toContain('packages/durable/test/a-reader-resumes-mid-segment.test.ts');
    expect(discovered.some((f) => f.startsWith('packages/upgrade-tests/'))).toBe(false);
  });

  it('the CI integration job runs every one of them', () => {
    const ran = runBy(integrationJob(), found);
    expect(discovered.filter((f) => !ran.has(f)), 'real-Postgres tests CI never runs').toEqual([]);
  });

  it('scripts/check-real-backends.mjs runs every one of them', () => {
    const ran = runBy(readFileSync(join(root, 'scripts/check-real-backends.mjs'), 'utf8'), found);
    expect(discovered.filter((f) => !ran.has(f)), 'real-Postgres tests the local gate never runs').toEqual([]);
  });
});
