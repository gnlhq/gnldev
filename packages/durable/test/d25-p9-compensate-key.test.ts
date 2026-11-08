// d25 P2 madde 9 (saga/KARAR-2): compensate(args, output, opts) also gets the key of the operation it
// reverses, as `opts.callIdempotencyKey` (the name the decision file proposes). `opts.idempotencyKey` stays
// the key of the REFUND itself (existing meaning, unchanged), and `recover` keeps getting the operation's key.
import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import * as durable from '../src/index.js';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { compensateRun } from '../src/compensation.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const callsOnce = (name: string, args: unknown, id: string) => createMockModel(async ({ prompt }: any) => {
  const lastUser = prompt.map((m: any) => m.role).lastIndexOf('user');
  return countToolResults(prompt.slice(lastUser)) === 0 ? toolCallResult(name, id, args) : finalTextResult('done');
});

function bookTool(log: { exec: string[]; recover: string[]; comp: any[] }, keyFn?: (i: any) => string) {
  return durable.gnlTool(tool({
    description: 'b', inputSchema: z.object({ id: z.string() }),
    execute: async (_i, o) => { log.exec.push((o as any).idempotencyKey); return { booked: 1 }; },
  }), {
    sideEffect: true,
    ...(keyFn ? { idempotencyKey: keyFn, idempotencyWindow: 'run' } : {}),
    recover: async (_i: unknown, o: any) => { log.recover.push(o.idempotencyKey); return { done: false as const }; },
    compensate: async (_i: unknown, _o: unknown, o: any) => { log.comp.push({ ...o }); return { cancelled: 1 }; },
  } as any);
}
const fresh = () => ({ exec: [] as string[], recover: [] as string[], comp: [] as any[] });

describe('P2-9 compensate gets the key of the operation it undoes', () => {
  it('keyed tool: opts.callIdempotencyKey === the key execute was given', async () => {
    const log = fresh(); const journal = new InMemoryJournal();
    const book = bookTool(log, (i) => `bk-${i.id}`);
    await runDurable({ runId: 'sg1', journal, model: callsOnce('book', { id: 'h1' }, 'k1'), tools: { book }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ayse' });
    await compensateRun('sg1', { journal, tools: { book } as never });
    expect(log.exec).toHaveLength(1);
    expect(log.comp).toHaveLength(1);
    expect(log.comp[0].callIdempotencyKey).toBe(log.exec[0]);
  });

  it('keyless tool (the engine builds the key): same equality', async () => {
    const log = fresh(); const journal = new InMemoryJournal();
    const book = bookTool(log);
    await runDurable({ runId: 'sg2', journal, model: callsOnce('book', { id: 'h2' }, 'k2'), tools: { book }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ayse' });
    await compensateRun('sg2', { journal, tools: { book } as never });
    expect(typeof log.comp[0].callIdempotencyKey).toBe('string');
    expect(log.comp[0].callIdempotencyKey).toBe(log.exec[0]);
  });

  it('the refund\'s own key is a different value from the operation\'s, and keeps its old meaning', async () => {
    const log = fresh(); const journal = new InMemoryJournal();
    const book = bookTool(log, (i) => `bk-${i.id}`);
    await runDurable({ runId: 'sg3', journal, model: callsOnce('book', { id: 'h3' }, 'k3'), tools: { book }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ayse' });
    await compensateRun('sg3', { journal, tools: { book } as never });
    expect(typeof log.comp[0].callIdempotencyKey).toBe('string');
    expect(typeof log.comp[0].idempotencyKey).toBe('string');
    expect(log.comp[0].idempotencyKey).not.toBe(log.comp[0].callIdempotencyKey);
    expect(typeof log.comp[0].toolCallId).toBe('string');
  });

  it('control: recover() is given the operation\'s key (the value compensate must now match)', async () => {
    const log = fresh(); const journal = new InMemoryJournal();
    // a failed first attempt drives recover(); the retry then succeeds, and the saga is unwound
    let n = 0;
    const book = durable.gnlTool(tool({ description: 'b', inputSchema: z.object({ id: z.string() }), execute: async (_i, o) => { log.exec.push((o as any).idempotencyKey); if (n++ === 0) throw new Error('timeout'); return { booked: 1 }; } }), {
      sideEffect: true,
      recover: async (_i: unknown, o: any) => { log.recover.push(o.idempotencyKey); return { done: false as const }; },
      compensate: async (_i: unknown, _o: unknown, o: any) => { log.comp.push({ ...o }); return { cancelled: 1 }; },
    } as any);
    const { withIdempotency } = await import('../src/idempotent-tools.js');
    const t = withIdempotency({ book } as any, { journal }) as any;
    const ctx = { toolCallId: 'k4', messages: [] };
    await t.book.execute({ id: 'h4' }, ctx).catch(() => undefined);
    await t.book.execute({ id: 'h4' }, ctx).catch(() => undefined);
    expect(log.recover.length).toBeGreaterThanOrEqual(1);
    expect(log.recover[0]).toBe(log.exec[0]);
  });

  it('two bookings in one run: each compensate call gets ITS OWN operation key', async () => {
    const log = fresh(); const journal = new InMemoryJournal();
    const book = bookTool(log, (i) => `bk-${i.id}`);
    const m = createMockModel(async ({ prompt }: any) => {
      const n = countToolResults(prompt);
      return n < 2 ? toolCallResult('book', `s${n}`, { id: `h${n}` }) : finalTextResult('done');
    });
    await runDurable({ runId: 'sg5', journal, model: m, tools: { book }, prompt: 'x', stopWhen: stepCountIs(6), resourceId: 'ayse' });
    await compensateRun('sg5', { journal, tools: { book } as never });
    expect(log.exec).toHaveLength(2);
    expect(log.comp.map((c) => c.callIdempotencyKey).sort()).toEqual([...log.exec].sort());
  });
});
