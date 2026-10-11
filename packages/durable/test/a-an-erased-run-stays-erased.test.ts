// An erased run stays erased, even while a worker of it is still alive.
//
// The erasure order is: cancel what should not finish, wait until `subjectRuns` says nothing of the
// person is in flight, erase. A canceled run whose worker is inside a call ANSWERED by a record (a
// repeat inside the window) holds no claim, so it reads as not in flight — and the erasure took the
// run's cancel flag with everything else. Measured before (audit k3-audit/B, N1): the worker went on,
// planned its next step, ran the same payment a SECOND time (the window record and the duplicate
// marker were gone too), and wrote the run back — model steps, outcome `completed`, metrics and the
// mirror holding the person's IBAN. A thread deletion and an organization's purge pull a run out from
// under its worker the same way.
//
// And `subjectRuns` must see a call that is executing: a tool claimed `running` under its window
// (`xreq:`/`xthr:`/`xrun:`) is "a tool call of it claimed running right now" as much as one under the
// run's own key.
//
// Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryStorage, cancelAgentRun, eraseSubject, subjectRuns, toJournal, purgeThread, purgeOrganization, withOrg, sweepRuns, BasicMemory, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { runDurable, streamDurable } from '../src/run.js';
import { runFenceKey } from '../src/erasure-fence.js';
import type { Journal } from '../src/journal.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

const PG_URL = process.env.GNL_PG_URL;
const STORES: Array<[string, () => Promise<Storage>]> = [
  ['in-memory', async () => new InMemoryStorage()],
  ['sqlite', async () => new SqliteStorage(':memory:')],
];
if (PG_URL) {
  STORES.push(['postgres (real)', async () => {
    const s = new PostgresStorage({ connectionString: PG_URL });
    ends.push(() => s.close());
    return s;
  }]);
}
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };

/** The journal, with one read held open after it returned — the moment a worker has read the record. */
function holdingJournal(inner: Journal) {
  let armed: ((k: string) => boolean) | undefined;
  const reached = gate();
  const release = gate();
  const journal = new Proxy(inner, {
    get(t, p) {
      const v = (t as any)[p];
      if (p === 'get') {
        return async (k: string) => {
          const out = await (t as any).get(k);
          if (armed && armed(k)) { armed = undefined; reached.open(); await release.p; }
          return out;
        };
      }
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return { journal, arm: (m: (k: string) => boolean) => { armed = m; }, reached: reached.p, release: release.open };
}

/** Every key whose key or value names the secret. */
async function holding(journal: Journal, secret: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const k of await journal.listKeys!(prefix)) if (k.includes(secret) || JSON.stringify(await journal.get(k) ?? null).includes(secret)) out.push(k);
  return out.sort();
}

type Deletion = 'eraseSubject' | 'purgeThread' | 'purgeOrganization';

describe.each(STORES)('an erased run stays erased — %s', (_name, make) => {
  const cases: Array<[Deletion, 'thread' | 'run']> = [
    ['eraseSubject', 'thread'], ['eraseSubject', 'run'],
    ['purgeThread', 'thread'], ['purgeThread', 'run'],
    ['purgeOrganization', 'thread'], ['purgeOrganization', 'run'],
  ];
  for (const [deletion, window] of cases) {
    it(`${deletion}: a canceled worker answered by a ${window}-window record writes nothing after it, and pays nothing again`, async () => {
      const storage = await make();
      const root = toJournal(storage.runs);
      const id = unique();
      const org = `acme${id}`;
      // purgeOrganization erases an organization; the other two run outside organizations.
      const scoped: Journal = deletion === 'purgeOrganization' ? withOrg(root, org) : root;
      const who = `ayse-${id}`;
      const thread = `T-${id}`;
      const secret = `IBAN-SECRET-${id}`;
      let executions = 0;
      const tools = {
        pay: {
          description: 'pay',
          sideEffect: true,
          idempotency: 'args' as const,
          idempotencyWindow: window,
          recover: async () => ({ done: false as const }),
          execute: async (a: { iban: string }) => { executions++; return { paid: a.iban }; },
        },
      };
      // Step 0 pays, step 1 pays the same again (the repeat), step 2 pays again once more, step 3 ends.
      let onRepeat: (() => void) | undefined;
      let modelCalls = 0;
      const model = (pre: string) => createMockModel(async ({ prompt }: any) => {
        modelCalls++;
        const n = countToolResults(prompt);
        if (n === 1) onRepeat?.();
        return n < 3 ? toolCallResult('pay', `${pre}-${n}`, { iban: secret }) : finalTextResult('done');
      });
      const run = (runId: string, journal: Journal, pre: string) => runDurable({
        runId, journal, model: model(pre), tools, prompt: `pay ${secret}`, threadId: thread, resourceId: who, stopWhen: stepCountIs(6),
      } as any);

      // On the thread window a finished run of hers leaves the record the next run is answered by.
      if (window === 'thread') await run(`r1-${id}`, scoped, 'a');
      const before = executions;

      const h = holdingJournal(scoped);
      const recordKey = (k: string) => k.startsWith(window === 'thread' ? `xthr:${thread}:args-` : `xreq:r2-${id}:args-`)
        && !k.includes(':dup') && !k.includes(':sem') && !k.includes(':owner');
      if (window === 'thread') h.arm(recordKey); else onRepeat = () => { onRepeat = undefined; h.arm(recordKey); };
      const r2 = run(`r2-${id}`, h.journal, 'b').then((v) => ({ ok: v }), (e: unknown) => ({ err: e }));
      await h.reached;

      // The documented order: cancel, see nothing in flight, delete.
      await cancelAgentRun(scoped, `r2-${id}`);
      if (deletion === 'eraseSubject') {
        expect((await subjectRuns(storage, who)).filter((r) => r.inFlight)).toEqual([]);
        await eraseSubject(storage, who);
      } else if (deletion === 'purgeThread') {
        await purgeThread(root, thread); // not refused: nothing of it reads as in flight
      } else {
        await purgeOrganization(root, org);
      }
      expect(await holding(root, secret)).toEqual([]);
      const afterDeletion = executions;
      const callsAtDeletion = modelCalls;

      // The worker goes on, to wherever it stops.
      h.release();
      const out = await r2;
      // Nothing ran again: the payment the record answered is not made a second time…
      expect(executions).toBe(window === 'thread' ? before : afterDeletion);
      // …the model is not asked again — the person's prompt does not go to the provider after she is gone…
      expect(modelCalls).toBe(callsAtDeletion);
      // …the run did not finish as if nothing had happened…
      expect('err' in out).toBe(true);
      // …and nothing of it, or of her, came back.
      expect(await scoped.listKeys!(`r2-${id}:`)).toEqual([]);
      expect(await scoped.listKeys!(window === 'thread' ? `xthr:${thread}:` : `xreq:r2-${id}:`)).toEqual([]);
      expect(await holding(root, secret)).toEqual([]);
      if (deletion === 'purgeOrganization') {
        // Nothing under the organization's prefix but what carries no data of anyone.
        const left = await root.listKeys!(`org:${org}:`);
        expect(left.filter((k) => !k.includes('__run_erased__:'))).toEqual([]);
      }
    });
  }

  it('a side effect that had not started when its canceled run was erased does not start', async () => {
    const storage = await make();
    const root = toJournal(storage.runs);
    const id = unique();
    const who = `ayse-${id}`;
    const secret = `IBAN-SECRET-${id}`;
    let executions = 0;
    const tools = {
      pay: {
        description: 'pay', sideEffect: true, recover: async () => ({ done: false as const }),
        execute: async (a: { iban: string }) => { executions++; return { paid: a.iban }; },
      },
    };
    const model = createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) < 1 ? toolCallResult('pay', 'c-0', { iban: secret }) : finalTextResult('done'));
    // Held where the call reads its record — after the model step, before its claim: it holds nothing.
    const h = holdingJournal(root);
    h.arm((k) => k === `r-${id}:tool:c-0`);
    const r = runDurable({ runId: `r-${id}`, journal: h.journal, model, tools, prompt: `pay ${secret}`, threadId: `T-${id}`, resourceId: who, stopWhen: stepCountIs(3) } as any)
      .then((v) => ({ ok: v }), (e: unknown) => ({ err: e }));
    await h.reached;
    await cancelAgentRun(root, `r-${id}`);
    expect((await subjectRuns(storage, who)).filter((x) => x.inFlight)).toEqual([]);
    await eraseSubject(storage, who);
    h.release();
    const out = await r;
    expect(executions).toBe(0);
    expect(await holding(root, secret)).toEqual([]);
    expect(await root.listKeys!(`r-${id}:`)).toEqual([]);
    expect('err' in out).toBe(true);
  });

  it('a turn deleted while its last model step runs writes nothing back — not into the run, not into the thread', async () => {
    const storage = await make();
    const root = toJournal(storage.runs);
    const id = unique();
    const who = `ayse-${id}`;
    const thread = `T-${id}`;
    const secret = `IBAN-SECRET-${id}`;
    const inStep = gate();
    const answer = gate();
    const model = createMockModel(async () => { inStep.open(); await answer.p; return finalTextResult(`your IBAN is ${secret}`); });
    const r = runDurable({ runId: `r-${id}`, journal: root, model, memory: new BasicMemory(root), prompt: `mine is ${secret}`, threadId: thread, resourceId: who } as any)
      .then((v) => ({ ok: v }), (e: unknown) => ({ err: e }));
    await inStep.p;
    // Deleted mid-step, without waiting for it (`allowInFlight`: the run is known to be in flight).
    await purgeThread(root, thread, { allowInFlight: true });
    expect(await holding(root, secret)).toEqual([]);
    answer.open();
    const out = await r;
    expect(await root.listKeys!(`mem:${thread}:`)).toEqual([]);
    expect(await holding(root, secret)).toEqual([]);
    expect(await root.listKeys!(`r-${id}:`)).toEqual([]);
    expect('err' in out && (out.err as Error).name).toBe('RunErasedError');
  });

  it('streamDurable: a turn deleted while its last step streams writes nothing back — not into the run, not into the thread', async () => {
    const storage = await make();
    const root = toJournal(storage.runs);
    const id = unique();
    const thread = `T-${id}`;
    const secret = `IBAN-SECRET-${id}`;
    const inStep = gate();
    const answer = gate();
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
    const model = {
      specificationVersion: 'v4', provider: 'mock', modelId: 'mock-stream', supportedUrls: {},
      doGenerate: async () => { throw new Error('stream-only'); },
      doStream: async () => {
        inStep.open();
        await answer.p;
        return { stream: new ReadableStream({ start(c) {
          for (const p of [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: `your IBAN is ${secret}` },
            { type: 'text-end', id: '1' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }]) c.enqueue(p);
          c.close();
        } }) };
      },
    };
    const r = (async () => {
      const res: any = await streamDurable({ runId: `r-${id}`, journal: root, model, memory: new BasicMemory(root), prompt: `mine is ${secret}`, threadId: thread, resourceId: `ayse-${id}` } as any);
      for await (const _ of res.fullStream) { /* drain */ }
    })().then(() => undefined, () => undefined);
    await inStep.p;
    await purgeThread(root, thread, { allowInFlight: true });
    expect(await holding(root, secret)).toEqual([]);
    answer.open();
    await r;
    await new Promise((res) => setTimeout(res, 50));
    expect(await root.listKeys!(`mem:${thread}:`)).toEqual([]);
    expect(await holding(root, secret)).toEqual([]);
    expect(await root.listKeys!(`r-${id}:`)).toEqual([]);
  });

  it('streamDurable: a canceled worker answered by a thread-window record writes nothing after the erasure, and pays nothing again', async () => {
    const storage = await make();
    const root = toJournal(storage.runs);
    const id = unique();
    const who = `ayse-${id}`;
    const thread = `T-${id}`;
    const secret = `IBAN-SECRET-${id}`;
    let executions = 0;
    const tools = {
      pay: {
        description: 'pay', sideEffect: true, idempotency: 'args' as const, idempotencyWindow: 'thread' as const,
        recover: async () => ({ done: false as const }),
        execute: async (a: { iban: string }) => { executions++; return { paid: a.iban }; },
      },
    };
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
    const parts = (arr: any[]) => new ReadableStream({ start(c) { for (const p of arr) c.enqueue(p); c.close(); } });
    const streamModel = (pre: string) => ({
      specificationVersion: 'v4', provider: 'mock', modelId: 'mock-stream', supportedUrls: {},
      doGenerate: async () => { throw new Error('stream-only'); },
      doStream: async ({ prompt }: any) => {
        const n = countToolResults(prompt);
        return {
          stream: parts(n < 3
            ? [{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: `${pre}-${n}`, toolName: 'pay', input: JSON.stringify({ iban: secret }) },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage }]
            : [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'done' }, { type: 'text-end', id: '1' },
              { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }]),
        };
      },
    });
    const run = async (runId: string, journal: Journal, pre: string) => {
      const res: any = await streamDurable({ runId, journal, model: streamModel(pre), tools, prompt: `pay ${secret}`, threadId: thread, resourceId: who, stopWhen: stepCountIs(6) } as any);
      for await (const _ of res.fullStream) { /* drain */ }
    };
    await run(`r1-${id}`, root, 'a');
    expect(executions).toBe(1);
    const h = holdingJournal(root);
    h.arm((k) => k.startsWith(`xthr:${thread}:args-`) && !k.includes(':dup') && !k.includes(':sem') && !k.includes(':owner'));
    const r2 = run(`r2-${id}`, h.journal, 'b').then(() => undefined, () => undefined);
    await h.reached;
    await cancelAgentRun(root, `r2-${id}`);
    expect((await subjectRuns(storage, who)).filter((r) => r.inFlight)).toEqual([]);
    await eraseSubject(storage, who);
    expect(await holding(root, secret)).toEqual([]);
    h.release();
    await r2;
    // The stream's own callbacks settle after the stream ends: give them a moment, then look.
    await new Promise((r) => setTimeout(r, 50));
    expect(executions).toBe(1);
    expect(await root.listKeys!(`r2-${id}:`)).toEqual([]);
    expect(await root.listKeys!(`xthr:${thread}:`)).toEqual([]);
    expect(await holding(root, secret)).toEqual([]);
  });

  it('a deleted run id is refused, and its fence is swept with the retention horizon', async () => {
    const storage = await make();
    const root = toJournal(storage.runs);
    const id = unique();
    const model = createMockModel(async () => finalTextResult('ok'));
    await runDurable({ runId: `r-${id}`, journal: root, model, prompt: 'hi' } as any);
    const { purgeRun } = await import('../src/index.js');
    await purgeRun(root, `r-${id}`);
    // The fence names no one: a hash, `{ erased, at }`.
    const fences = await root.listKeys!('__run_erased__:');
    expect(fences.some((k) => k.includes(`r-${id}`))).toBe(false);
    await expect(runDurable({ runId: `r-${id}`, journal: root, model, prompt: 'hi' } as any)).rejects.toMatchObject({ name: 'RunErasedError' });
    expect(await root.listKeys!(`r-${id}:`)).toEqual([]);
    // Within the horizon it stays; past it, retention takes it, and the id is free again.
    const fence = runFenceKey(`r-${id}`);
    expect(await root.get(fence)).toMatchObject({ erased: true });
    await sweepRuns(root as any, { olderThanMs: 60_000 });
    expect(await root.get(fence)).toBeDefined();
    const swept = await sweepRuns(root as any, { olderThanMs: 60_000, now: Date.now() + 120_000 });
    expect(swept.fencesSwept).toBeGreaterThan(0);
    expect(await root.get(fence)).toBeUndefined();
    await expect(runDurable({ runId: `r-${id}`, journal: root, model, prompt: 'hi' } as any)).resolves.toBeDefined();
  });

  // `subjectRuns`' contract: "a model step or tool call of it is claimed `running` right now".
  for (const window of ['call', 'run', 'thread', 'cross-run'] as const) {
    it(`subjectRuns sees a canceled run whose ${window}-window tool call is executing`, async () => {
      const storage = await make();
      const root = toJournal(storage.runs);
      const id = unique();
      const who = `ayse-${id}`;
      const inBody = gate();
      const finish = gate();
      const tools = {
        pay: {
          description: 'pay',
          sideEffect: true,
          ...(window === 'call' ? {} : { idempotency: 'args' as const, idempotencyWindow: window }),
          recover: async () => ({ done: false as const }),
          execute: async (a: { n: string }) => { inBody.open(); await finish.p; return { paid: a.n }; },
        },
      };
      const model = createMockModel(async ({ prompt }: any) =>
        countToolResults(prompt) < 1 ? toolCallResult('pay', 'c-0', { n: `n-${id}` }) : finalTextResult('done'));
      const r = runDurable({ runId: `r-${id}`, journal: root, model, tools, prompt: 'pay', threadId: `T-${id}`, resourceId: who, stopWhen: stepCountIs(3) } as any)
        .then((v) => v, (e) => e);
      await inBody.p;
      await cancelAgentRun(root, `r-${id}`);
      const runs = await subjectRuns(storage, who);
      finish.open();
      await r;
      expect(runs).toEqual([expect.objectContaining({ runId: `r-${id}`, inFlight: true })]);
    });
  }
}, 60_000);
