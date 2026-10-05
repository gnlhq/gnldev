// Other paths to the same sub-agent rules: a crash inside the child, a host-built sub-agent
// (createAgentTool), an approval two levels down, a parallel fan-out under a tool-call limit, a child
// blocked by the taint ladder, and a cross-run key across two requests.
import { it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryStorage, InMemoryJournal, createGnl, createAgentTool, runDurable, gnlTool, STAFF } from '../src/index.js';
import { createMockModel, toolCallResult, finalTextResult } from './mock.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const rows: string[] = [];
const report = (id: string, observed: string, expected: string, pass: boolean) =>
  rows.push(`${id.padEnd(44)} | ${pass ? 'PASS' : 'FAIL'} | observed: ${observed} | expected: ${expected}`);

const effect = (did: string[], name: string, o: { key?: (a: any) => string; confirm?: boolean; untrusted?: boolean; sideEffect?: boolean; slowMs?: number } = {}) =>
  gnlTool({ description: name, inputSchema: z.object({}).passthrough(), execute: async (a: any) => {
    if (o.slowMs) await new Promise((r) => setTimeout(r, o.slowMs));
    if (o.sideEffect !== false) did.push(`${name}:${a.id ?? ''}`);
    return { ok: true };
  } }, { sideEffect: o.sideEffect ?? true, ...(o.key ? { idempotencyWindow: 'run', idempotencyKey: o.key } : {}), ...(o.confirm ? { confirm: true } : {}), ...(o.untrusted ? { untrusted: true } : {}) } as any);

/** A model that runs `steps` (each a list of parallel calls), then answers. */
const scripted = (steps: { tool: string; args: object }[][], tag = 'p', crashAfter?: { at: number; once: { done: boolean } }) => createMockModel(async ({ prompt }: any) => {
  const done = prompt.filter((m: any) => m.role === 'assistant').length;
  if (crashAfter && done === crashAfter.at && !crashAfter.once.done) { crashAfter.once.done = true; throw new Error('process died'); }
  const step = steps[done];
  if (!step) return finalTextResult(`${tag} done`);
  return { content: step.map((c, i) => ({ type: 'tool-call', toolCallId: done === 0 && tag !== 'p' ? `call_${i}` : `${tag}${done}-${i}`, toolName: c.tool, input: JSON.stringify(c.args) })), finishReason: 'tool-calls', usage, warnings: [] };
});
/** A sub-agent that does what its task (JSON {tool,args}) says. */
const worker = () => createMockModel(async ({ prompt }: any) => {
  if (prompt.some((m: any) => m.role === 'tool')) return finalTextResult('worker done');
  const text = prompt.find((m: any) => m.role === 'user').content.map((c: any) => c.text ?? '').join('');
  const t = JSON.parse(text.slice(text.indexOf('{')));
  return toolCallResult(t.tool, 'call_0', t.args);
});
const task = (tool: string, args: object) => ({ task: JSON.stringify({ tool, args }) });

