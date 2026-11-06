// The vector servers the integration job runs, and what the gates say about them.
//
// Two ways a gate has read as more than it ran (the same family as real-backend-tests-run.test.ts):
//
// 1. A single-node Elasticsearch / OpenSearch / Weaviate refuses writes once its data disk passes a
//    watermark (ES high watermark and Weaviate read-only, both 90 % by default) and then does not answer:
//    index creation returns `shards_acknowledged: false` after 30 s, the next call hangs. Every test on it
//    then fails as "Test timed out in 30000ms" (CI #202: 8 + 10 + 18 + 18 tests), which reads as a slow
//    store, not a full runner disk. OpenSearch was already told to ignore its watermark in ci.yml (PR #48);
//    the other two were not. So each disk-guarded service must either not guard (its watermark off) or the
//    job must check the disk at the gate, before the tests, where the cause can be read.
// 2. scripts/check-real-backends.mjs opens no vector server (docker-compose.yml has none) yet runs the
//    files that read them, which skip themselves. Its provider and failover legs say "not run"; these say
//    nothing, so a green `✓ every real-backend leg that ran, passed` covers them on no evidence.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/** The CI job that has the servers: the `integration:` block of ci.yml, up to the next job. */
function integrationJob(): string {
  const yml = read('.github/workflows/ci.yml');
  const start = yml.indexOf('\n  integration:');
  expect(start, 'ci.yml has an integration job').toBeGreaterThan(0);
  const next = yml.slice(start + 1).search(/\n  [\w-]+:\n/);
  return next < 0 ? yml.slice(start) : yml.slice(start, start + 1 + next);
}

/** One service container of the job: its block under `services:`, up to the next service. */
function service(job: string, name: string): string {
  const start = job.indexOf(`\n      ${name}:\n`);
  expect(start, `the integration job has a ${name} service`).toBeGreaterThan(0);
  const next = job.slice(start + 1).search(/\n      [\w-]+:\n|\n    \w+:/);
  return next < 0 ? job.slice(start) : job.slice(start, start + 1 + next);
}

/** The steps of the job, from `steps:` on. */
const stepsOf = (job: string) => job.slice(job.indexOf('\n    steps:'));

describe('the integration job does not let a full runner disk surface as a test timeout', () => {
  // How each service's own disk guard is switched off in its container env.
  const DISK_GUARDS: Array<[string, RegExp]> = [
    ['elasticsearch', /cluster\.routing\.allocation\.disk\.threshold_enabled:\s*'?false'?/],
    ['opensearch', /cluster\.routing\.allocation\.disk\.threshold_enabled:\s*'?false'?/],
    ['weaviate', /DISK_USE_READONLY_PERCENTAGE\s*:/],
  ];
  // Or the job asks the disk itself before the first test, and can fail there with the cause.
  const checksDiskBeforeTests = (job: string) => {
    const steps = stepsOf(job);
    const df = steps.search(/run:[^\n]*\bdf\b|^\s+df\b/m);
    const tests = steps.search(/real-backend-tests\.mjs|vitest/);
    return df >= 0 && tests >= 0 && df < tests;
  };

  it.each(DISK_GUARDS)('%s: its disk guard is off, or the job checks the disk before the tests', (name, off) => {
    const job = integrationJob();
    const guardOff = off.test(service(job, name));
    expect(guardOff || checksDiskBeforeTests(job), `${name} refuses writes past its watermark and the job neither turns that off nor checks the disk`).toBe(true);
  });
});

describe('scripts/check-real-backends.mjs says which vector servers it did not run', () => {
  // The five GNL_*_URL variables ci.yml hands the vector kit and the stores' own tests.
  const VECTOR = ['QDRANT', 'CHROMA', 'WEAVIATE', 'ELASTICSEARCH', 'OPENSEARCH'];

  it('ci.yml still runs each of them (so the list below is not stale)', () => {
    const job = integrationJob();
    for (const v of VECTOR) expect(job, `GNL_${v}_URL`).toContain(`GNL_${v}_URL=`);
  });

  it.each(VECTOR)('%s: the gate opens it or lists it as not run', (v) => {
    const script = read('scripts/check-real-backends.mjs');
    const opens = new RegExp(`GNL_${v}_URL\\s*:`).test(script);
    // A `skipped.push(...)` that names the server, as the provider and failover legs do.
    const says = [...script.matchAll(/skipped\.push\(([\s\S]*?)\);/g)].some((m) => new RegExp(v, 'i').test(m[1]!));
    expect(opens || says, `a green gate run covers ${v.toLowerCase()} on no evidence: it neither opens it nor says "not run"`).toBe(true);
  });
});
