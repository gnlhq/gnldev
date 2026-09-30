// retryJob continues the dead letter's durable run instead of starting a new one.
//
// README line 3: "a side effect already recorded as done is not run again". That holds while the worker
// retries a job by itself (same job id → same `job:<id>` run → the journal replays the done effect).
// It did not hold across `retryJob`: the dead letter was re-enqueued under a NEW id, so the handler's
// `ctx.run` started a NEW run `job:<new id>`, found an empty journal, and fired the effect again.
// Measured on 0.9.0 (in-memory and SQLite): a charge that landed before the outage was charged twice.
// @gnldev/events' retryDeadEvent keeps the event id, so a run keyed by it resumes — this matches it.
//
// The invariant: a job's durable run is the job's identity for side effects, and a retry of the job is
// the same job. The retry is still a NEW record (the dead letter stays for audit, and the queue's
// append-only log/cursor are untouched); it carries the ORIGINAL run id.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, type Storage, type Guard } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { enqueue, createWorker, retryJob, listJobs } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/** Turn 1: call `charge`. Turn 2 (after the charge result): call `ship`. Then throw while `crash.on`, else answer. */
function model(crash: { on: boolean }): any {
  return {
    specificationVersion: 'v2', provider: 'probe', modelId: 'm', supportedUrls: {},
    doGenerate: async ({ prompt }: any) => {
      const toolMsgs = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
      if (toolMsgs === 0) return { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'charge', input: '{}' }], finishReason: 'tool-calls', usage, warnings: [] };
      if (toolMsgs === 1) return { content: [{ type: 'tool-call', toolCallId: 'c2', toolName: 'ship', input: '{}' }], finishReason: 'tool-calls', usage, warnings: [] };
      if (crash.on) throw new Error('downstream outage');
      return { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage, warnings: [] };
    },
    doStream: async () => { throw new Error('no stream'); },
  };
}

const stores: Array<[string, () => Storage]> = [
  ['in-memory', () => new InMemoryStorage()],
  ['sqlite', () => new SqliteStorage(':memory:') as unknown as Storage],
];

function payWorker(storage: Storage, crash: { on: boolean }, maxAttempts = 2) {
  const seen: { jobId: string; runId: string }[] = [];
  const effects = { charge: 0, ship: 0 };
  const worker = createWorker(storage, {
    pay: async (_p, ctx) => {
      seen.push({ jobId: ctx.jobId, runId: ctx.runId });
      await ctx.run({
        model: model(crash),
        tools: {
          charge: { execute: async () => ({ ok: ++effects.charge }) },
          ship: { execute: async () => ({ ok: ++effects.ship }) },
        } as any,
        prompt: 'pay',
      });
    },
  }, { maxAttempts });
  return { worker, seen, effects };
}

const statusOf = async (s: Storage, id: string) => (await listJobs(s.work!)).find((j) => j.id === id)!.status;

