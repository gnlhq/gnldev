// A turn a worker appends to its thread in the moment its run is being erased is taken back by the worker.
//
// The fence (durable's erasure-fence.ts) is read before the turn's messages go into the thread. An erasure
// that lands after that read and before the append — the person's thread deleted, the run fenced — used to
// find the messages written back afterwards: the user's prompt and the answer, with the IBAN, under the
// deleted thread's id. The worker settled its own run away, so `subjectRuns` answered `[]` and a second
// `eraseSubject` deleted 0 rows: nothing named the turn any more (measured on InMemory, Sqlite and Postgres,
// BasicMemory and AgentMemory — c-erasure CE-2).
//
// The rule: a write of a deleted run's worker is the worker's to take back. Every append is named by the
// run's marker (`mem-appended:<runId>`, `mem-user-appended:<runId>`), and the settle that reads the fence
// after the worker's last write retracts those batches (`Memory.retract`).
//
// Siblings: the write-ahead of the user's message (erased before the model is even called), and an
// organization's deletion in the same window (the next tenant of the id reads nothing).
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import {
  InMemoryStorage, BasicMemory, runDurable, eraseSubject, subjectRuns, toJournal, withOrg, withOrgStorage, purgeOrganization, ORG_RECORD_PRE, type Storage,
} from '@gnldev/durable';
import { SqliteStorage } from '../../durable/src/sqlite-storage.js';
import { PostgresStorage } from '../../durable/src/postgres-storage.js';
import { memoryPreset } from '../src/index.js';

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;
const PG_URL = process.env.GNL_PG_URL;
const ends: Array<() => Promise<unknown> | unknown> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });
let admin: pg.Client | undefined;
let seq = 0;

