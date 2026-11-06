// `gnl upgrade` finds the GNL packages a project has installed, registers the upgrade steps they export,
// and runs them with the store's own — no flag. Two fake packages stand in for @gnldev/queue and
// @gnldev/scheduler (the names the CLI looks for), each exporting its factory as the real ones do.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Module from 'node:module';
import * as durable from '@gnldev/durable';
import { InMemoryStorage, toJournal, markUpgradeDue, registerUpgradeSteps } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';

const loadConfig = vi.fn();
const settle = vi.fn(async () => ({ blocking: false }));
vi.mock('../src/config.js', () => ({ loadConfig: (...a: unknown[]) => loadConfig(...a) }));
vi.mock('../src/runtime.js', async (orig) => ({ ...(await orig<object>()), loadDurable: async () => durable }));
vi.mock('../src/commands/pending.js', async (orig) => ({ ...(await orig<object>()), settlePending: (...a: unknown[]) => (settle as (...x: unknown[]) => unknown)(...a) }));
const { upgradeCommand } = await import('../src/commands/upgrade.js');
const { doctorCommand } = await import('../src/commands/doctor.js');

type Counts = Record<string, { runs: number; done: boolean; fail?: string }>;
const ranCount = (name: string): number => counts()[name]?.runs ?? 0;
const counts = (): Counts => (globalThis as unknown as { __fakeUpgrade: Counts }).__fakeUpgrade;

/**
 * A package whose `<exportName>` is a step factory, written where the project would have installed it.
 * Every step keeps its state on globalThis so the test can see what ran.
 */
function installFake(dir: string, spec: string, exportName: string | undefined, steps: Array<{ name: string; requires?: string[]; afterOlderGone?: boolean; versions?: boolean }>) {
  const pkg = join(dir, 'node_modules', ...spec.split('/'));
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: spec, version: '9.9.9', type: 'module', main: 'index.js' }));
  const body = steps.map((s) => `({
    name: ${JSON.stringify(s.name)}, description: ${JSON.stringify(`does ${s.name}`)},
    ${s.requires ? `requires: ${JSON.stringify(s.requires)},` : ''} ${s.afterOlderGone ? 'afterOlderGone: true,' : ''}
    pending: async () => !(globalThis.__fakeUpgrade[${JSON.stringify(s.name)}] ??= { runs: 0, done: false }).done,
    plan: async () => ({ ${s.versions ? 'dataVersion: 1, packageVersion: 2, ' : ''}would: ${JSON.stringify(s.name)} }),
    run: async () => {
      const c = globalThis.__fakeUpgrade[${JSON.stringify(s.name)}]; c.runs++;
      if (c.fail) throw new Error(c.fail);
      c.done = true; return { did: ${JSON.stringify(s.name)} };
    },
  })`).join(',\n');
  writeFileSync(join(pkg, 'index.js'), `globalThis.__fakeUpgrade ??= {};\n${exportName ? `export const ${exportName} = () => [${body}];` : 'export const somethingElse = 1;'}\n`);
  return pathToFileURL(join(pkg, 'index.js')).href;
}

let dir: string;
let logged: string[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gnl-upgrade-pkgs-'));
  (globalThis as unknown as { __fakeUpgrade: Counts }).__fakeUpgrade = {};
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logged.push(a.join(' ')); });
  settle.mockClear();
  settle.mockImplementation(async () => ({ blocking: false }));
});
afterEach(() => {
  vi.restoreAllMocks();
  loadConfig.mockReset();
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
});
const plain = () => logged.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
const run = async (argv: string[], storage: unknown) => {
  loadConfig.mockResolvedValue({ storage });
  await upgradeCommand.run({ argv: [...argv, '--config', join(dir, 'gnl.config.ts')] });
};
/** A thread an earlier version left without its owner record: `thread-records` is pending. */
async function oldThread(s: InstanceType<typeof InMemoryStorage>) {
  const j = toJournal(s.runs);
  await j.put('r1:input', { _v: 1, threadId: 't1', resourceId: 'ayse' });
  await j.put('r1:model:0', { text: 'x' });
}

