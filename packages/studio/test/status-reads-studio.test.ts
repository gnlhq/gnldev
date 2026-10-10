// C+ step A in Studio: the approval inbox and the live update stream stop reading every run.
//
// 1M runs, 167 suspended, organizations present (measured, cplus-base): GET /approvals listed all
// 1 000 020 runs (20 001 pages, 23.3 s) to keep 167; GET /events listed all of them on every 2 s tick
// (22.8 s each — under an organization's presence the cheap signal is unavailable), the database 73%
// busy for one open tab and 94% for three. Here: the same answers, from the suspended runs and from
// the change feed. "Read" is counted at the journal's own surface — the run summaries it hands out.
import { describe, it, expect } from 'vitest';
import { createGnl, toJournal, withOrg, InMemoryStorage, type Journal, type JournalReader } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { createStudioApi } from '../src/server.js';

type J = Journal & JournalReader;
const drive = (api: unknown) => api as (r: Request) => Promise<Response>;
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const POLL_MS = 2000; // EVENTS_POLL_MS in server.ts

function mockModel(doGenerate: (o: any) => Promise<any>): any {
  return { specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {}, doGenerate, doStream: async () => { throw new Error('no stream'); } };
}
const toolCall = (toolName: string, toolCallId: string, args: unknown) => ({ content: [{ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(args) }], finishReason: 'tool-calls', usage, warnings: [] });
const finalText = (text: string) => ({ content: [{ type: 'text', text }], finishReason: 'stop', usage, warnings: [] });

/** A real suspension (a real `:input`, a real sentinel) through the engine, in the journal given. */
async function suspend(journal: J, runId: string, extra: Record<string, unknown> = {}) {
  const gnl = createGnl({
    journal,
    agents: {
      pay: {
        model: mockModel(async ({ prompt }: any) => ((prompt ?? []).some((m: any) => m?.role === 'tool') ? finalText('done') : toolCall('payOut', `call-${runId}`, { amount: 5 }))),
        tools: { payOut: { sideEffect: true, confirm: true as const, execute: async () => ({ ok: true }) } },
      },
    },
  } as never);
  await gnl.run('pay', { runId, prompt: 'pay', ...extra } as never);
}

const step = (n: number) => ({ content: [{ type: 'text', text: `s${n}` }], finishReason: 'stop', usage });

/**
 * A store whose inbox is small and whose history is not: `completed` finished runs at the root and in
 * acme, three suspended at the root (one owned by a person), two in acme, and one canceled while
 * suspended (status 'canceled' — not in the inbox, by the status precedence).
 */
async function mixedStore(j: J, completed = 120) {
  for (let i = 0; i < completed; i++) await j.put(`hist-${String(i).padStart(3, '0')}:model:0`, step(i));
  for (let i = 0; i < 40; i++) await j.put(`org:acme:hist-${i}:model:0`, step(i));
  await suspend(j, 'wait-1');
  await suspend(j, 'wait-2', { resourceId: 'u-ayse', actor: 'ayse' });
  await suspend(j, 'wait-3');
  await suspend(j, 'wait-x');
  await j.put('wait-x:outcome', { status: 'canceled', at: 1 });
  const acme = withOrg(j, 'acme') as J;
  await suspend(acme, 'acme-wait-1');
  await suspend(acme, 'acme-wait-2');
}

/** The journal with capabilities removed — what a journal written before them is. */
function without<T extends object>(j: T, ...names: string[]): T {
  return new Proxy(j, {
    get: (t, p) => {
      if (names.includes(p as string)) return undefined;
      const v = Reflect.get(t, p, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
    has: (t, p) => !names.includes(p as string) && Reflect.has(t, p),
  });
}

/** Counts the run summaries the journal hands out through its listings, and its readRun calls. */
function counting(j: J) {
  const read = { listed: 0, listRunsCalls: 0, readRun: 0 };
  const proxy = new Proxy(j, {
    get(t, p) {
      const v = Reflect.get(t, p, t);
      if (typeof v !== 'function') return v;
      if (p === 'listRuns') return async (...a: unknown[]) => { read.listRunsCalls++; const r: any = await v.apply(t, a); read.listed += Array.isArray(r) ? r.length : r.items.length; return r; };
      if (p === 'listRunsPaged') return async (...a: unknown[]) => { const r: any = await v.apply(t, a); read.listed += r.items.length; return r; };
      if (p === 'readRun') return async (...a: unknown[]) => { read.readRun++; return v.apply(t, a); };
      return v.bind(t);
    },
  }) as J;
  return { proxy, read };
}

const authProvider = {
  authenticate: (req: Request) => {
    const t = req.headers.get('authorization')?.replace('Bearer ', '');
    if (t === 'acme') return { kind: 'operator', roles: ['admin'], id: 'u-acme', orgId: 'acme' };
    if (t === 'root') return { kind: 'operator', roles: ['admin', 'platform-admin'], id: 'u-root' };
    return null;
  },
  authorize: () => ({ allow: true }),
  capabilities: () => ({ sso: false, rbac: false, audit: false, multiOrganization: false, users: false }),
};

const stores: [string, () => J][] = [
  ['SqliteStorage', () => toJournal(new SqliteStorage(':memory:'))],
  ['InMemoryStorage', () => toJournal(new InMemoryStorage())],
];

async function approvals(reader: J, who: 'root' | 'acme') {
  const api = drive(createStudioApi({ reader, auth: authProvider, org: {} } as never));
  const res = await api(new Request('http://s/approvals', { headers: { authorization: `Bearer ${who}` } }));
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: unknown[] }).items;
}

