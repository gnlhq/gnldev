// k3 — one tool call is (run, model step, tool-call id). Providers may repeat the tool-call id string across
// runs (and across steps of one run): every response's call is `call_0` here. Real OS processes over one
// store, kill -9 inside the tool body (test/k3/proc.ts). Behaviour only: effects counted in a file, what the
// client got through the public doors (REST /run, /stream, the chat surface), the documented operator API.
//
// Every cell runs twice: IDS=same (`call_0` every response — the case under test) and IDS=unique (a fresh
// id per call — the control: it shows each expectation is reachable, and is today's behaviour).
//
//   D1   cross-run: a dead run's half-done call + a new message in the same thread with the same `call_0`
//        → the second effect never happens without a question (effects 1, a question). Both orders:
//        msg-first (the new message reaches the restarted process before it takes the dead run over) and
//        takeover-first (the dead run was taken over and stopped first) — the latter is also item (a).
//   D1'  live: A is inside the body (alive); B in the same thread (confirm approved) with the same id
//        → B is not run beside A without a question.
//   (b)  the dead run's later question: approving it gives no 3rd effect; when another run DID do the same
//        work (a person approved it), the old run's question says so.
//   (c)  a dead marker's question does not say the work "is executing" now; it says it was running when it
//        stopped / may have happened.
//   reg  key-based tools (idempotencyKey thread / cross-run, idempotency:'args' thread) behave as today.
//
// Stores: SQLite always; Postgres with GNL_PG_URL; MongoDB with K3_MONGO_URL (a standalone works:
// mongodb://127.0.0.1:56027/?directConnection=true).
import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROC = join(__dirname, 'k3', 'proc.ts');
const ROOT = join(__dirname, '..', '..', '..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const PG_URL = process.env.GNL_PG_URL;
const MONGO_URL = process.env.K3_MONGO_URL;
const OUT_DIR = process.env.K3_OUT; // optional: keep each cell's logs here
const durableRequire = createRequire(join(ROOT, 'packages', 'durable', 'package.json'));

type Lines = Record<string, any>;
type Res = { code: number | null; out: string; lines: Lines };

function runProc(env: Record<string, string>, opts: { waitFor?: string; timeoutMs?: number } = {}): { done: Promise<Res>; ready: Promise<void> } {
  const child = spawn(TSX, [PROC], { env: { ...process.env, ...env }, cwd: join(__dirname, '..') });
  let out = '';
  let readyRes!: () => void;
  const ready = new Promise<void>((r) => { readyRes = r; });
  const onData = (b: Buffer) => { out += b.toString(); if (opts.waitFor && out.includes(opts.waitFor)) readyRes(); };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 120_000);
  const done = new Promise<Res>((resolve) => child.on('close', (code) => {
    clearTimeout(timer); readyRes();
    const lines: Lines = {};
    for (const l of out.split('\n')) { const m = /^([A-Z_0-9]+) (\{.*\})$/.exec(l); if (m) { try { lines[m[1]] = JSON.parse(m[2]); } catch { /* partial */ } } }
    resolve({ code, out, lines });
  }));
  return { done, ready };
}

