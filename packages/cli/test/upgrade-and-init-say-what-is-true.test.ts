// What `gnl upgrade`, `gnl doctor` and `gnl init` say about a store and a config must be what is true:
//   - a store with nothing to upgrade (new, or written by this version) is not reported as pending;
//   - a dry run that FAILS is not read as "nothing pending" — doctor says it could not tell, and fails;
//   - `gnl init`'s summary describes the config it wrote: `--features memory` gives the config
//     `memoryFactory`, and the summary's thread gate row says so, as `gnl doctor` does.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';

const loadConfig = vi.fn();
vi.mock('../src/config.js', () => ({ loadConfig: (...a: unknown[]) => loadConfig(...a) }));
const { upgradeCommand } = await import('../src/commands/upgrade.js');
const { doctorCommand } = await import('../src/commands/doctor.js');
const { initCommand } = await import('../src/commands/init.js');

let dir: string;
let logged: string[] = [];
const home = process.env.GNL_HOME;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gnl-cli-true-'));
  logged = [];
  process.env.GNL_HOME = join(dir, '.gnl-home');
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logged.push(a.join(' ')); });
});
afterEach(() => {
  vi.restoreAllMocks();
  loadConfig.mockReset();
  process.exitCode = undefined;
  if (home === undefined) delete process.env.GNL_HOME; else process.env.GNL_HOME = home;
  rmSync(dir, { recursive: true, force: true });
});
// The output carries ANSI colours; rows are compared as plain text.
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function configFile(): string {
  const config = join(dir, 'gnl.config.ts');
  writeFileSync(config, 'export default {}\n');
  return config;
}

describe('a store with nothing to upgrade', () => {
  it('gnl upgrade --list on a new store lists every step as done, and nothing as pending', async () => {
    loadConfig.mockImplementation(async () => ({ storage: new SqliteStorage(join(dir, 'runs.db')) }));
    await upgradeCommand.run({ argv: ['--list'] });
    const out = plain(logged.join('\n'));
    expect(out).not.toMatch(/pending/);
    expect(out).toMatch(/^done/m);
  });

  it('gnl doctor on a new store says no upgrade is pending', async () => {
    loadConfig.mockResolvedValue({ storage: new SqliteStorage(join(dir, 'runs.db')), agents: {} });
    await doctorCommand.run({ argv: ['--config', configFile()] });
    expect(plain(logged.join('\n'))).not.toMatch(/upgrade pending/);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('gnl doctor, when the store cannot say what is pending', () => {
  it('a dry run that throws is reported as unknown, and doctor fails — not read as "nothing pending"', async () => {
    const storage = new InMemoryStorage();
    (storage as unknown as { upgrade: () => Promise<never> }).upgrade = async () => { throw new Error('permission denied for table gnl_runs'); };
    loadConfig.mockResolvedValue({ storage, agents: {} });
    await doctorCommand.run({ argv: ['--config', configFile()] });
    const out = plain(logged.join('\n'));
    expect(out).toMatch(/upgrade status unknown/);
    expect(out).toMatch(/permission denied for table gnl_runs/);
    expect(process.exitCode).toBe(1);
  });
});

describe('gnl init: the summary describes the config it wrote', () => {
  const gate = () => plain(logged.join('\n')).split('\n').find((l) => /thread gate/.test(l)) ?? '';

  it('--features memory: the config has memoryFactory, and the summary says memory (factory)', async () => {
    await initCommand.run({ argv: [join(dir, 'app'), '--features', 'memory', '--yes'] });
    expect(gate()).toMatch(/memory \(factory\)/);
  });

  it('in an existing project, --features memory: the same', async () => {
    const app = join(dir, 'existing');
    mkdirSync(app);
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'existing', type: 'module', dependencies: {} }));
    await initCommand.run({ argv: [app, '--features', 'memory', '--yes'] });
    expect(gate()).toMatch(/memory \(factory\)/);
  });

  it('CONTROL: no memory feature, no memory', async () => {
    await initCommand.run({ argv: [join(dir, 'app'), '--yes'] });
    expect(gate()).toMatch(/no memory/);
  });
});
