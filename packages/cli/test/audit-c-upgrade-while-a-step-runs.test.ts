// AUDIT C (red): `gnl upgrade` runs its steps while a live process is in the middle of a run's model
// step — pendingWork lists a run as running only while a tool body runs (see
// packages/durable/test/audit-c-a-model-step-in-flight-is-pending.test.ts).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as durable from '@gnldev/durable';
import { toJournal, runDurable } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';

const loadConfig = vi.fn();
vi.mock('../src/config.js', () => ({ loadConfig: (...a: unknown[]) => loadConfig(...a) }));
vi.mock('../src/runtime.js', async (orig) => ({ ...(await orig<object>()), loadDurable: async () => durable }));
const { upgradeCommand } = await import('../src/commands/upgrade.js');

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
let dir: string;
afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; rmSync(dir, { recursive: true, force: true }); });

describe('gnl upgrade while a run is in its model step', () => {
  it('refuses (exit 2): the run is work in hand', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    dir = mkdtempSync(join(tmpdir(), 'gnl-up-step-'));
    const storage = new SqliteStorage(join(dir, 'runs.db'));
    await storage.init();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inStep = false;
    const model: any = {
      specificationVersion: 'v2', provider: 'probe', modelId: 'm', supportedUrls: {},
      doGenerate: async () => { inStep = true; await gate; return { content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] }; },
      doStream: async () => { throw new Error('no stream'); },
    };
    const run = runDurable({ runId: 'r-step', journal: toJournal(storage.runs), model, prompt: 'go' } as never);
    while (!inStep) await new Promise((r) => setTimeout(r, 5));
    const ran = vi.spyOn(storage, 'upgrade');
    loadConfig.mockResolvedValue({ storage, agents: {} });
    vi.spyOn(storage, 'close').mockImplementation(async () => {});
    await upgradeCommand.run({ argv: [] });
    const realSteps = ran.mock.calls.filter(([o]) => !(o as { dryRun?: boolean } | undefined)?.dryRun).length;
    const exit = process.exitCode ?? 0;
    release();
    await run;
    expect({ realSteps, exit }).toEqual({ realSteps: 0, exit: 2 });
  });
});
