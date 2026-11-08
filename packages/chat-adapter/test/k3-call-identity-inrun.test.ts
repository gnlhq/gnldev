// k3 — inside ONE run, a provider may name the call of every response `call_0` (it numbers per response).
// Two steps of one run are two calls even when their id strings are equal. Behaviour only, through the
// doors a client uses (REST /run, /stream, the chat surface), in process, on SQLite and in memory.
//
//   R1  two steps, both `call_0`, different arguments (5, then 7) → both run (effects [5, 7]) and the model
//       sees each call's own result. Same arguments twice (a plain read, really two requests) → both run.
//   R2  two steps, both `call_0`, both need a person (confirm: true); only the first is approved → the
//       second is asked, not run on the first one's approval. Approving it too runs it (nothing is lost).
//
// Every case also runs with ids=unique (a fresh id per call): the control, today's behaviour.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { z } from 'zod';
import { InMemoryStorage } from '@gnldev/durable';
import { createRestApi } from '../../server/dist/index.js';
import { chatSurface } from '../dist/index.js';
import { AgentMemory } from '../../memory/dist/index.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
type Step = { tool: string; args: Record<string, unknown> };

/** A provider that answers a script: step n calls script[n] (id `call_0` every time, or unique), then text.
 *  `seen[n]` = the output of the newest tool result the model was shown when asked for step n. */
function scriptedModel(script: Step[], ids: 'same' | 'unique', seen: unknown[]) {
  const stream = (parts: any[]) => ({ stream: new ReadableStream({ start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); for (const p of parts) c.enqueue(p); c.close(); } }) });
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => { throw new Error('stream only'); },
    doStream: async ({ prompt }: any) => {
      const lastUser = prompt.map((m: any) => m.role).lastIndexOf('user');
      const results = prompt.slice(lastUser).filter((m: any) => m.role === 'tool').flatMap((m: any) => m.content.filter((p: any) => p.type === 'tool-result'));
      const n = results.length;
      if (n > 0) seen[n] = results[n - 1].output;
      if (n < script.length) {
        const id = ids === 'same' ? 'call_0' : `call_${crypto.randomUUID()}`;
        return stream([{ type: 'tool-call', toolCallId: id, toolName: script[n].tool, input: JSON.stringify(script[n].args) }, { type: 'finish', finishReason: 'tool-calls', usage }]);
      }
      return stream([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'done' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: 'stop', usage }]);
    },
  } as any;
}

async function storageOf(kind: string): Promise<any> {
  if (kind === 'memory') return new InMemoryStorage();
  const { SqliteStorage } = await import('@gnldev/durable/sqlite') as any;
  return new SqliteStorage(':memory:');
}

function setup(storage: any, model: any, tools: Record<string, any>) {
  const config: any = { storage, preset: 'assistant', memoryFactory: (st: any) => new AgentMemory({ storage: st }), agents: { a: { model, system: 'assistant', tools } } };
  return createRestApi(config, { surfaces: [chatSurface()], protectionsBanner: false } as any);
}

/** Sends one turn through a door; returns the questions and the text the client got. */
async function send(api: any, door: string, turn: string, approvals?: Record<string, boolean>) {
  const h = { 'content-type': 'application/json' };
  const req = door === 'chat'
    ? new Request('http://x/agents/a/chat', { method: 'POST', headers: h, body: JSON.stringify({ id: 'conv-1', resourceId: 'u1', messages: [{ id: `m-${turn}`, role: 'user', parts: [{ type: 'text', text: turn }] }], ...(approvals ? { approvals } : {}) }) })
    : new Request(`http://x/agents/a/${door}`, { method: 'POST', headers: h, body: JSON.stringify({ workKey: `wk-${turn}`, resourceId: 'u1', threadId: 'th-1', messages: [{ role: 'user', content: turn }], ...(approvals ? { approvals } : {}) }) });
  const res = await api(req);
  const raw = await res.text();
  let text = ''; let interrupts: any[] = [];
  if (door === 'run') { const j = JSON.parse(raw); text = j.text ?? ''; interrupts = j.interrupts ?? []; }
  else if (door === 'stream') {
    for (const blk of raw.split('\n\n')) { const ev = /^event: (.*)$/m.exec(blk)?.[1]; const d = /^data: (.*)$/m.exec(blk)?.[1]; if (!d) continue; let j: any; try { j = JSON.parse(d); } catch { continue; } if (ev === 'interrupt') interrupts = j.interrupts ?? interrupts; if (ev === 'text-delta') text += j.text ?? ''; }
  } else {
    for (const blk of raw.split('\n\n')) { const d = /^data: (.*)$/m.exec(blk)?.[1]; if (!d || d === '[DONE]') continue; let j: any; try { j = JSON.parse(d); } catch { continue; } if (j.type === 'data-gnl-interrupt') interrupts = j.data?.interrupts ?? interrupts; if (j.type === 'text-delta') text += j.delta ?? ''; }
  }
  return { status: res.status, text, interrupts: interrupts.map((i: any) => ({ toolCallId: i.toolCallId, args: i.args, reason: String(i.reason ?? '') })), raw: res.status >= 400 ? raw.slice(0, 400) : '' };
}

const outputHas = (o: unknown, v: number) => JSON.stringify(o ?? null).includes(`"amount":${v}`) || JSON.stringify(o ?? null).includes(`"charged":${v}`);
const STORES = ['sqlite', 'memory'];
const DOORS = ['run', 'stream', 'chat'];
const IDS = ['same', 'unique'] as const;

