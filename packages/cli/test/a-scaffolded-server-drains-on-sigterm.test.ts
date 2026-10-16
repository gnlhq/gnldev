// A project `gnl init --host <x>` writes shuts down the framework's way: its server entry drains on
// SIGTERM (`drainOnSignal`), and the pm2 config it ships waits longer than the drain before it kills.
//
// Before, the entry installed nothing — a process manager's SIGTERM killed the process where it stood,
// with a tool or a queue job in hand — and no process-manager config was written at all, so pm2 ran
// it with its own 1.6 s kill_timeout.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DRAIN_DEADLINE_MS } from '@gnldev/durable';
import { scaffold } from '../src/scaffold.js';
import { HOST_IDS } from '../src/hosts.js';

const dirs: string[] = [];
const fresh = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'gnl-drain-'));
  rmSync(d, { recursive: true, force: true });
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('a scaffolded server drains on SIGTERM', () => {
  it.each(HOST_IDS)('%s: src/server.ts installs the drain', (id) => {
    const dir = fresh();
    scaffold(dir, { template: 'minimal', host: id });
    const server = readFileSync(join(dir, 'src/server.ts'), 'utf8');
    expect(server).toMatch(/import \{[^}]*\bdrainOnSignal\b[^}]*\} from '@gnldev\/durable';/);
    expect(server).toMatch(/^drainOnSignal\(/m);
  });

  it.each(HOST_IDS)('%s: ecosystem.config.cjs waits longer than the drain before it kills', (id) => {
    const dir = fresh();
    scaffold(dir, { template: 'minimal', host: id });
    const file = join(dir, 'ecosystem.config.cjs');
    expect(existsSync(file), 'a pm2 config ships with the server').toBe(true);
    const cfg = createRequire(import.meta.url)(file) as { apps: Array<{ kill_timeout: number; script: string }> };
    expect(cfg.apps).toHaveLength(1);
    expect(cfg.apps[0]!.kill_timeout).toBeGreaterThan(DRAIN_DEADLINE_MS);
  });

  it('mount mode writes no pm2 config — the server, and how it is run, are the reader\'s', () => {
    const dir = fresh();
    scaffold(dir, { template: 'minimal', host: 'express', hostMode: 'mount' });
    expect(existsSync(join(dir, 'ecosystem.config.cjs'))).toBe(false);
  });
});
