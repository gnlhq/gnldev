// A sub-agent guarantees what the same agent guarantees when it runs directly. Each scenario runs one
// agent three ways — directly (`run('sub')`), as a parent's tool (`run('parent')` → `agent_sub`), and as
// a network's target (`runNetwork('n')` → sub) — and the delegated runs must match the direct one.
//
// Measured before, when a sub-agent was born through a side door that copied a hand-picked four of the
// thirty run options and five of the agent's settings: 3 of 11 guarantees held. Its own processors and
// the engine's never ran, nor its scorers, nor its own sub-agents; a cancelled request's sub-agent ran 3
// more tools; the preset's run lock was missing; and a sub-agent that read a web page let its parent pay
// afterwards. A sub-agent is now born through the engine's own agent run (registry.ts `runAgent`), one
// frame below the run that delegated (CHILD_RUN_POLICY, agent-tool.ts ChildFrame).
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryStorage, createGnl, gnlTool, STAFF, readRunTaint } from '../src/index.js';
import { createMockModel, toolCallResult, finalTextResult, countToolResults } from './mock.js';

type Counts = Record<string, number>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const scripted = (calls: { name: string; input?: object }[], c: Counts, label: string, onCall?: (n: number) => void) =>
  createMockModel(async ({ prompt }: any) => {
    c[`${label}.model`] = (c[`${label}.model`] ?? 0) + 1;
    onCall?.(c[`${label}.model`]);
    const done = countToolResults(prompt);
    const next = calls[done];
    return next ? toolCallResult(next.name, `${label}-${done}`, next.input ?? { n: done }) : finalTextResult(`${label} done`);
  });
const counting = (name: string, c: Counts, wait?: number) => ({
  description: name, inputSchema: z.object({ n: z.number().optional() }).passthrough(),
  execute: async () => { c[name] = (c[name] ?? 0) + 1; if (wait) await sleep(wait); return { ok: true }; },
});

interface Scenario {
  sub?: (c: Counts) => Record<string, unknown>;
  subCalls: { name: string; input?: object }[];
  subTools?: (c: Counts) => Record<string, unknown>;
  parentAfter?: { name: string }[];
  parentTools?: (c: Counts) => Record<string, unknown>;
  cfg?: (c: Counts) => Record<string, unknown>;
  runOpts?: () => Record<string, unknown>;
  extraAgents?: (c: Counts) => Record<string, unknown>;
  onSubModelCall?: (n: number) => void;
}
type Mode = 'direct' | 'tool' | 'network';

async function runAs(mode: Mode, s: Scenario) {
  const c: Counts = {};
  const storage = new InMemoryStorage();
  let routed = false;
  const router = createMockModel(async () => {
    if (!routed) { routed = true; return finalTextResult(JSON.stringify({ action: 'route', agent: 'sub', task: 'do it' })); }
    return finalTextResult(JSON.stringify({ action: 'final', answer: 'done' }));
  });
  const gnl = createGnl({
    storage,
    agents: {
      sub: { model: scripted(s.subCalls, c, 'sub', s.onSubModelCall), tools: s.subTools?.(c) ?? {}, maxSteps: 6, ...(s.sub?.(c) ?? {}) },
      parent: { model: scripted([{ name: 'agent_sub', input: { task: 'do it' } }, ...(s.parentAfter ?? [])], c, 'parent'), tools: s.parentTools?.(c) ?? {}, agents: ['sub'], maxSteps: 6 },
      ...(s.extraAgents?.(c) ?? {}),
    },
    networks: { n: { router, agents: ['sub'] } },
    ...(s.cfg?.(c) ?? {}),
  } as any);
  const opts = { caller: STAFF, ...(s.runOpts?.() ?? {}) };
  const t0 = Date.now();
  let error: string | undefined;
  try {
    if (mode === 'direct') await gnl.run('sub', { runId: 'd', prompt: 'do it', ...opts } as any);
    if (mode === 'tool') await gnl.run('parent', { runId: 'p', prompt: 'go', ...opts } as any);
    if (mode === 'network') await gnl.runNetwork('n', { runId: 'n', task: 'do it', ...opts } as any);
  } catch (e: any) { error = String(e?.message ?? e); }
  const keys = await storage.runs.listKeys('');
  const subRunId = mode === 'direct' ? 'd' : keys.find((k) => /^agent:.*:input$/.test(k))?.slice(0, -':input'.length);
  return { c, ms: Date.now() - t0, error, storage, keys, subRunId };
}

