// `journalConformance`'s `timeout` holds on every runner it says it supports — not only on the ones that
// read a third argument to `it`.
//
// It used to be handed to `it` as its third argument, the vitest/jest shape. `node:test` takes its options
// before the function and mocha reads `this.timeout()`: both ignored it in silence, so a store that hung
// hung the scenario until the runner's own limit — none, by default, on `node:test` (release audit
// d-status, J3). The suite now enforces the timeout itself and still hands it to `it` for a runner whose
// own default would otherwise cut the scenario first.
import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { journalConformance } from '@gnldev/durable/testing';

/** A journal whose reads never answer: a store that hangs. */
const hanging = () => ({
  journal: {
    get: () => new Promise<never>(() => {}),
    put: () => new Promise<never>(() => {}),
    listKeys: async () => [],
    deletePrefix: async () => 0,
  } as any,
});

it('a runner that ignores a third argument to `it` (node:test, mocha) still has the scenario fail at `timeout`', async () => {
  const registered: Array<{ name: string; fn: () => Promise<void> }> = [];
  journalConformance('hanging', hanging, {
    describe: (_n, fn) => fn(),
    it: (name, fn) => { registered.push({ name, fn }); }, // the third argument dropped, as node:test and mocha do
    timeout: 200,
  });
  const k1 = registered.find((r) => r.name.startsWith('K1'))!;
  const t0 = Date.now();
  const outcome = await Promise.race([
    k1.fn().then(() => 'passed', (e: Error) => `failed: ${e.message}`),
    new Promise<string>((r) => setTimeout(() => r('still running after 5 s'), 5_000)),
  ]);
  expect(outcome).toMatch(/^failed: .*200 ms/);
  expect(Date.now() - t0).toBeLessThan(2_000);
}, 10_000);

it('without `timeout` nothing is imposed: the runner\'s own limit applies, and `it` gets no third argument', () => {
  const thirds: unknown[] = [];
  journalConformance('hanging', hanging, {
    describe: (_n, fn) => fn(),
    it: (...args: unknown[]) => { thirds.push(args[2]); },
  } as any);
  expect(thirds.length).toBeGreaterThan(10);
  expect(thirds.every((t) => t === undefined)).toBe(true);
});

it('node:test, for real: a hanging store fails the scenario at `timeout` instead of hanging the run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-conf-nodetest-'));
  try {
    const testing = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'testing.js');
    const file = join(dir, 'hang.test.mjs');
    writeFileSync(file, `
      import { describe, it } from 'node:test';
      import { journalConformance } from ${JSON.stringify(testing)};
      const hang = () => new Promise(() => {});
      // A connection held open, as a store waiting on a server that never answers holds its socket.
      journalConformance('hanging', () => {
        const socket = setInterval(() => {}, 1000);
        return { journal: { get: hang, put: hang, listKeys: async () => [], deletePrefix: async () => 0 }, close: () => clearInterval(socket) };
      }, { describe, it, timeout: 300 });
    `);
    const r = spawnSync(process.execPath, ['--test', '--test-name-pattern=K1', file], { encoding: 'utf8', timeout: 15_000 });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.signal, 'the run ended by itself').toBeNull();
    expect(out).toMatch(/# fail 1/);
    expect(out).toMatch(/300 ms/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
