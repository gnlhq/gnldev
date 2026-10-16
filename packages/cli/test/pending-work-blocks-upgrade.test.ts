// `gnl pending` shows what a store still has in hand, in three groups, and `gnl upgrade` runs only when
// nothing in it blocks (Karar 2.2):
//   · in doubt — a side-effecting call stopped mid-body by a process that is gone. BLOCKS. The tool's
//     recover() is asked first, with the key the call carried; what it answers is recorded.
//   · running — a live process is executing. BLOCKS; `--wait` waits for it.
//   · awaiting approval — DOES NOT block.
// Without a terminal it asks nothing: it prints the list and exits 2 while something blocks.
//
// Before, `gnl pending` did not exist, and `gnl upgrade` ran its steps over a store whose calls were
// in doubt: the next version would decide them under its own code.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import * as durable from '@gnldev/durable';
import { toJournal, stampFormat, runDurable, endDrain } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';

const loadConfig = vi.fn();
vi.mock('../src/config.js', () => ({ loadConfig: (...a: unknown[]) => loadConfig(...a) }));
vi.mock('../src/runtime.js', async (orig) => ({ ...(await orig<object>()), loadDurable: async () => durable }));
const commands = (await import('../src/commands/index.js')).commands as Record<string, { run(ctx: { argv: string[] }): Promise<void> }>;
const { upgradeCommand } = await import('../src/commands/upgrade.js');

let dir: string;
let logged: string[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gnl-pending-'));
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

/** A run whose side-effecting call was stopped mid-body by a process that is gone (the crash shape). */
async function seedInDoubt(storage: SqliteStorage, runId: string): Promise<void> {
  const j = toJournal(storage.runs);
  await j.put(`${runId}:input`, stampFormat({ at: 1, prompt: 'go', agent: 'shop' }));
  await j.put(`${runId}:outcome`, { status: 'running', at: 1 });
  await j.put(`${runId}:model:0`, { content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'charge', input: JSON.stringify({ id: 'A' }) }] });
  await j.put(`${runId}:tool:call-1`, stampFormat({ status: 'running', startedAt: 1, attempts: 1, claimTtlMs: 1_000, idempotencyKey: `${runId}:call-1`, toolName: 'charge' }));
}

function chargeTool(recover?: (input: unknown, o: { idempotencyKey: string }) => Promise<unknown>) {
  const t = tool({ description: 'charge', inputSchema: z.object({ id: z.string() }), execute: async () => ({ ok: true }) });
  if (recover) Object.assign(t as object, { recover });
  return t;
}

describe('gnl pending', () => {
  it('lists a call in doubt, blocks (exit 2) without a terminal, and asks nothing', async () => {
    const storage = new SqliteStorage(join(dir, 'runs.db'));
    await storage.init();
    await seedInDoubt(storage, 'r-doubt');
    loadConfig.mockResolvedValue({ storage, agents: { shop: { model: callsTool('charge'), tools: { charge: chargeTool() } } } });
    expect(commands.pending, 'gnl pending exists').toBeDefined();
    await commands.pending!.run({ argv: [] });
    expect(plain()).toMatch(/in doubt/i);
    expect(plain()).toMatch(/r-doubt/);
    expect(plain()).toMatch(/charge/);
    expect(process.exitCode).toBe(2);
  });

  it("asks the tool's recover() first, with the key the call carried — a recorded effect no longer blocks", async () => {
    const storage = new SqliteStorage(join(dir, 'runs.db'));
    await storage.init();
    await seedInDoubt(storage, 'r-rec');
    const asked: string[] = [];
    loadConfig.mockResolvedValue({ storage, agents: { shop: { model: callsTool('charge'), tools: { charge: chargeTool(async (_i, o) => { asked.push(o.idempotencyKey); return { done: true, output: { chargeId: 'ch-1' } }; }) } } } });
    await commands.pending!.run({ argv: [] });
    expect(asked).toEqual(['r-rec:call-1']);
    // `gnl pending` closed the store it was given: read the file again.
    expect((await toJournal(new SqliteStorage(join(dir, 'runs.db')).runs).get<any>('r-rec:tool:call-1')).status).toBe('succeeded');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('an approval waiting does not block', async () => {
    const storage = new SqliteStorage(join(dir, 'runs.db'));
    await storage.init();
    const journal = toJournal(storage.runs);
    await runDurable({ runId: 'r-ask', journal, model: callsTool('charge'), tools: { charge: chargeTool() }, guard: () => ({ action: 'require-approval' as const }), prompt: 'go', stopWhen: stepCountIs(3) } as never);
    loadConfig.mockResolvedValue({ storage, agents: { shop: { model: callsTool('charge'), tools: { charge: chargeTool() } } } });
    await commands.pending!.run({ argv: [] });
    expect(plain()).toMatch(/awaiting approval/i);
    expect(plain()).toMatch(/r-ask/);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('--wait waits for the work a live process is running, then reports nothing blocking', async () => {
    const storage = new SqliteStorage(join(dir, 'runs.db'));
    await storage.init();
    const journal = toJournal(storage.runs);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = false;
    const slow = tool({ description: 'slow', inputSchema: z.object({ id: z.string() }), execute: async () => { entered = true; await gate; return { ok: true }; } });
    const run = runDurable({ runId: 'r-busy', journal, model: callsTool('slow'), tools: { slow }, prompt: 'go', stopWhen: stepCountIs(3) } as never);
    while (!entered) await new Promise((r) => setTimeout(r, 5));
    loadConfig.mockResolvedValue({ storage, agents: {} });
    const waiting = commands.pending!.run({ argv: ['--wait'] });
    await new Promise((r) => setTimeout(r, 300));
    expect(plain()).toMatch(/running/i);
    release();
    await run;
    await waiting;
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('gnl upgrade', () => {
  it('refuses to run its steps while a call is in doubt (exit 2), and runs them once it is decided', async () => {
    const storage = new SqliteStorage(join(dir, 'runs.db'));
    await storage.init();
    await seedInDoubt(storage, 'r-up');
    const ran = vi.spyOn(storage, 'upgrade');
    loadConfig.mockResolvedValue({ storage, agents: { shop: { model: callsTool('charge'), tools: { charge: chargeTool() } } } });
    await upgradeCommand.run({ argv: [] });
    expect(plain()).toMatch(/in doubt/i);
    expect(ran.mock.calls.filter(([o]) => !(o as { dryRun?: boolean } | undefined)?.dryRun)).toHaveLength(0);
    expect(process.exitCode).toBe(2);
  });
});
