// `gnl pending --wait` and `gnl upgrade --wait` end (panel decision B, 15 Oct 2026).
//
// Before: the wait had no bound. A holder that is alive but makes no progress (a frozen process — SIGSTOP,
// a paused VM — is alive by design: liveness cannot tell frozen from slow) held a deploy script forever,
// printing "waiting for N running…" four times a second and never saying what it waited for.
//
// Now: `--timeout <dur>` (the duration syntax of `gnl sweep --older-than`), 10m by default. When it
// passes, the list is printed with each holder and since when, and the exit code is 2 — the answer the
// same call without --wait gives. Nothing is canceled. The progress line is printed every 15 s.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import * as durable from '@gnldev/durable';
import { toJournal, runDurable, endDrain } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';

const loadConfig = vi.fn();
vi.mock('../src/config.js', () => ({ loadConfig: (...a: unknown[]) => loadConfig(...a) }));
vi.mock('../src/runtime.js', async (orig) => ({ ...(await orig<object>()), loadDurable: async () => durable }));
const commands = (await import('../src/commands/index.js')).commands as Record<string, { run(ctx: { argv: string[] }): Promise<void> }>;
const { upgradeCommand } = await import('../src/commands/upgrade.js');
const pendingMod = await import('../src/commands/pending.js');

const here = dirname(fileURLToPath(import.meta.url));
let dir: string;
let logged: string[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gnl-wait-'));
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logged.push(a.join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  loadConfig.mockReset();
  process.exitCode = undefined;
  endDrain();
  rmSync(dir, { recursive: true, force: true });
});
const plain = () => logged.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const callsTool = (toolName: string): any => ({
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async ({ prompt }: any) => (prompt.some((m: any) => m.role === 'tool')
    ? { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage, warnings: [] }
    : { content: [{ type: 'tool-call', toolCallId: 'call-1', toolName, input: JSON.stringify({ id: 'A' }) }], finishReason: 'tool-calls', usage, warnings: [] }),
});

/** A run whose tool body never ends in this process: running work that blocks. */
async function stuckRun(storage: SqliteStorage, runId: string): Promise<{ release: () => void; run: Promise<unknown> }> {
  const journal = toJournal(storage.runs);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let entered = false;
  const slow = tool({ description: 'slow', inputSchema: z.object({ id: z.string() }), execute: async () => { entered = true; await gate; return { ok: true }; } });
  const run = runDurable({ runId, journal, model: callsTool('slow'), tools: { slow }, prompt: 'go', stopWhen: stepCountIs(3) } as never);
  while (!entered) await new Promise((r) => setTimeout(r, 5));
  return { release, run };
}

describe('gnl pending --wait ends', () => {
  it('--timeout passes: the list is printed with holder and since-when, exit 2, JSON says timedOut', async () => {
    // The holder has its own handle on the file: the command closes the one it was given.
    const holderStorage = new SqliteStorage(join(dir, 'runs.db'));
    await holderStorage.init();
    const { release, run } = await stuckRun(holderStorage, 'r-stuck');
    const storage = new SqliteStorage(join(dir, 'runs.db'));
    await storage.init();
    loadConfig.mockResolvedValue({ storage, agents: {} });
    const t0 = Date.now();
    await commands.pending!.run({ argv: ['--wait', '--timeout', '1s', '--json'] });
    const took = Date.now() - t0;
    expect(process.exitCode).toBe(2);
    expect(took).toBeLessThan(1_000 + 2_000);
    const out = JSON.parse(logged.join('\n'));
    expect(out.timedOut).toBe(true);
    expect(out.blocking).toBe(true);
    expect(out.running.map((r: any) => r.runId)).toEqual(['r-stuck']);
    expect(typeof out.running[0].since).toBe('number');
    release();
    await run;
  }, 15_000);

  it('the text form names what is still running, since when, and the way out', async () => {
    // The holder has its own handle on the file: the command closes the one it was given.
    const holderStorage = new SqliteStorage(join(dir, 'runs.db'));
    await holderStorage.init();
    const { release, run } = await stuckRun(holderStorage, 'r-stuck2');
    const storage = new SqliteStorage(join(dir, 'runs.db'));
    await storage.init();
    loadConfig.mockResolvedValue({ storage, agents: {} });
    await commands.pending!.run({ argv: ['--wait', '--timeout', '1s'] });
    expect(process.exitCode).toBe(2);
    const text = plain();
    expect(text).toMatch(/still running after 1s/);
    expect(text).toMatch(/Nothing was canceled/);
    expect(text).toMatch(/--timeout/);
    expect(text).toMatch(/r-stuck2/);
    expect(text).toMatch(/since \d{4}-\d\d-\d\dT/);
    release();
    await run;
  }, 15_000);

  it('a duration that is not one is refused before anything waits', async () => {
    loadConfig.mockResolvedValue({ storage: new SqliteStorage(join(dir, 'runs.db')), agents: {} });
    await expect(commands.pending!.run({ argv: ['--wait', '--timeout', 'soon'] })).rejects.toThrow(/invalid duration 'soon'/);
    await expect(upgradeCommand.run({ argv: ['--wait', '--timeout', '10'] })).rejects.toThrow(/invalid duration '10'/);
  });

  it('the default is 10 minutes, and the progress line comes every 15 s, not every poll', async () => {
    expect(pendingMod.DEFAULT_WAIT_TIMEOUT).toBe('10m');
    expect(pendingMod.waitOptionsOf(['--wait']).timeoutMs).toBe(600_000);
    expect(pendingMod.waitOptionsOf(['--wait', '--timeout', '45s']).timeoutMs).toBe(45_000);
    // A clock that moves 250 ms per poll: 10 minutes is 2400 polls; the line comes every 15 s (60 polls).
    const storage = new SqliteStorage(join(dir, 'runs.db'));
    await storage.init();
    const { release, run } = await stuckRun(storage, 'r-clock');
    let now = 1_000_000;
    const p = await pendingMod.settlePending({ storage, agents: {} } as never, durable as never, {
      interactive: false, wait: true, quiet: false, timeoutMs: 600_000,
      clock: { now: () => now, sleep: async (ms: number) => { now += ms; } },
    });
    expect(p.blocking).toBe(true);
    expect(p.timedOut).toBe(true);
    const progress = logged.filter((l) => /waiting for/.test(l));
    expect(progress.length).toBeGreaterThanOrEqual(40);
    expect(progress.length).toBeLessThanOrEqual(41);
    release();
    await run;
  }, 30_000);

  it('work that ends inside the timeout: exit 0, not timed out', async () => {
    const storage = new SqliteStorage(join(dir, 'runs.db'));
    await storage.init();
    const { release, run } = await stuckRun(storage, 'r-ends');
    loadConfig.mockResolvedValue({ storage, agents: {} });
    setTimeout(release, 300);
    await commands.pending!.run({ argv: ['--wait', '--timeout', '30s', '--json'] });
    await run;
    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(logged.join('\n')).timedOut).toBeUndefined();
  }, 15_000);
});