describe.each(STORES)('k3 R1 [%s] — two steps of one run, both named call_0, are two calls', (store) => {
  for (const door of DOORS) for (const ids of IDS) {
    it(`${door} · ids=${ids}: pay 5 then pay 7 → both run, each result reaches the model`, async () => {
      const paid: number[] = []; const seen: unknown[] = [];
      const api = setup(await storageOf(store), scriptedModel([{ tool: 'pay', args: { amount: 5 } }, { tool: 'pay', args: { amount: 7 } }], ids, seen), {
        pay: { description: 'pay', inputSchema: z.object({ amount: z.number() }), sideEffect: true, execute: async (a: any) => { paid.push(a.amount); return { charged: a.amount }; } },
      });
      const r = await send(api, door, 'pay 5 then 7');
      console.log(`[R1 ${store} ${door} ${ids}] paid=${JSON.stringify(paid)} seen=${JSON.stringify(seen.slice(1))} q=${r.interrupts.length} text=${r.text} ${r.raw}`);
      expect(paid).toEqual([5, 7]);
      expect(outputHas(seen[1], 5), 'step 1 result shown to the model').toBe(true);
      expect(outputHas(seen[2], 7), 'step 2 result shown to the model is its own (7), not step 1\'s').toBe(true);
      expect(r.text).toBe('done');
    });

    it(`${door} · ids=${ids}: the same read twice (two real requests) → both run, each gets its own answer`, async () => {
      let n = 0; const seen: unknown[] = [];
      const api = setup(await storageOf(store), scriptedModel([{ tool: 'ticket', args: { q: 'next' } }, { tool: 'ticket', args: { q: 'next' } }], ids, seen), {
        ticket: { description: 'take the next queue ticket', inputSchema: z.object({ q: z.string() }), idempotent: true, execute: async () => ({ amount: ++n }) },
      });
      const r = await send(api, door, 'two tickets');
      console.log(`[R1same ${store} ${door} ${ids}] bodies=${n} seen=${JSON.stringify(seen.slice(1))} text=${r.text} ${r.raw}`);
      expect(n).toBe(2);
      expect(outputHas(seen[1], 1)).toBe(true);
      expect(outputHas(seen[2], 2)).toBe(true);
    });

    it(`${door} · ids=${ids}: a side-effect tool with the same arguments twice is handled exactly like with unique ids`, async () => {
      // The reference is the control's outcome (two calls with distinct ids), measured in the same test.
      const outcome = async (which: 'same' | 'unique') => {
        const paid: number[] = []; const seen: unknown[] = [];
        const api = setup(await storageOf(store), scriptedModel([{ tool: 'pay', args: { amount: 5 } }, { tool: 'pay', args: { amount: 5 } }], which, seen), {
          pay: { description: 'pay', inputSchema: z.object({ amount: z.number() }), sideEffect: true, execute: async (a: any) => { paid.push(a.amount); return { charged: a.amount }; } },
        });
        const r = await send(api, door, 'pay 5 twice');
        return { paid, asked: r.interrupts.length, text: r.text };
      };
      const ref = await outcome('unique');
      const got = await outcome(ids);
      console.log(`[R1dup ${store} ${door} ${ids}] got=${JSON.stringify(got)} ref(unique)=${JSON.stringify(ref)}`);
      expect(got).toEqual(ref);
    });
  }
});

describe.each(STORES)('k3 R2 [%s] — an approval answers only the call it was given for, even when ids repeat', (store) => {
  for (const door of DOORS) for (const idem of ['call', 'args'] as const) for (const ids of IDS) {
    it(`${door} · idempotency=${idem} · ids=${ids}: approving pay 5 does not run pay 7 unasked`, async () => {
      const paid: number[] = []; const seen: unknown[] = [];
      const api = setup(await storageOf(store), scriptedModel([{ tool: 'pay', args: { amount: 5 } }, { tool: 'pay', args: { amount: 7 } }], ids, seen), {
        pay: { description: 'pay', inputSchema: z.object({ amount: z.number() }), sideEffect: true, confirm: true, ...(idem === 'args' ? { idempotency: 'args' } : {}), execute: async (a: any) => { paid.push(a.amount); return { charged: a.amount }; } },
      });
      const r1 = await send(api, door, 'pay 5 then 7');
      expect(r1.interrupts.length, 'precondition: pay 5 is asked').toBe(1);
      expect(paid).toEqual([]);
      const q1 = r1.interrupts[0].toolCallId;
      const r2 = await send(api, door, 'pay 5 then 7', { [q1]: true }); // a person approved ONLY the first question
      console.log(`[R2 ${store} ${door} ${idem} ${ids}] after approving q1(${q1}): paid=${JSON.stringify(paid)} q=${JSON.stringify(r2.interrupts.map((i) => [i.toolCallId, i.args]))} text=${r2.text} ${r2.raw}`);
      expect(paid, 'pay 7 ran on pay 5\'s approval').toEqual([5]);
      expect(r2.interrupts.length, 'pay 7 must be asked').toBe(1);
      expect(JSON.stringify(r2.interrupts[0].args ?? '')).toContain('7');
      const q2 = r2.interrupts[0].toolCallId;
      const r3 = await send(api, door, 'pay 5 then 7', { [q1]: true, [q2]: true });
      console.log(`[R2b ${store} ${door} ${idem} ${ids}] after approving q2(${q2}): paid=${JSON.stringify(paid)} text=${r3.text}`);
      expect(paid).toEqual([5, 7]);
      expect(r3.text).toBe('done');
    });
  }
});