describe.each(stores)('retryJob continues the dead letter\'s run — %s', (_n, make) => {
  it('CONTROL: a crashed job the worker retries by itself charges once', async () => {
    const storage = make();
    const crash = { on: true };
    const { worker, effects } = payWorker(storage, crash, 5);
    await enqueue(storage.work!, 'pay', {}, { resourceId: 'ayse' });
    await worker.runOnce();
    crash.on = false;
    await worker.drain();
    expect(effects).toEqual({ charge: 1, ship: 1 });
  });

  it('retryJob on the dead letter does not charge a second time', async () => {
    const storage = make();
    const crash = { on: true };
    const { worker, seen, effects } = payWorker(storage, crash);
    const id = await enqueue(storage.work!, 'pay', {}, { resourceId: 'ayse' });
    await worker.drain();
    expect(await statusOf(storage, id)).toBe('failed');
    expect(effects).toEqual({ charge: 1, ship: 1 }); // landed once, journaled in job:<id>
    crash.on = false; // the outage is over; the operator retries the dead letter
    const again = await retryJob(storage.work!, id);
    await worker.drain();
    expect(again).not.toBe(id); // a new record: the dead letter stays for audit
    expect(await statusOf(storage, again!)).toBe('done');
    expect(await statusOf(storage, id)).toBe('failed');
    expect(effects).toEqual({ charge: 1, ship: 1 });
    expect(new Set(seen.map((s) => s.runId))).toEqual(new Set([`job:${id}`])); // one run, continued
    expect(seen.at(-1)!.jobId).toBe(again); // ctx.jobId is the record being processed
  });

  it('a retry of a retry still continues the ORIGINAL run', async () => {
    const storage = make();
    const crash = { on: true };
    const { worker, seen, effects } = payWorker(storage, crash);
    const id = await enqueue(storage.work!, 'pay', {}, { resourceId: 'ayse' });
    await worker.drain();
    const r1 = await retryJob(storage.work!, id); // the outage is not over yet
    await worker.drain();
    expect(await statusOf(storage, r1!)).toBe('failed');
    crash.on = false;
    const r2 = await retryJob(storage.work!, r1!);
    await worker.drain();
    expect(await statusOf(storage, r2!)).toBe('done');
    expect(effects).toEqual({ charge: 1, ship: 1 });
    expect(new Set(seen.map((s) => s.runId))).toEqual(new Set([`job:${id}`]));
  });

  it('retryJob called twice on one dead letter (a double click) still charges once', async () => {
    const storage = make();
    const crash = { on: true };
    const { worker, effects } = payWorker(storage, crash);
    const id = await enqueue(storage.work!, 'pay', {}, { resourceId: 'ayse' });
    await worker.drain();
    crash.on = false;
    const a = await retryJob(storage.work!, id);
    const b = await retryJob(storage.work!, id);
    await worker.drain();
    expect([await statusOf(storage, a!), await statusOf(storage, b!)]).toEqual(['done', 'done']);
    expect(effects).toEqual({ charge: 1, ship: 1 });
  });

  it('a job whose run was suspended for approval: after approval, the retry resumes it — the done charge is not repeated', async () => {
    const storage = make();
    const effects = { charge: 0, ship: 0 };
    const approvals: Record<string, boolean> = {};
    // `ship` needs a human; the handler treats a still-suspended run as a failure (it may not ack it).
    const guard: Guard = ({ toolName }) => (toolName === 'ship' ? { action: 'require-approval', reason: 'manual' } : { action: 'allow' });
    const worker = createWorker(storage, {
      pay: async (_p, ctx) => {
        const res = await ctx.run({
          model: model({ on: false }),
          tools: {
            charge: { execute: async () => ({ ok: ++effects.charge }) },
            ship: { execute: async () => ({ ok: ++effects.ship }) },
          } as any,
          guard,
          approvals,
          prompt: 'pay',
        });
        if (res.interrupts.length > 0) throw new Error('awaiting approval');
      },
    }, { maxAttempts: 1 });
    const id = await enqueue(storage.work!, 'pay', {}, { resourceId: 'ayse' });
    await worker.drain();
    expect(await statusOf(storage, id)).toBe('failed');
    expect(effects).toEqual({ charge: 1, ship: 0 });
    approvals.c2 = true; // the operator approves, then retries the dead letter
    const again = await retryJob(storage.work!, id);
    await worker.drain();
    expect(await statusOf(storage, again!)).toBe('done');
    expect(effects).toEqual({ charge: 1, ship: 1 });
  });

  it('the way through: retryJob(…, { newRun: true }) starts a fresh run on purpose', async () => {
    const storage = make();
    const crash = { on: true };
    const { worker, seen, effects } = payWorker(storage, crash);
    const id = await enqueue(storage.work!, 'pay', {}, { resourceId: 'ayse' });
    await worker.drain();
    crash.on = false;
    const again = await retryJob(storage.work!, id, { newRun: true });
    await worker.drain();
    expect(seen.at(-1)!.runId).toBe(`job:${again}`);
    expect(effects).toEqual({ charge: 2, ship: 2 }); // what the caller asked for: everything again
  });

  it('the retry keeps the owner', async () => {
    const storage = make();
    const { worker } = payWorker(storage, { on: true });
    const id = await enqueue(storage.work!, 'pay', {}, { resourceId: 'ayse', orgId: 'acme' });
    await worker.drain();
    const again = await retryJob(storage.work!, id);
    expect((await listJobs(storage.work!)).find((j) => j.id === again)).toMatchObject({ resourceId: 'ayse', orgId: 'acme', status: 'pending' });
  });
});

describe('a dead letter far behind the scan cursor', () => {
  it('the retry is picked up even after the worker\'s cursor moved past the dead letter\'s page', async () => {
    const storage = new InMemoryStorage();
    let fail = true;
    const ran: string[] = [];
    const worker = createWorker(storage, {
      t: async (p: any) => { if (p.n === 0 && fail) throw new Error('x'); ran.push(String(p.n)); },
    }, { maxAttempts: 1 });
    const first = await enqueue(storage.work, 't', { n: 0 });
    for (let i = 1; i < 120; i++) await enqueue(storage.work, 't', { n: i });
    await worker.drain(); // pages of 50 → the cursor advances past page one
    expect(await statusOf(storage, first)).toBe('failed');
    fail = false;
    await retryJob(storage.work, first);
    ran.length = 0;
    await worker.drain();
    expect(ran).toEqual(['0']);
  });
});

describe('records written by 0.9.0', () => {
  it('a retry copy made by 0.9.0 (no run link) keeps running under its own id', async () => {
    const storage = new InMemoryStorage();
    const seen: string[] = [];
    const worker = createWorker(storage, { t: async (_p, ctx) => void seen.push(ctx.runId) });
    // What 0.9.0's retryJob wrote: an ordinary job record, nothing linking it to the dead letter.
    const id = await enqueue(storage.work, 't', {}, { id: 'copy-from-0.9.0' });
    await worker.drain();
    expect(seen).toEqual([`job:${id}`]);
  });

  it('a 0.9.0 dead letter retried after the upgrade continues its original run', async () => {
    const storage = new InMemoryStorage();
    const crash = { on: true };
    const { worker, effects } = payWorker(storage, crash);
    const id = await enqueue(storage.work, 'pay', {}); // a system job: no owner fields, as most 0.9.0 jobs
    await worker.drain();
    crash.on = false;
    await retryJob(storage.work, id);
    await worker.drain();
    expect(effects).toEqual({ charge: 1, ship: 1 });
  });
});