describe('gnl upgrade --wait ends', () => {
  it('--timeout passes: no step past the format steps runs, exit 2, the list is printed', async () => {
    // The holder has its own handle on the file: `gnl upgrade` closes the one it was given.
    const holderStorage = new SqliteStorage(join(dir, 'runs.db'));
    await holderStorage.init();
    const { release, run } = await stuckRun(holderStorage, 'r-up');
    const storage = new SqliteStorage(join(dir, 'runs.db'));
    await storage.init();
    const ran = vi.spyOn(storage, 'upgrade');
    loadConfig.mockResolvedValue({ storage, agents: {} });
    await upgradeCommand.run({ argv: ['--wait', '--timeout', '1s'] });
    expect(process.exitCode).toBe(2);
    const real = ran.mock.calls.filter(([o]) => !(o as { dryRun?: boolean } | undefined)?.dryRun);
    expect(real.every(([o]) => ((o as { only?: string[] }).only ?? ['?']).every((s) => s === 'run-status' || s === 'schema'))).toBe(true);
    expect(plain()).toMatch(/still running after 1s/);
    expect(plain()).toMatch(/r-up/);
    release();
    await run;
  }, 15_000);
});

// The falsification experiment of the panel's third member: a REAL holder process, frozen with SIGSTOP —
// alive to every liveness, making no progress. `gnl upgrade --wait --timeout 1s` must end with exit 2,
// run no step, name the frozen process as the holder; after SIGCONT the effect happens once.
const tsxLoader = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'loader.mjs');
const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
describe.skipIf(process.platform === 'win32')('a frozen holder (real process, SIGSTOP)', () => {
  it('upgrade --wait --timeout 1s ends with exit 2, runs no step, names the holder; SIGCONT then runs the effect once', async () => {
    const db = join(dir, 'app.db');
    const out = join(dir, 'out.log');
    const child = spawn(process.execPath, ['--import', tsxLoader, join(here, 'fixtures', 'frozen-holder-proc.ts'), db, out], { stdio: ['ignore', 'ignore', 'inherit'] });
    try {
      for (let i = 0; i < 600 && !read(out).includes('entered'); i++) await sleep(25);
      const holder = /holder (\S+)/.exec(read(out))?.[1];
      expect(holder).toBeTruthy();
      process.kill(child.pid!, 'SIGSTOP');
      const storage = new SqliteStorage(db);
      await storage.init();
      const ran = vi.spyOn(storage, 'upgrade');
      loadConfig.mockResolvedValue({ storage, agents: {} });
      const t0 = Date.now();
      await upgradeCommand.run({ argv: ['--wait', '--timeout', '1s'] });
      const took = Date.now() - t0;
      expect(process.exitCode).toBe(2);
      expect(took).toBeLessThan(1_000 + 2_000);
      expect(ran.mock.calls.filter(([o]) => !(o as { dryRun?: boolean } | undefined)?.dryRun)).toHaveLength(0);
      expect(plain()).toContain(holder!);
      process.kill(child.pid!, 'SIGCONT');
      for (let i = 0; i < 400 && !read(out).includes('done'); i++) await sleep(25);
      expect(read(out).split('\n').filter((l) => l === 'effect').length).toBe(1);
    } finally {
      try { process.kill(child.pid!, 'SIGCONT'); } catch { /* gone */ }
      child.kill('SIGKILL');
    }
  }, 40_000);
});