const ALL: Mode[] = ['direct', 'tool', 'network'];

describe('a sub-agent guarantees what the same agent guarantees directly', () => {
  it('its own processors and the engine\'s run', async () => {
    for (const mode of ALL) {
      const r = await runAs(mode, {
        subCalls: [],
        sub: (c) => ({ processors: [{ name: 'own', processInput: (i: any) => { c.own = (c.own ?? 0) + 1; return i; } }] }),
        cfg: (c) => ({ processors: [{ name: 'engine', processInput: (i: any, ctx: any) => { if (!['p', 'n'].includes(String(ctx?.runId))) c.engine = (c.engine ?? 0) + 1; return i; } }] }),
      });
      expect([mode, r.c.own, r.c.engine]).toEqual([mode, 1, 1]);
    }
  });

  it('its scorers score it', async () => {
    for (const mode of ALL) {
      const r = await runAs(mode, { subCalls: [], sub: (c) => ({ scorers: [{ name: 's', score: async () => { c.scored = (c.scored ?? 0) + 1; return { score: 1 }; } }] }) });
      expect([mode, r.c.scored]).toEqual([mode, 1]);
    }
  });

  it('its own sub-agents run', async () => {
    for (const mode of ALL) {
      const r = await runAs(mode, { subCalls: [{ name: 'agent_leaf', input: { task: 'x' } }], sub: () => ({ agents: ['leaf'] }), extraAgents: (c) => ({ leaf: { model: scripted([], c, 'leaf') } }) });
      expect([mode, r.c['leaf.model']]).toEqual([mode, 1]);
    }
  });

  it('the engine-wide tools are its tools', async () => {
    for (const mode of ALL) {
      const r = await runAs(mode, { subCalls: [{ name: 'globalTool' }], cfg: (c) => ({ tools: { globalTool: counting('globalTool', c) } }) });
      expect([mode, r.c.globalTool]).toEqual([mode, 1]);
    }
  });

  it('cancelling the request stops it — no tool runs after the abort', async () => {
    for (const mode of ['direct', 'tool'] as const) {
      const ctrl = { c: new AbortController() };
      const r = await runAs(mode, {
        subCalls: [{ name: 't' }, { name: 't' }, { name: 't' }], subTools: (c) => ({ t: counting('t', c) }),
        runOpts: () => { ctrl.c = new AbortController(); return { abortSignal: ctrl.c.signal }; },
        onSubModelCall: (n) => { if (n === 1) ctrl.c.abort(); },
      });
      expect([mode, r.c['sub.model'], r.c.t ?? 0]).toEqual([mode, 1, 1]);
    }
  });

  it('a tool timeout bounds its tools', async () => {
    for (const mode of ['direct', 'tool'] as const) {
      const r = await runAs(mode, { subCalls: [{ name: 'slow' }], subTools: (c) => ({ slow: counting('slow', c, 1200) }), runOpts: () => ({ timeouts: { toolMs: 100 } }) });
      expect([mode, r.ms < 1000]).toEqual([mode, true]);
    }
  });

  it('neither path takes the old run lock any more — one execution per run is the executor\'s record (D2)', async () => {
    // The critical preset used to stamp `<runId>:lock` on every run, the direct one and a sub-agent's alike.
    // A registry run now executes once by its execution record (detached.ts), and a sub-agent runs inside
    // its parent's single execution: the same answer on both paths is "no lock record".
    for (const mode of ['direct', 'tool'] as const) {
      const r = await runAs(mode, { subCalls: [], cfg: () => ({ preset: 'critical' }) });
      expect([mode, r.keys.includes(`${r.subRunId}:lock`)]).toEqual([mode, false]);
    }
  });

  it('a tool-call limit and its guard hold (unchanged)', async () => {
    for (const mode of ALL) {
      const limited = await runAs(mode, { subCalls: [{ name: 't' }, { name: 't' }, { name: 't' }, { name: 't' }], subTools: (c) => ({ t: counting('t', c) }), runOpts: () => ({ limits: { maxToolCalls: 2 } }) });
      expect([mode, limited.c.t]).toEqual([mode, 2]);
      const guarded = await runAs(mode, { subCalls: [{ name: 't' }], subTools: (c) => ({ t: counting('t', c) }), sub: () => ({ guard: async () => ({ action: 'deny', reason: 'no' }) }) });
      expect([mode, guarded.c.t ?? 0]).toEqual([mode, 0]);
    }
  });
});