it('siblings', async () => {
  // a) the process dies INSIDE the sub-agent, after its effect and before it answers; the request is re-run.
  {
    const did: string[] = [];
    const once = { done: false };
    const childModel = createMockModel(async ({ prompt }: any) => {
      if (prompt.some((m: any) => m.role === 'tool')) { if (!once.done) { once.done = true; throw new Error('process died'); } return finalTextResult('done'); }
      return toolCallResult('ship', 'call_0', { id: 'O-1' });
    });
    const gnl = createGnl({ storage: new InMemoryStorage(), agents: {
      parent: { model: scripted([[{ tool: 'agent_courier', args: task('ship', { id: 'O-1' }) }]]), agents: ['courier'] },
      courier: { model: childModel, tools: { ship: effect(did, 'ship', { key: (a) => a.id }) } },
    } } as any);
    for (let i = 0; i < 2; i++) { try { await gnl.run('parent', { runId: 'a', prompt: 'go', caller: STAFF } as any); break; } catch { /* died */ } }
    report('a) crash inside the child, re-run', did.join(' '), 'ship:O-1', did.join(' ') === 'ship:O-1');
  }

  // b) a host-built sub-agent (createAgentTool + runDurable), handed the same order twice.
  {
    const did: string[] = [];
    const journal = new InMemoryJournal();
    const sub = createAgentTool({ journal, model: worker(), tools: { ship: effect(did, 'ship', { key: (a) => a.id }) } } as any);
    await runDurable({ runId: 'b', journal, model: scripted([[{ tool: 'courier', args: task('ship', { id: 'O-1' }) }], [{ tool: 'courier', args: task('ship', { id: 'O-1' }) }]]), tools: { courier: sub }, prompt: 'go', caller: STAFF } as any);
    report('b) host-built sub-agent, handed twice', did.join(' '), 'ship:O-1', did.join(' ') === 'ship:O-1');
  }

  // c) two levels down: two grandchildren wait for approval with the same inner id; only one is approved.
  {
    const did: string[] = [];
    const storage = new InMemoryStorage();
    const agents = {
      parent: { model: scripted([[{ tool: 'agent_office', args: { task: 'file both' } }]]), agents: ['office'] },
      office: { model: scripted([[{ tool: 'agent_filer', args: task('fileReturn', { id: 'A' }) }, { tool: 'agent_filer', args: task('fileReturn', { id: 'B' }) }]], 'o'), agents: ['filer'] },
      filer: { model: worker(), tools: { fileReturn: effect(did, 'fileReturn', { key: (a) => a.id, confirm: true }) } },
    };
    const r1: any = await createGnl({ storage, agents } as any).run('parent', { runId: 'c', prompt: 'go', caller: STAFF } as any);
    const ids = (r1.interrupts ?? []).map((i: any) => i.toolCallId);
    const a = (r1.interrupts ?? []).find((i: any) => JSON.stringify(i.args).includes('"A"'));
    await createGnl({ storage, agents } as any).run('parent', { runId: 'c', prompt: 'go', caller: STAFF, approvals: a ? { [a.toolCallId]: true } : {} } as any);
    report('c) depth-2 approval addressing', `ids ${JSON.stringify(ids)}; after one approval: ${did.join(' ')}`, 'fileReturn:A only', did.join(' ') === 'fileReturn:A');
  }

  // d) a parallel fan-out under a request limit: 12 restarts in one step, maxToolCalls 5.
  for (const mode of ['direct', 'sub'] as const) {
    const did: string[] = [];
    const restart = effect(did, 'restart', { key: (a) => a.id, slowMs: 20 });
    const calls = Array.from({ length: 12 }, (_, i) => mode === 'direct' ? { tool: 'restart', args: { id: `s${i}` } } : { tool: 'agent_sre', args: task('restart', { id: `s${i}` }) });
    const gnl = createGnl({ storage: new InMemoryStorage(), agents: {
      parent: mode === 'direct' ? { model: scripted([calls]), tools: { restart } } : { model: scripted([calls]), agents: ['sre'] },
      sre: { model: worker(), tools: { restart } },
    } } as any);
    try { await gnl.run('parent', { runId: 'd', prompt: 'go', caller: STAFF, limits: { maxToolCalls: 5 } } as any); } catch { /* limit */ }
    report(`d) parallel fan-out, limit 5 (${mode})`, `restarts ${did.length}`, '5', did.length === 5);
  }

  // e) a sub-agent blocked by the taint ladder: what the parent is told.
  {
    const did: string[] = [];
    let seen = '';
    const parentModel = createMockModel(async ({ prompt }: any) => {
      const tools = prompt.filter((m: any) => m.role === 'tool');
      if (tools.length) { seen = JSON.stringify(tools.at(-1).content[0].output).slice(0, 160); return finalTextResult('ok'); }
      return toolCallResult('agent_buyer', 'p0', { task: 'read then pay' });
    });
    const buyer = createMockModel(async ({ prompt }: any) => {
      const n = prompt.filter((m: any) => m.role === 'tool').length;
      return n === 0 ? toolCallResult('fetchPage', 'call_0', {}) : n === 1 ? toolCallResult('pay', 'call_1', { id: 'I-1' }) : finalTextResult('buyer done');
    });
    const gnl = createGnl({ storage: new InMemoryStorage(), agents: {
      parent: { model: parentModel, agents: ['buyer'] },
      buyer: { model: buyer, tools: { fetchPage: effect(did, 'fetchPage', { sideEffect: false, untrusted: true }), pay: effect(did, 'pay', { key: (a) => a.id }) } },
    } } as any);
    await gnl.run('parent', { runId: 'e', prompt: 'go', caller: STAFF, limits: { taintedSideEffects: 'block' } } as any);
    report('e) child blocked by taint: parent sees', seen, 'a failure it can branch on; pay not run', /"status":"failed"|error-text/.test(seen) && !did.includes('pay:I-1'));
  }

  // f) two separate requests delegate the same work under a cross-run key: still once (window unchanged by the fix).
  {
    const did: string[] = [];
    const storage = new InMemoryStorage();
    const ship = gnlTool({ description: 'ship', inputSchema: z.object({}).passthrough(), execute: async (a: any) => { did.push(`ship:${a.id}`); return { ok: true }; } }, { sideEffect: true, idempotencyKey: (a: any) => a.id, idempotencyWindow: 'cross-run' } as any);
    for (const runId of ['f1', 'f2']) {
      await createGnl({ storage, agents: { parent: { model: scripted([[{ tool: 'agent_courier', args: task('ship', { id: 'O-9' }) }]]), agents: ['courier'] }, courier: { model: worker(), tools: { ship } } } } as any)
        .run('parent', { runId, prompt: 'go', caller: STAFF } as any);
    }
    report('f) two requests, cross-run key', did.join(' '), 'ship:O-9', did.join(' ') === 'ship:O-9');
  }

  expect(rows.filter((r) => r.includes('| FAIL |'))).toEqual([]);
}, 300_000);