// ---- stores ----
const cleanups: Array<() => Promise<void>> = [];
// In parallel and bounded: one unreachable store (a MongoDB that went down) must not keep the others' drops from running.
afterAll(async () => { await Promise.allSettled(cleanups.map((c) => Promise.race([c(), new Promise((r) => setTimeout(r, 20_000))]))); }, 60_000);
let seq = 0;
async function storeEnv(backend: string, dir: string): Promise<Record<string, string>> {
  const name = `k3t_${process.pid}_${Date.now().toString(36)}_${seq++}`;
  if (backend === 'sqlite') return { BACKEND: 'sqlite', DB: join(dir, 'j.db') };
  if (backend === 'pg') {
    const { Client } = durableRequire('pg');
    const admin = new Client({ connectionString: PG_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`); await admin.end();
    cleanups.push(async () => { const a = new Client({ connectionString: PG_URL }); await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end(); });
    const u = new URL(PG_URL!); u.pathname = '/' + name;
    return { BACKEND: 'pg', DB: u.toString() };
  }
  if (backend === 'mongo') {
    cleanups.push(async () => { const { MongoClient } = durableRequire('mongodb'); const c = new MongoClient(MONGO_URL!, { serverSelectionTimeoutMS: 5000 }); await c.connect(); await c.db(name).dropDatabase(); await c.close(); });
    return { BACKEND: 'mongo', DB: MONGO_URL!, MONGO_DB: name };
  }
  throw new Error(backend);
}
const BACKENDS = ['sqlite', ...(PG_URL ? ['pg'] : []), ...(MONGO_URL ? ['mongo'] : [])];

function cellDir(label: string): string {
  if (OUT_DIR) { const d = join(OUT_DIR, `${label.replace(/[^a-z0-9-]+/gi, '_')}-${Date.now()}`); mkdirSync(d, { recursive: true }); return d; }
  return mkdtempSync(join(tmpdir(), 'k3-'));
}

/** crash (kill -9 in the body) → restarted serve process. One cell, memoized so several `it`s read one run. */
const cache = new Map<string, Promise<{ crash: Res; serve: Res }>>();
function crashThenServe(backend: string, cell: Record<string, string>): Promise<{ crash: Res; serve: Res }> {
  const label = `${backend}-${Object.entries(cell).map(([k, v]) => `${k}=${v}`).join('-')}`;
  if (!cache.has(label)) {
    cache.set(label, (async () => {
      const dir = cellDir(label);
      const base = { ...(await storeEnv(backend, dir)), EFFECTS: join(dir, 'eff'), ...cell };
      const crash = await runProc({ ...base, ROLE: 'crash' }).done;
      const serve = await runProc({ ...base, ROLE: 'serve' }).done;
      if (OUT_DIR) { const { writeFileSync } = await import('node:fs'); writeFileSync(join(dir, 'crash.out'), crash.out); writeFileSync(join(dir, 'serve.out'), serve.out); }
      return { crash, serve };
    })());
  }
  return cache.get(label)!;
}

const asked = (r: any) => (r?.interrupts?.length ?? 0) > 0;
const show = (r: any) => JSON.stringify({ status: r?.status, text: r?.text, q: r?.interrupts?.map((i: any) => i.reason.slice(0, 140)), blocked: r?.blocked?.slice(0, 160), effects: r?.effects });
/** The question text a person reads: the interrupt reasons, or a refusal's text (the crash ladder answers 409). */
const questionText = (r: any) => [...(r?.interrupts ?? []).map((i: any) => i.reason), r?.blocked ?? ''].join(' | ');

const DOORS = ['run', 'stream', 'chat'];
const ORDERS = ['msg-first', 'takeover-first'];
const IDS = ['same', 'unique'];

describe.each(BACKENDS)('k3 D1 [%s] — a dead run\'s half-done call and a new message with the same tool-call id', (backend) => {
  for (const door of DOORS) for (const order of ORDERS) for (const ids of IDS) {
    it.concurrent(`${door} · ${order} · ids=${ids}: the new message is asked, the effect happens once`, async () => {
      const { crash, serve } = await crashThenServe(backend, { DOOR: door, ORDER: order, IDS: ids });
      expect(crash.code).not.toBe(0); // killed in the tool body
      expect(serve.lines.BOOT?.effects, 'precondition: the crash process reached the tool body (store up?)').toBe(1);
      const t2 = serve.lines.T2;
      console.log(`[D1 ${backend} ${door} ${order} ${ids}]`, show(t2), 'after', serve.lines.AFTER_T2?.effects);
      expect(serve.lines.AFTER_T2.effects, 'a second effect without a person').toBe(1);
      expect(asked(t2), 'the new message must be asked (the first call may have happened)').toBe(true);
    }, 180_000);
  }
});

describe.each(BACKENDS.filter((b) => b !== 'mongo'))('k3 (c) [%s] — a dead marker\'s question does not say the call is executing now', (backend) => {
  for (const order of ORDERS) for (const ids of IDS) {
    it.concurrent(`run · ${order} · ids=${ids}: "was running when it stopped / may have happened", not "is executing"`, async () => {
      const { serve } = await crashThenServe(backend, { DOOR: 'run', ORDER: order, IDS: ids });
      expect(serve.lines.BOOT?.effects, 'precondition: the crash process reached the tool body').toBe(1);
      const t2 = serve.lines.T2;
      const text = questionText(t2);
      console.log(`[c ${backend} ${order} ${ids}]`, text.slice(0, 260));
      expect(asked(t2), 'a question to read at all').toBe(true);
      expect(text).not.toMatch(/\bis (already |currently |still )?(executing|running|in progress)\b/i);
      expect(text).toMatch(/\b(stopped|crashed|died|interrupted|was running|did not finish|never finished|may|might|could)\b/i);
    }, 180_000);
  }
});

describe.each(BACKENDS.filter((b) => b !== 'mongo'))('k3 (b) [%s] — the dead run\'s later question', (backend) => {
  for (const order of ORDERS) for (const ids of IDS) {
    it.concurrent(`run · ${order} · ids=${ids}: approving the old run's question gives no 3rd effect`, async () => {
      const { serve } = await crashThenServe(backend, { DOOR: 'run', ORDER: order, IDS: ids, OLD_Q: '1', OLD_APPROVE: '1' });
      expect(serve.lines.BOOT?.effects, 'precondition: the crash process reached the tool body').toBe(1);
      console.log(`[b1 ${backend} ${order} ${ids}] t2`, show(serve.lines.T2), '| old', questionText(serve.lines.OLD_Q).slice(0, 200), '| final', JSON.stringify(serve.lines.FINAL?.lines));
      expect(serve.lines.FINAL.effects).toBeLessThanOrEqual(2);
    }, 180_000);
  }
  for (const ids of IDS) {
    it.concurrent(`run · msg-first · ids=${ids}: when another run did the same work, the old run's question says so`, async () => {
      // The new message is approved by a person and pays (a legitimate second effect); then the old run asks.
      const { serve } = await crashThenServe(backend, { DOOR: 'run', ORDER: 'msg-first', IDS: ids, APPROVE_T2: '1', OLD_Q: '1' });
      const t2 = serve.lines.T2_APPROVED ?? serve.lines.T2;
      const old = questionText(serve.lines.OLD_Q);
      console.log(`[b2 ${backend} ${ids}] t2 run ${t2?.runId} effects ${serve.lines.AFTER_T2?.effects} | old question: ${old.slice(0, 300)}`);
      expect(serve.lines.AFTER_T2.effects).toBe(2); // precondition: the other run did the work
      const other = new RegExp(`${String(t2.runId).replace(/[^a-z0-9_]/gi, '.')}|\\b(another|other|different|second|newer|later)\\s+(run|conversation|turn|request|message|call)\\b|başka`, 'i');
      expect(old, 'the old run\'s question names the other run that did the same work').toMatch(other);
    }, 180_000);
  }
});

