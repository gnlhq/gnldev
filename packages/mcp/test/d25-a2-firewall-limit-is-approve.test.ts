// mcpFirewall's PER-RUN CALL LIMIT IS AN APPROVE QUESTION (d25 approval policy, step 2; KARAR-1 "ADIM 2 / POLİTİKA").
//
// `maxCallsPerRun`: once a tool has succeeded that many times in a run, the next call stops for a human.
// Step 2: that question is APPROVE — the requester (who may be the one driving the loop) cannot say yes
// to more; an authorised person can. Her no goes through.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { jsonSchema } from 'ai';
import * as durable from '@gnldev/durable';
import { InMemoryStorage, createGnl, STAFF, user, providerIdOf, mintCallId } from '@gnldev/durable';
import { mcpFirewall } from '../src/index.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

const usage = { inputTokens: { total: 1, noCache: 1 }, outputTokens: { total: 1, text: 1 } };
const fin = (unified: string) => ({ unified, raw: unified });
// Call ids are GNL ids (`call_1.gnl-<run>-<step>-<n>`): the second call is step 1, index 0 of run 'fw'.
/** A model that sends two refunds (call_0, call_1), then answers. */
function model(): any {
  const gen = async ({ prompt }: any) => {
    const n = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
    return n < 2
      ? { content: [{ type: 'tool-call', toolCallId: `call_${n}`, toolName: 'refund', input: JSON.stringify({ amount: 100 }) }], finishReason: fin('tool-calls'), usage, warnings: [] }
      : { content: [{ type: 'text', text: 'done' }], finishReason: fin('stop'), usage, warnings: [] };
  };
  return {
    specificationVersion: 'v4', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: gen,
    doStream: async (o: any) => {
      const r = await gen(o);
      const parts: any[] = [{ type: 'stream-start', warnings: [] }];
      for (const c of r.content) {
        if (c.type === 'tool-call') parts.push(c);
        else parts.push({ type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: c.text }, { type: 'text-end', id: '1' });
      }
      parts.push({ type: 'finish', finishReason: r.finishReason, usage });
      return { stream: new ReadableStream({ start(ctl) { for (const p of parts) ctl.enqueue(p); ctl.close(); } }) };
    },
  };
}

const settle = <T>(p: Promise<T>) => p.then((r) => ({ ok: true as const, r }), (e: any) => ({ ok: false as const, e }));

function setup() {
  const effects = { n: 0 };
  const storage = new InMemoryStorage();
  const refund = { description: 'refund', inputSchema: jsonSchema({ type: 'object' }), execute: async () => { effects.n++; return { ok: true }; } };
  const gnl = createGnl({ storage, agents: { a: { model: model(), tools: { refund }, guard: mcpFirewall({ server: 'pay', journal: storage.runs, tools: [], maxCallsPerRun: 1 }) } } } as never);
  const go = (caller: unknown, approvals?: Record<string, boolean>) => settle(gnl.run('a', { runId: 'fw', prompt: 'go', caller, ...(approvals ? { approvals } : {}) } as never));
  return { effects, go };
}

describe('mcpFirewall maxCallsPerRun → approve', () => {
  it('precondition (holds today): the second call stops at a question after the first succeeded', async () => {
    const s = setup();
    const r: any = await s.go(user('u-ayse'));
    expect(s.effects.n).toBe(1);
    expect(r.ok && r.r.interrupts.map((i: any) => providerIdOf(i.toolCallId))).toEqual(['call_1']);
  });

  it('the requester\'s yes to go past the limit is refused (typed, coded); nothing runs', async () => {
    const s = setup();
    await s.go(user('u-ayse'));
    const out: any = await s.go(user('u-ayse'), { [mintCallId('call_1', 'fw', 1, 0)]: true });
    expect(out.ok, 'the requester lifted the per-run call limit herself').toBe(false);
    expect(typeof out.e?.code === 'string' && out.e.code.length > 0, `no string code: ${out.e}`).toBe(true);
    const cls = Object.values(durable).find((v) => typeof v === 'function' && (v as { name?: string }).name === out.e.name) as any;
    expect(cls && out.e instanceof cls, `'${out.e?.name}' is not a typed error exported by @gnldev/durable`).toBe(true);
    expect(s.effects.n).toBe(1);
  });

  it('staff\'s yes lets the second call run once', async () => {
    const s = setup();
    await s.go(user('u-ayse'));
    const out: any = await s.go(STAFF, { [mintCallId('call_1', 'fw', 1, 0)]: true });
    expect(out.ok, String(out.e)).toBe(true);
    expect(s.effects.n).toBe(2);
  });

  it('the requester\'s no goes through (no second refund)', async () => {
    const s = setup();
    await s.go(user('u-ayse'));
    const out: any = await s.go(user('u-ayse'), { [mintCallId('call_1', 'fw', 1, 0)]: false });
    expect(out.ok, String(out.e)).toBe(true);
    expect(s.effects.n).toBe(1);
  });
});