describe('gnl upgrade finds the installed packages itself', () => {
  it('with no GNL package installed it says nothing about packages and runs the store steps as before', async () => {
    // "Installed" is what Node resolves from the project. Under vitest, NODE_PATH (set by pnpm's bin shim)
    // names the workspace's `.pnpm/node_modules`, where the real @gnldev/queue and @gnldev/scheduler are
    // linked and export their factories: the project dir would see them. Taken away for this case only.
    const nodePath = process.env.NODE_PATH;
    const M = Module as unknown as { _initPaths(): void };
    delete process.env.NODE_PATH;
    M._initPaths();
    try {
      const storage = new InMemoryStorage();
      await oldThread(storage);
      await run([], storage);
      expect(plain()).toMatch(/ran[\s\S]*thread-records/);
      expect(plain()).not.toMatch(/queue|scheduler|\//);
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      if (nodePath !== undefined) process.env.NODE_PATH = nodePath;
      M._initPaths();
    }
  });

  it('a package installed without a step factory (an older version) is skipped silently', async () => {
    installFake(dir, '@gnldev/queue', undefined, []);
    await run(['--dry-run'], new InMemoryStorage());
    expect(plain()).not.toMatch(/queue/);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('--dry-run prints each package step with "data vX → package vY" and what it would do, and runs nothing', async () => {
    installFake(dir, '@gnldev/queue', 'queueUpgrade', [{ name: 'fakeA/step1', versions: true }]);
    installFake(dir, '@gnldev/scheduler', 'schedulerUpgrade', [{ name: 'fakeB/step1' }]);
    const storage = new InMemoryStorage();
    await oldThread(storage);
    await run(['--dry-run'], storage);
    const out = plain();
    expect(out).toMatch(/pending[\s\S]*fakeA\/step1\s+does fakeA\/step1\s+data v1 → package v2\s+\{"would":"fakeA\/step1"\}/);
    expect(out).toMatch(/fakeB\/step1/);
    expect(out).toMatch(/Nothing was written/);
    expect(ranCount('fakeA/step1') + ranCount('fakeB/step1')).toBe(0);
    expect(await toJournal(storage.runs).get('thread-records')).toBeUndefined();
  });

  it('a plain run runs the store steps then the packages\' steps; run again, nothing is left', async () => {
    installFake(dir, '@gnldev/queue', 'queueUpgrade', [{ name: 'fakeA/step1' }]);
    installFake(dir, '@gnldev/scheduler', 'schedulerUpgrade', [{ name: 'fakeB/step1' }]);
    const storage = new InMemoryStorage();
    await oldThread(storage);
    await run([], storage);
    expect(plain()).toMatch(/ran[\s\S]*thread-records[\s\S]*fakeA\/step1[\s\S]*fakeB\/step1/);
    logged = [];
    await run([], storage);
    expect(plain()).not.toMatch(/^ran/m);
    expect(ranCount('fakeA/step1')).toBe(1);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('--only names one package step', async () => {
    installFake(dir, '@gnldev/queue', 'queueUpgrade', [{ name: 'fakeA/step1' }]);
    installFake(dir, '@gnldev/scheduler', 'schedulerUpgrade', [{ name: 'fakeB/step1' }]);
    await run(['--only', 'fakeB/step1'], new InMemoryStorage());
    expect([ranCount('fakeA/step1'), ranCount('fakeB/step1')]).toEqual([0, 1]);
  });

  it('a step the application already registered (the same factory) is not registered twice', async () => {
    const href = installFake(dir, '@gnldev/queue', 'queueUpgrade', [{ name: 'fakeA/step1' }]);
    const storage = registerUpgradeSteps(new InMemoryStorage(), [((await import(href)) as { queueUpgrade: durable.UpgradeStepFactory }).queueUpgrade]);
    await run([], storage);
    expect(ranCount('fakeA/step1')).toBe(1);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('a step that fails', () => {
  it('stops the run, prints what ran, what failed and what was not tried, and exits 1', async () => {
    installFake(dir, '@gnldev/queue', 'queueUpgrade', [{ name: 'fakeA/step1' }]);
    installFake(dir, '@gnldev/scheduler', 'schedulerUpgrade', [{ name: 'fakeB/step1' }, { name: 'fakeB/step2' }]);
    counts()['fakeB/step1'] = { runs: 0, done: false, fail: 'lease table is locked' };
    await run([], new InMemoryStorage());
    const out = plain();
    expect(out).toMatch(/^ran\n\s+fakeA\/step1/m);
    expect(out).toMatch(/^failed\n\s+fakeB\/step1.*lease table is locked/m);
    expect(out).toMatch(/not attempted \(after a failure\)\n\s+fakeB\/step2/);
    expect(process.exitCode).toBe(1);
    expect(ranCount('fakeB/step2')).toBe(0);
  });

  it('after the cause is fixed a second run finishes the rest on the same store', async () => {
    installFake(dir, '@gnldev/scheduler', 'schedulerUpgrade', [{ name: 'fakeB/step1' }, { name: 'fakeB/step2' }]);
    const storage = new SqliteStorage(join(dir, 'runs.db'));
    counts()['fakeB/step1'] = { runs: 0, done: false, fail: 'boom' };
    await run([], storage);
    expect(process.exitCode).toBe(1);
    counts()['fakeB/step1']!.fail = undefined;
    process.exitCode = undefined;
    loadConfig.mockResolvedValue({ storage: new SqliteStorage(join(dir, 'runs.db')) });
    await upgradeCommand.run({ argv: ['--config', join(dir, 'gnl.config.ts')] });
    expect(counts()['fakeB/step1']).toMatchObject({ done: true });
    expect(counts()['fakeB/step2']).toMatchObject({ done: true });
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('a step that waits for the earlier version\'s processes', () => {
  const steps = [{ name: 'fakeA/step1' }, { name: 'fakeA/cleanup', requires: ['fakeA/step1'], afterOlderGone: true }];

  it('is listed as waiting, not run by a plain upgrade, and a plain upgrade exits 0', async () => {
    installFake(dir, '@gnldev/queue', 'queueUpgrade', steps);
    const storage = new InMemoryStorage();
    await run([], storage);
    expect(plain()).toMatch(/waits for older processes[\s\S]*fakeA\/cleanup/);
    expect(ranCount('fakeA/cleanup')).toBe(0);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('runs when named with --only', async () => {
    installFake(dir, '@gnldev/queue', 'queueUpgrade', steps);
    await run([], new InMemoryStorage());
    logged = [];
    await run(['--only', 'fakeA/cleanup'], new InMemoryStorage());
    expect(plain()).toMatch(/ran[\s\S]*fakeA\/cleanup/);
    expect(ranCount('fakeA/cleanup')).toBe(1);
  });
});

describe('work in hand holds back only what is not safe beside the earlier version', () => {
  const blocked = () => settle.mockImplementation(async () => ({ blocking: true }));

  it('a package step that is not afterOlderGone runs although work is in hand', async () => {
    installFake(dir, '@gnldev/queue', 'queueUpgrade', [{ name: 'fakeA/step1' }]);
    blocked();
    await run([], new InMemoryStorage());
    expect(ranCount('fakeA/step1')).toBe(1);
    expect(settle).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('a store step still waits for it', async () => {
    installFake(dir, '@gnldev/queue', 'queueUpgrade', [{ name: 'fakeA/step1' }]);
    const storage = new InMemoryStorage();
    await oldThread(storage);
    blocked();
    await run([], storage);
    expect(ranCount('fakeA/step1')).toBe(0);
    expect(plain()).toMatch(/Not upgraded further/);
    expect(process.exitCode).toBe(2);
  });

  it('an afterOlderGone step named with --only still waits for it', async () => {
    installFake(dir, '@gnldev/queue', 'queueUpgrade', [{ name: 'fakeA/step1' }, { name: 'fakeA/cleanup', requires: ['fakeA/step1'], afterOlderGone: true }]);
    const storage = new InMemoryStorage();
    await run([], storage);
    blocked();
    await run(['--only', 'fakeA/cleanup'], storage);
    expect(ranCount('fakeA/cleanup')).toBe(0);
    expect(process.exitCode).toBe(2);
  });

  it('with nothing to run the work in hand is still asked, as before', async () => {
    await run([], new InMemoryStorage());
    expect(settle).toHaveBeenCalledTimes(1);
  });
});

describe('a package left a debt and its step is not registered', () => {
  const line = 'registerUpgradeSteps(storage, [queueUpgrade])';
  it('--dry-run and a real run both print the line to add and exit 1; nothing else is blocked from running', async () => {
    const storage = new InMemoryStorage();
    await markUpgradeDue(storage, 'fakeA/step1', { by: '@gnldev/queue', register: line, dataVersion: 1, packageVersion: 2 });
    await run(['--dry-run'], storage);
    expect(plain()).toMatch(/not registered[\s\S]*fakeA\/step1[\s\S]*data v1 → package v2/);
    expect(plain()).toContain(`add where the store is built:  ${line}`);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined; logged = [];
    await run([], storage);
    expect(plain()).toContain(line);
    expect(process.exitCode).toBe(1);
  });

  it('once the package is installed the debt is answered by its step: runs, clears, exits 0', async () => {
    const storage = new InMemoryStorage();
    await markUpgradeDue(storage, 'fakeA/step1', { by: '@gnldev/queue', register: line });
    installFake(dir, '@gnldev/queue', 'queueUpgrade', [{ name: 'fakeA/step1' }]);
    await run([], storage);
    expect(ranCount('fakeA/step1')).toBe(1);
    expect(plain()).not.toMatch(/not registered/);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('gnl doctor', () => {
  const configFile = () => { const f = join(dir, 'gnl.config.ts'); writeFileSync(f, 'export default {}\n'); return f; };

  it('lists the registered package steps and what waits, and writes nothing', async () => {
    installFake(dir, '@gnldev/queue', 'queueUpgrade', [{ name: 'fakeA/step1' }, { name: 'fakeA/cleanup', requires: ['fakeA/step1'], afterOlderGone: true }]);
    loadConfig.mockResolvedValue({ storage: new SqliteStorage(join(dir, 'runs.db')), agents: {} });
    await doctorCommand.run({ argv: ['--config', configFile()] });
    expect(plain()).toMatch(/upgrade steps registered\s+fakeA\/step1, fakeA\/cleanup/);
    expect(plain()).toMatch(/upgrade pending[\s\S]*fakeA\/step1[\s\S]*fakeA\/cleanup.*waits for every process of the earlier version/);
    expect(ranCount('fakeA/step1')).toBe(0);
  });

  it('shows a debt with no registered step and the line to add, and fails', async () => {
    const storage = new SqliteStorage(join(dir, 'runs.db'));
    await markUpgradeDue(storage, 'fakeA/step1', { by: '@gnldev/queue', register: 'registerUpgradeSteps(storage, [queueUpgrade])' });
    loadConfig.mockResolvedValue({ storage, agents: {} });
    await doctorCommand.run({ argv: ['--config', configFile()] });
    expect(plain()).toContain('add where the store is built:  registerUpgradeSteps(storage, [queueUpgrade])');
    expect(process.exitCode).toBe(1);
  });
});

describe('importing the packages registers nothing', () => {
  it('@gnldev/queue and @gnldev/scheduler imported: a store still lists no package step', async () => {
    await import('@gnldev/queue');
    await import('@gnldev/scheduler');
    const storage = new InMemoryStorage();
    expect((await storage.upgrade!({ dryRun: true })).steps.filter((s) => durable.isPackageStep(s.name))).toEqual([]);
  });
});