describe('taint crosses the delegation both ways', () => {
  const fetchTool = (c: Counts) => ({ fetch: gnlTool(counting('fetch', c), { untrusted: true, sideEffect: false }) });
  const chargeTool = (c: Counts) => ({ charge: gnlTool(counting('charge', c), { sideEffect: true, idempotent: true }) });

  it('up: the parent cannot pay after its sub-agent read untrusted content, as one agent cannot', async () => {
    const one = await runAs('direct', { subCalls: [{ name: 'fetch' }, { name: 'charge' }], subTools: (c) => ({ ...fetchTool(c), ...chargeTool(c) }), runOpts: () => ({ limits: { taintedSideEffects: 'block' } }) });
    expect(one.c.charge ?? 0).toBe(0);
    const delegated = await runAs('tool', { subCalls: [{ name: 'fetch' }], subTools: fetchTool, parentAfter: [{ name: 'charge' }], parentTools: chargeTool, runOpts: () => ({ limits: { taintedSideEffects: 'block' } }) });
    expect(delegated.c.fetch).toBe(1);
    expect(delegated.c.charge ?? 0).toBe(0);
    expect(await readRunTaint(delegated.storage.runs as any, 'p')).toMatchObject({ toolName: 'fetch', reason: expect.stringMatching(/raised by sub-agent run/) });
  });

  it('up, even when the sub-agent failed after reading', async () => {
    const r = await runAs('tool', {
      subCalls: [{ name: 'fetch' }, { name: 'boom' }],
      subTools: (c) => ({ ...fetchTool(c), boom: { description: 'boom', inputSchema: z.object({}).passthrough(), execute: async () => { throw new Error('down'); } } }),
      sub: () => ({ maxSteps: 2 }),
    });
    expect(r.c.fetch).toBe(1);
    expect(await readRunTaint(r.storage.runs as any, 'p')).toBeDefined();
  });
});

describe('suggestions (Hermes): a sub-agent applies the person\'s lessons but does not learn', () => {
  it('one learning pass per request, lessons frozen for the child too', async () => {
    let passes = 0;
    const learner = createMockModel(async () => { passes++; return finalTextResult(JSON.stringify({ lessons: [] })); });
    const storage = new InMemoryStorage();
    const gnl = createGnl({ storage, suggestions: { generate: true, apply: true, model: learner },
      agents: { sub: { model: createMockModel(async () => finalTextResult('sub done')) }, parent: { model: scripted([{ name: 'agent_sub', input: { task: 'x' } }], {}, 'parent'), agents: ['sub'] } } } as any);
    await gnl.run('parent', { runId: 'p1', prompt: 'go', resourceId: 'ayse' } as any);
    const keys = await storage.runs.listKeys('');
    expect(passes).toBe(1);
    expect(keys.filter((k) => k.endsWith(':cfg:lessons'))).toHaveLength(2);
    expect(keys.filter((k) => k.endsWith(':sugg:gen'))).toEqual(['p1:sugg:gen']);
  });
});