describe.each(stores)('GET /approvals — %s', (_name, make) => {
  it('reads the suspended runs, not the store', async () => {
    const j = make();
    await mixedStore(j);
    // The root scope reads every SUSPENDED run of the store (acme's two too) and drops acme's — its
    // cost follows the store's suspended runs, never its size. acme reads its own range only.
    for (const [who, suspended, listed] of [['root', 3, 5], ['acme', 2, 2]] as const) {
      const { proxy, read } = counting(j);
      const items = await approvals(proxy, who);
      expect(items).toHaveLength(suspended);
      expect(read.listRunsCalls, 'the inbox listed the whole store').toBe(0);
      expect(read.listed).toBe(listed);
      expect(read.readRun).toBe(suspended);
    }
  });

  it('answers exactly what the full listing answered — every field, the same order — at the root and in an organization', async () => {
    const j = make();
    await mixedStore(j);
    for (const who of ['root', 'acme'] as const) {
      const now = await approvals(j, who);
      const before = await approvals(without(j, 'listRunsPaged'), who); // the pre-change path: listRuns() then filter
      expect(now).toEqual(before);
      expect(now.length).toBeGreaterThan(0);
    }
  });
});

/** Frames off a live SSE response, collected in the background (a cancelled read ends the stream). */
function watchSse(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const frames: { event?: string; data: string }[] = [];
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (let i = buf.indexOf('\n\n'); i !== -1; i = buf.indexOf('\n\n')) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          let event: string | undefined; let data = '';
          for (const line of chunk.split('\n')) { if (line.startsWith('event:')) event = line.slice(6).trim(); else if (line.startsWith('data:')) data += line.slice(5).trim(); }
          frames.push({ event, data });
        }
      }
    } catch { /* cancelled */ }
  })();
  const ids = () => new Set(frames.flatMap((f) => (f.data.startsWith('{') ? (JSON.parse(f.data).runIds as string[]) : [])));
  return {
    frames, ids,
    until: async (pred: () => boolean, ms: number) => { const stop = Date.now() + ms; while (!pred() && Date.now() < stop) await new Promise((r) => setTimeout(r, 25)); },
    close: () => reader.cancel().catch(() => {}),
  };
}

