// An erased record is not written back by a call that was answered by it.
//
// A call answered by an existing record (a repeat inside the window) adds its toolCallId to the
// record's `resolvedToolCallIds`. That was a read-modify-PUT of the copy read earlier, so a record
// deleted in between came back whole. The erasure order — cancel, wait until `subjectRuns` says nothing
// of the person is in flight, erase — does not stop it: an answered call holds no claim, so a canceled
// run whose worker is inside one reads as not in flight. Measured: the person's arguments back on disk
// under `xthr:<thread>:` (and `xreq:<run>:`) after `eraseSubject`, under a thread no later erasure can
// find. The id is now added by compare-and-set over the record as it stands; a record that is gone
// stays gone.
//
// The same worker's MIRROR under its own run, and what the canceled worker writes once the erasure has
// also taken its cancel flag: a-an-erased-run-stays-erased.test.ts (the erasure fence).
//
// Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryStorage, cancelAgentRun, eraseSubject, subjectRuns, toJournal, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { runDurable } from '../src/run.js';
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

/**
 * The journal, with one read held open after it returned — the moment a worker has read the record —
 * and a worker that dies at its next model step once released: what it writes in between is exactly
 * the answered call's own writes.
 */
function holdingJournal(inner: Journal) {
  let armed: ((k: string) => boolean) | undefined;
  let released = false;
  const reached = gate();
  const release = gate();
  const died = gate();
  const deadAt = (k: string) => released && (k.includes(':model:') || k.includes(':proc:__gnl_model_claim:'));
  const journal = new Proxy(inner, {
    get(t, p) {
      const v = (t as any)[p];
      if (p === 'get') {
        return async (k: string) => {
          const out = await (t as any).get(k);
          if (armed && armed(k)) { armed = undefined; reached.open(); await release.p; released = true; }
          return out;
        };
      }
      if (p === 'put' || p === 'putIfAbsent' || p === 'putIfMatch') {
        return async (k: string, ...rest: unknown[]) => {
          if (deadAt(k)) { died.open(); return new Promise(() => {}); } // the process is gone
          return (t as any)[p](k, ...rest);
        };
      }
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return { journal, arm: (m: (k: string) => boolean) => { armed = m; }, reached: reached.p, release: release.open, died: died.p };
}

/** Every key whose key or value names the secret. */
async function holding(journal: Journal, secret: string): Promise<string[]> {
  const out: string[] = [];
  for (const k of await journal.listKeys!('')) if (k.includes(secret) || JSON.stringify(await journal.get(k) ?? null).includes(secret)) out.push(k);
  return out.sort();
}

describe.each(STORES)('an erased record stays erased — %s', (_name, make) => {
  for (const window of ['thread', 'run'] as const) {
    it(`a repeat answered by a ${window}-window record does not write the erased record back`, async () => {
      const storage = await make();
      const root = toJournal(storage.runs);
      const id = unique();
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
      // Step 0 pays, step 1 pays the same again (the repeat), step 2 ends.
      let onRepeat: (() => void) | undefined;
      const model = (pre: string) => createMockModel(async ({ prompt }: any) => {
        const n = countToolResults(prompt);
        if (n === 1) onRepeat?.();
        return n < 2 ? toolCallResult('pay', `${pre}-${n}`, { iban: secret }) : finalTextResult('done');
      });
      const run = (runId: string, journal: Journal, pre: string) => runDurable({
        runId, journal, model: model(pre), tools, prompt: `pay ${secret}`, threadId: thread, resourceId: who, stopWhen: stepCountIs(5),
      } as any);

      // A run of hers that finished: on the thread window it leaves the record the next run is answered by.
      if (window === 'thread') await run(`r1-${id}`, root, 'a');
      const before = executions;

      // Her second run: its worker is answered by the record and has just read it.
      const h = holdingJournal(root);
      // The record's key: the thread's window, or the request's (`xreq:<run>:args-…`).
      const recordKey = (k: string) => k.startsWith(window === 'thread' ? `xthr:${thread}:args-` : `xreq:r2-${id}:args-`)
        && !k.includes(':dup') && !k.includes(':sem') && !k.includes(':owner');
      // On the thread window every call of this run is a repeat; on the run window the first call
      // executes, and the repeat is the next model step's call.
      if (window === 'thread') h.arm(recordKey); else onRepeat = () => { onRepeat = undefined; h.arm(recordKey); };
      const r2 = run(`r2-${id}`, h.journal, 'b').then((v) => v, (e) => e);
      await h.reached;

      // The documented order: cancel, see nothing in flight, erase.
      await cancelAgentRun(root, `r2-${id}`);
      const runs = await subjectRuns(storage, who);
      expect(runs.length).toBeGreaterThan(0);
      expect(runs.filter((r) => r.inFlight)).toEqual([]);
      await eraseSubject(storage, who);
      expect(await holding(root, secret)).toEqual([]);

      // The worker goes on, up to its next model step.
      // Since the erasure fence (a-an-erased-run-stays-erased.test.ts) it stops BEFORE that step's
      // first write, so it may never reach the point this journal models its death at: whichever comes first.
      h.release();
      await Promise.race([h.died, r2]);
      expect(executions).toBe(window === 'thread' ? before : 1);
      // The record the call was answered by is not written back.
      expect(await root.listKeys!(window === 'thread' ? `xthr:${thread}:` : `xreq:r2-${id}:`)).toEqual([]);
    });
  }
}, 60_000);