describe.each(BACKENDS.filter((b) => b !== 'mongo'))('k3 D1\' [%s] — live twin: A inside the body, B (confirm approved) with the same id', (backend) => {
  for (const ids of IDS) {
    it.concurrent(`run · ids=${ids}: B is asked, not run beside the live A`, async () => {
      const dir = cellDir(`live-${backend}-${ids}`);
      const base = { ...(await storeEnv(backend, dir)), EFFECTS: join(dir, 'eff'), DOOR: 'run', IDS: ids };
      const a = runProc({ ...base, ROLE: 'hang', HANG_MS: '8000' }, { waitFor: 'BODY_START' });
      await a.ready;
      const b = await runProc({ ...base, ROLE: 'serve', CONFIRM: '1' }).done;
      const ar = await a.done;
      const bAns = b.lines.T2_APPROVED ?? b.lines.T2;
      console.log(`[D1' ${backend} ${ids}] B confirm q: ${b.lines.T2?.interrupts?.[0]?.reason?.slice(0, 80)} | B after approval: ${show(bAns)} | A: ${ar.lines.T1?.status} ${ar.lines.T1?.text} | final effects ${ar.lines.T1_DONE?.effects}`);
      expect(b.lines.APPROVING_T2, 'precondition: B was asked its confirm question').toBeDefined();
      expect(bAns.effects, 'B ran beside the live A').toBe(1);
      expect(asked(bAns)).toBe(true);
      expect(ar.lines.T1_DONE.effects).toBe(1);
    }, 180_000);
  }
});

describe.each(BACKENDS.filter((b) => b !== 'mongo'))('k3 regression [%s] — key-based tools after a crash behave as today', (backend) => {
  for (const prot of ['key-thread', 'key-cross', 'args-thread']) for (const ids of IDS) {
    it.concurrent(`run · ${prot} · ids=${ids}: the new message is not silently run (effects 1)`, async () => {
      const { serve } = await crashThenServe(backend, { DOOR: 'run', ORDER: 'msg-first', IDS: ids, PROT: prot });
      expect(serve.lines.BOOT?.effects, 'precondition: the crash process reached the tool body').toBe(1);
      const t2 = serve.lines.T2;
      console.log(`[reg ${backend} ${prot} ${ids}]`, show(t2));
      expect(serve.lines.AFTER_T2.effects).toBe(1);
      expect(t2.status >= 400 || asked(t2) || !!t2.blocked, 'refused or asked, not a silent success').toBe(true);
    }, 180_000);
  }
});