describe('GET /events — the change feed', () => {
  it('never lists the run list, and still announces a step on an OLD run and a status flip — with organizations present', async () => {
    const j = toJournal(new SqliteStorage(':memory:'));
    await mixedStore(j, 60);
    const { proxy, read } = counting(j);
    const api = drive(createStudioApi({ reader: proxy, auth: authProvider, org: {} } as never));
    const w = watchSse(await api(new Request('http://s/events', { headers: { authorization: 'Bearer root' } })));
    try {
      await new Promise((r) => setTimeout(r, 1.5 * POLL_MS)); // the silent baseline
      expect(w.frames).toEqual([]);
      await j.put('hist-003:model:1', step(99)); // an OLD run, far from the newest
      await w.until(() => w.ids().has('hist-003'), 3 * POLL_MS);
      expect([...w.ids()]).toEqual(['hist-003']);
      await j.put('wait-1:tool:call-wait-1', { status: 'succeeded', output: { ok: true } }); // the approval decided
      await w.until(() => w.ids().has('wait-1'), 3 * POLL_MS);
      expect(w.ids().has('wait-1')).toBe(true);
      await j.put('org:acme:hist-7:model:1', step(98)); // the root scope is not told about acme
      await new Promise((r) => setTimeout(r, 1.5 * POLL_MS));
      expect([...w.ids()].some((id) => id.includes('acme'))).toBe(false);
      expect(read.listRunsCalls, 'the stream listed the whole store').toBe(0);
      expect(read.listed, 'the stream paged through the run list').toBe(0);
    } finally {
      await w.close();
    }
  }, 30_000);

  it('a change stamped behind the newest one seen (a late commit) is still announced — and a writer clock running ahead blinds no one', async () => {
    const storage = new SqliteStorage(':memory:');
    const j = toJournal(storage);
    const db = (storage as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }).db;
    for (let i = 0; i < 10; i++) await j.put(`run-${i}:model:0`, step(i));
    const w = watchSse(await drive(createStudioApi({ reader: j }))(new Request('http://s/events')));
    try {
      await new Promise((r) => setTimeout(r, 1.5 * POLL_MS));
      await j.put('run-1:model:1', step(1));
      await w.until(() => w.ids().has('run-1'), 3 * POLL_MS);
      expect(w.ids().has('run-1')).toBe(true);
      // A transaction that set its updated_at 3 s ago and commits only now — behind what was seen.
      db.prepare('UPDATE gnl_runs SET model_steps = model_steps + 1, updated_at = ? WHERE run_id = ?').run(Date.now() - 3000, 'run-2');
      await w.until(() => w.ids().has('run-2'), 3 * POLL_MS);
      expect(w.ids().has('run-2'), 'a late commit inside the window was lost').toBe(true);
      // A writer whose clock is ~5 s ahead (just inside the window) and one a minute ahead. The first
      // arrives; the minute-ahead one waits for this clock (delayed — the ceiling keeps a tick from
      // re-reading every future-stamped row).
      const t3 = Date.now();
      db.prepare('UPDATE gnl_runs SET model_steps = model_steps + 1, updated_at = ? WHERE run_id = ?').run(t3 + 4900, 'run-3');
      db.prepare('UPDATE gnl_runs SET model_steps = model_steps + 1, updated_at = ? WHERE run_id = ?').run(t3 + 60_000, 'run-5');
      await w.until(() => w.ids().has('run-3'), 3 * POLL_MS);
      expect(w.ids().has('run-3')).toBe(true);
      // The window still hangs off THIS clock after a row from the future was seen. A late commit
      // stamped 0.4 s before the ahead row's writer started: hung off the ahead row (t3 + 4.9 s) the
      // window starts at t3 − 0.1 s and misses it; hung off this clock it starts ≤ 5 s before the
      // next read, which comes within ~4.1 s of t3 (one tick to see run-3, one more to read this).
      db.prepare('UPDATE gnl_runs SET model_steps = model_steps + 1, updated_at = ? WHERE run_id = ?').run(t3 - 400, 'run-6');
      await w.until(() => w.ids().has('run-6'), 3 * POLL_MS);
      expect(w.ids().has('run-6'), 'a fast clock moved the window past a late commit').toBe(true);
      // And an ordinary write right after is not hidden by anyone's fast clock.
      await j.put('run-4:model:1', step(4));
      await w.until(() => w.ids().has('run-4'), 3 * POLL_MS);
      expect(w.ids().has('run-4'), 'one writer\'s fast clock hid everyone else\'s changes').toBe(true);
      expect(w.ids().has('run-5'), 'a row a minute ahead was read before its time').toBe(false);
      // Announced once each, though run-3 sits in the window every tick until the clock passes it.
      await new Promise((r) => setTimeout(r, 1.5 * POLL_MS));
      const all = w.frames.flatMap((f) => JSON.parse(f.data).runIds as string[]);
      expect(all.filter((id) => id === 'run-3')).toHaveLength(1);
    } finally {
      await w.close();
    }
  }, 40_000);

  it('announces the same runs as the full diff did (a journal without the feed, diffed every tick) — and, as documented, not a deleted one', async () => {
    const j = toJournal(new SqliteStorage(':memory:'));
    for (let i = 0; i < 30; i++) await j.put(`run-${String(i).padStart(2, '0')}:model:0`, step(i));
    await suspend(j, 'wait-1');
    const feed = watchSse(await drive(createStudioApi({ reader: j }))(new Request('http://s/events')));
    const diff = watchSse(await drive(createStudioApi({ reader: without(j, 'listRunsChangedSince'), __fullScanEveryTicks: 1 } as never))(new Request('http://s/events')));
    try {
      await new Promise((r) => setTimeout(r, 1.5 * POLL_MS));
      await j.put('run-04:model:1', step(1)); // an old run's step
      await j.put('run-17:model:1', step(2));
      await j.put('wait-1:tool:call-wait-1', { status: 'succeeded', output: { ok: true } }); // a status flip
      await j.put('run-new:model:0', step(3)); // a new run
      const want = ['run-04', 'run-17', 'run-new', 'wait-1'];
      const has = (s: Set<string>) => want.every((id) => s.has(id));
      await Promise.all([feed.until(() => has(feed.ids()), 4 * POLL_MS), diff.until(() => has(diff.ids()), 4 * POLL_MS)]);
      expect([...feed.ids()].sort()).toEqual(want);
      expect([...diff.ids()].sort()).toEqual(want);
      // The one documented difference: a deleted run's row is gone, so the feed cannot see it go.
      await j.deletePrefix!('run-09:');
      await diff.until(() => diff.ids().has('run-09'), 3 * POLL_MS);
      expect(diff.ids().has('run-09')).toBe(true);
      expect(feed.ids().has('run-09')).toBe(false);
      for (const f of [...feed.frames, ...diff.frames]) expect(f.event).toBe('change');
    } finally {
      await feed.close();
      await diff.close();
    }
  }, 40_000);
});