/** A store, and every row it holds as text — every table, every value — to look for what must be gone. */
async function make(kind: string): Promise<{ s: Storage; rows: () => Promise<string[]> }> {
  if (kind === 'InMemory') {
    const s = new InMemoryStorage();
    return {
      s, rows: async () => {
        const out: string[] = [];
        const seen = new WeakSet<object>();
        const walk = (v: unknown, p: string, d: number) => {
          if (d > 12) return;
          if (typeof v === 'string') { out.push(`${p} :: ${v}`); return; }
          if (!v || typeof v !== 'object' || seen.has(v as object)) return;
          seen.add(v as object);
          if (v instanceof Map) { for (const [k, x] of v) { out.push(`${p}{${String(k)}}`); walk(x, `${p}{${String(k)}}`, d + 1); } return; }
          if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${p}[${i}]`, d + 1)); return; }
          for (const k of Object.keys(v as object)) walk((v as any)[k], `${p}.${k}`, d + 1);
        };
        walk(s, 'mem', 0);
        return out;
      },
    };
  }
  if (kind === 'Sqlite') {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-turn-taken-back-'));
    const s = new SqliteStorage(join(dir, 'w.db'));
    ends.push(() => { s.close?.(); rmSync(dir, { recursive: true, force: true }); });
    const db = (s as any).db;
    return {
      s: s as unknown as Storage,
      rows: async () => {
        const out: string[] = [];
        for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) for (const r of db.prepare(`SELECT * FROM ${t.name}`).all()) out.push(`${t.name} :: ${JSON.stringify(r)}`);
        return out;
      },
    };
  }
  if (!admin) { admin = new pg.Client({ connectionString: PG_URL }); await admin.connect(); ends.unshift(() => admin!.end()); }
  const name = `cpc_turn_back_${process.pid}_${Date.now().toString(36)}_${seq++}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(PG_URL!); u.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: u.toString(), max: 4 });
  pool.on('error', () => {});
  const s = new PostgresStorage({ pool });
  await s.init();
  ends.push(async () => { await s.close?.().catch(() => {}); await admin!.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); });
  return {
    s: s as unknown as Storage,
    rows: async () => {
      const out: string[] = [];
      for (const t of (await pool.query('SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()')).rows) {
        for (const r of (await pool.query(`SELECT * FROM ${t.table_name}`)).rows) out.push(`${t.table_name} :: ${JSON.stringify(r)}`);
      }
      return out;
    },
  };
}

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const textModel = (txt: string, onReturn?: () => void): any => ({
  specificationVersion: 'v4', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => { const r = { content: [{ type: 'text', text: txt }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }; onReturn?.(); return r; },
});

/** A memory whose next append (once armed) waits — the worker is between its fence read and its append. */
function holdingMemory<M extends object>(inner: M) {
  let armed = false;
  const reached = gate();
  const release = gate();
  const m = new Proxy(inner, {
    get(t, p) {
      const v = (t as any)[p];
      if ((p === 'append' || p === 'appendOnce') && typeof v === 'function') {
        return async (...a: unknown[]) => {
          if (armed) { armed = false; reached.open(); await release.p; }
          return v.apply(t, a);
        };
      }
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return { m, arm: () => { armed = true; }, reached: reached.p, release: release.open };
}

const KINDS = ['InMemory', 'Sqlite', ...(PG_URL ? ['Postgres'] : [])];
const MEMS = ['BasicMemory', 'AgentMemory'] as const;
const memoryOf = (kind: (typeof MEMS)[number], s: Storage) => (kind === 'BasicMemory' ? new BasicMemory(toJournal(s.runs)) : memoryPreset(s as any, 'chat'));

describe.each(KINDS)('a turn appended as its run is erased — %s', (kind) => {
  for (const memKind of MEMS) {
    it(`${memKind}: erased between the fence read and the append — the worker takes the turn back; nothing of her stays`, async () => {
      const { s, rows } = await make(kind);
      const J = toJournal(s.runs);
      const id = Math.random().toString(36).slice(2, 8);
      const who = `ayse-${id}`, thread = `T-${id}`, secret = `IBAN-SECRET-${id}`;
      const inner: any = memoryOf(memKind, s);
      await runDurable({ runId: `r1-${id}`, journal: J, model: textModel('hello'), memory: inner, prompt: 'first turn', threadId: thread, resourceId: who } as any);
      const h = holdingMemory(inner);
      const run = runDurable({ runId: `r2-${id}`, journal: J, model: textModel(`your IBAN is ${secret}`, h.arm), memory: h.m, prompt: `mine is ${secret}`, threadId: thread, resourceId: who } as any)
        .then((v) => ({ ok: v }), (e: unknown) => ({ err: e }));
      await h.reached;
      await eraseSubject(s, who);
      h.release();
      const out: any = await run;
      expect(out.err?.name).toBe('RunErasedError');
      expect((await rows()).filter((x) => x.includes(secret) || x.includes(who))).toEqual([]);
      expect(await subjectRuns(s, who)).toEqual([]);
      expect((await inner.getMessages(thread)).length).toBe(0);
    }, 120_000);

    it(`${memKind} sibling: erased while the user's message is being written ahead — taken back before the model is called`, async () => {
      const { s, rows } = await make(kind);
      const J = toJournal(s.runs);
      const id = Math.random().toString(36).slice(2, 8);
      const who = `ayse-${id}`, thread = `T-${id}`, secret = `IBAN-SECRET-${id}`;
      const inner: any = memoryOf(memKind, s);
      await runDurable({ runId: `r1-${id}`, journal: J, model: textModel('hello'), memory: inner, prompt: 'first turn', threadId: thread, resourceId: who } as any);
      const h = holdingMemory(inner);
      h.arm(); // the first append of the next turn: BasicMemory's write-ahead of the prompt (AgentMemory appends it with the answer)
      let modelCalls = 0;
      const model = textModel(`your IBAN is ${secret}`, () => { modelCalls++; });
      const run = runDurable({ runId: `r2-${id}`, journal: J, model, memory: h.m, prompt: `mine is ${secret}`, threadId: thread, resourceId: who } as any)
        .then((v) => ({ ok: v }), (e: unknown) => ({ err: e }));
      await h.reached;
      await eraseSubject(s, who);
      h.release();
      const out: any = await run;
      expect(out.err?.name).toBe('RunErasedError');
      if (memKind === 'BasicMemory') expect(modelCalls).toBe(0);
      expect((await rows()).filter((x) => x.includes(secret) || x.includes(who))).toEqual([]);
    }, 120_000);

    it(`${memKind} sibling: the organization is deleted in that window — the next tenant of the id reads nothing`, async () => {
      const { s, rows } = await make(kind);
      const id = Math.random().toString(36).slice(2, 8);
      const who = `ayse-${id}`, thread = `T-${id}`, secret = `IBAN-SECRET-${id}`;
      const org = `acme${id}`;
      await toJournal(s.runs).put(`${ORG_RECORD_PRE}${org}`, { id: org });
      const view = withOrgStorage(s, org);
      // The run's journal through `withOrg`, which says which organization it is in: the worker reads its
      // organization's purge marker through it. (`toJournal(withOrgStorage(…).runs)` does not say so —
      // reported separately, not this file's to change.)
      const J = withOrg(toJournal(s.runs), org);
      const inner: any = memKind === 'BasicMemory' ? new BasicMemory(J) : memoryPreset(view as any, 'chat');
      const h = holdingMemory(inner);
      const run = runDurable({ runId: `r-${id}`, journal: J, model: textModel(`your IBAN is ${secret}`, h.arm), memory: h.m, prompt: `mine is ${secret}`, threadId: thread, resourceId: who } as any)
        .then((v) => ({ ok: v }), (e: unknown) => ({ err: e }));
      await h.reached;
      await purgeOrganization(s, org);
      h.release();
      const out: any = await run;
      expect(out.err?.name).toBe('RunErasedError');
      expect((await rows()).filter((x) => x.includes(secret) || x.includes(who))).toEqual([]);
      // Nothing of the run in the purged partition — no fence either. Stated remainders: the counters the
      // worker incremented (aggregates, no content) and a journal log emptied by the retraction.
      const left = (await toJournal(s.runs).listKeys!(`org:${org}:`)).filter((k) => !/:(__usage__|__metrics__:)/.test(k));
      for (const k of left) expect(k === `org:${org}:mem:${thread}:messages` && JSON.stringify(await toJournal(s.runs).get(k)).includes('"parts":[]')).toBe(true);
      await toJournal(s.runs).put(`${ORG_RECORD_PRE}${org}`, { id: org });
      const next: any = memKind === 'BasicMemory' ? new BasicMemory(withOrg(toJournal(s.runs), org)) : memoryPreset(withOrgStorage(s, org) as any, 'chat');
      expect((await next.getMessages(thread)).length).toBe(0);
    }, 120_000);
  }
});
