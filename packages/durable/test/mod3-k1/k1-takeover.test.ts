// mod3 k1 — "a process bound to a store runs one recovery loop over every organization, whether or not a
// request ever reached it". Two real processes on one real database (a schema / database / file per scenario):
//   T1 (A6)        A executes a run and is SIGKILLed; B was built and served nothing.   [every store]
//   T2 (A6 org)    A executes a run in org Y and is SIGKILLed; B serves one request in org X only.
//   T3 (drain)     A executes a run and drains (releases it); B was built and served nothing.
//   T4 (door)      B is a createRestApi server, built and never called.
// T0, T2, T3, T4 run on Postgres; T1 runs on Sqlite, libSQL, Postgres, MySQL and MongoDB.
//   T1d (MongoDB)  A is killed inside the transaction of its tool call's claim.
// Pass: B continues the run — its execution record is held by someone other than A (running) or has been
// given back by B (parked) — within 15 s, and B reaches the ending that is right for where A died
// (`expectRightEnding`): the tool's body ran exactly once, or nobody can tell and a human is asked.
// K1_START=1: the B process calls `start()` on its root registry when the registry has one.
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kinds, freshDatabase, openStore, type Conn, type Kind } from './stores.js';
import { distMods } from './dist-mods.js';
import { createGnl, mintCallId } from '@gnldev/durable';
import { streamingModel } from '../detached/models.js';
import { tool } from 'ai';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const tsxLoader = join(dirname(require_.resolve('tsx/package.json')), 'dist', 'loader.mjs');
const START = process.env.K1_START === '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ends: Array<() => unknown> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); }, 120_000);

function proc(cfg: object): ChildProcess {
  const file = (cfg as any).server ? join(here, '..', '..', '..', 'server', 'test', 'mod3-k1', 'k1-server-node.ts') : join(here, 'fixtures', 'k1-node.ts');
  const p = spawn(process.execPath, ['--import', tsxLoader, file, JSON.stringify(cfg)], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr!.on('data', (d) => { err += String(d); });
  ends.push(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } });
  (p as any).err = () => err;
  return p;
}
const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
async function waitFile(f: string, ms = 20_000) {
  for (let i = 0; i < ms / 50; i++) { if (existsSync(f)) return; await sleep(50); }
  throw new Error(`timeout waiting for ${f}`);
}

/** Ms from `t0` until B's log shows the run's record held by someone other than A, or given back by B (parked); -1: never. */
async function takenOverWithin(dir: string, runId: string, aOwner: string, t0: number, ms: number): Promise<number> {
  for (let i = 0; i < ms / 100; i++) {
    const lines = read(join(dir, 'B.log')).trim().split('\n').filter((l) => l.includes(' exec ') && l.includes(runId));
    for (const l of lines) {
      const [at, , , status, owner] = l.split(' ');
      if (Number(at) >= t0 && owner !== aOwner && (status === 'running' || status === 'parked')) return Number(at) - t0;
    }
    await sleep(100);
  }
  return -1;
}

const SCENARIOS = [
  { name: 'T0 control: B served one root request', kinds: ['postgres'], a: {}, b: { trigger: true } },
  { name: 'T1 A6: B served nothing', kinds: ['sqlite', 'libsql', 'postgres', 'mysql', 'mongo'], a: {}, b: {} },
  { name: 'T2 A6-org: run in org Y, B served one request in org X', kinds: ['postgres'], a: { org: 'orgY' }, b: { orgReq: 'orgX', trigger: true } },
  { name: 'T3 drain: A drains, B served nothing', kinds: ['postgres'], a: { drain: true }, b: {} },
  { name: 'T4 door: B is a createRestApi server that served nothing', kinds: ['postgres'], a: {}, b: { server: true } },
] as const;

/** The run's `outcome` records, in whichever organization's keys the run lives. */
async function outcomes(conn: Conn, runId: string): Promise<Array<[string, string]>> {
  const storage = openStore(distMods, conn);
  try {
    const keys = (await storage.runs.listKeys('')).filter((k: string) => k.endsWith(`${runId}:outcome`));
    return await Promise.all(keys.map(async (k: string) => [k, JSON.stringify(await storage.runs.get(k))] as [string, string]));
  } finally { await storage.close(); }
}

/** B's decision: the run's `outcome` row once it says `completed` or B has parked the run; 20 s to reach either. */
async function bDecided(conn: Conn, dir: string, runId: string): Promise<Array<[string, string]>> {
  let rows: Array<[string, string]> = [];
  for (let i = 0; i < 200; i++) {
    rows = await outcomes(conn, runId);
    if (rows.some(([, v]) => v.includes('"completed"')) || lastExec(dir, runId) === 'parked') break;
    await sleep(100);
  }
  return rows;
}
const lastExec = (dir: string, runId: string) => read(join(dir, 'B.log')).trim().split('\n').filter((l) => l.includes(' exec ') && l.includes(runId)).pop()?.split(' ')[3];

/**
 * THE ENDING THAT IS RIGHT FOR WHERE A DIED, as T1b's, read from what the run left (the kill moment is not
 * controlled). `effects` is every body that started, in either process:
 *   - completed: the body ran exactly once — B's, or A's when A settled the call before it died;
 *   - not completed: B gave the record back because the call is in doubt — the claim is A's and still
 *     `running`, the ending asks a human (side_effect_retry_blocked), and B ran no body.
 * Nothing else passes: a record B holds and never moves, a failure, a body run twice.
 */
async function expectRightEnding(conn: Conn, dir: string, runId: string, aOwner: string, name: string, rows: Array<[string, string]>) {
  const storage = openStore(distMods, conn);
  try {
    const prefix = rows[0]![0].slice(0, -`${runId}:outcome`.length);
    const claim: any = await storage.runs.get(`${prefix}${runId}:tool:${mintCallId('call-1', runId, 0, 0)}`);
    const completed = rows.some(([, v]) => v.includes('"completed"'));
    // The outcome row is written a moment before the run's last status event.
    let ending = await lastStatus(storage, `${prefix}${runId}`);
    for (let i = 0; completed && ending?.state !== 'completed' && i < 50; i++) { await sleep(100); ending = await lastStatus(storage, `${prefix}${runId}`); }
    const effects = read(join(dir, 'effects')).trim().split('\n').filter(Boolean);
    console.log(`[k1] ${name}: completed=${completed} last exec=${lastExec(dir, runId)} claim=${claim?.status} ending=${ending?.state} code=${ending?.error?.code} effects=${JSON.stringify(effects)}`);
    if (completed) {
      expect(claim?.status).toBe('succeeded');
      expect(ending?.state).toBe('completed');
      expect(effects.length).toBe(1);
    } else {
      expect(lastExec(dir, runId)).toBe('parked');
      expect(claim?.status).toBe('running');
      expect(claim?.proc).toBe(aOwner);
      expect(ending?.state).toBe('waiting-approval');
      expect(ending?.error?.code).toBe('side_effect_retry_blocked');
      expect(effects.filter((l) => l === 'effect B')).toEqual([]);
    }
  } finally { await storage.close(); }
}

for (const kind of kinds()) {
  describe(`k1 takeover by a process no request reached — ${kind}`, () => {
    for (const sc of SCENARIOS.filter((x) => (x.kinds as readonly Kind[]).includes(kind))) {
      it(sc.name, async () => {
        const fresh = await freshDatabase(kind, 'takeover');
        ends.push(() => fresh.dispose());
        const conn = fresh.conn;
        const dir = mkdtempSync(join(tmpdir(), 'k1t-'));
        const runId = `k1-${Math.random().toString(36).slice(2, 8)}`;
        // B first (built, idle), so the A run is born while B already exists.
        const B = proc({ role: 'B', conn, runId, dir, start: START, ...sc.b });
        await waitFile(join(dir, 'B.pid'));
        await sleep(1500);
        const A = proc({ role: 'A', conn, runId, dir, ...sc.a });
        await waitFile(join(dir, 'a.owner'));
        const aOwner = read(join(dir, 'a.owner'));
        if ((sc.b as any).trigger) writeFileSync(join(dir, 'trigger'), '1');
        const t0 = Date.now();
        if ((sc.a as any).drain) writeFileSync(join(dir, 'drain'), '1');
        else A.kill('SIGKILL');
        const ms = await takenOverWithin(dir, runId, aOwner, t0, 15_000);
        console.log(`[k1] ${kind} ${sc.name}: taken over after ${ms} ms (start=${START}) dir=${dir}\n  B.err=${(B as any).err().slice(0, 300)}\n  A.err=${(A as any).err().slice(0, 300)}`);
        expect(ms).toBeGreaterThanOrEqual(0);
        // The run is continued by B: to its end, in its own organization's keys (never the root's) — or, when A
        // died inside a tool call whose result nobody can tell, given back by B (parked: the call is in doubt,
        // and only an answer can move it). Either way B decided; a record B holds and never moves fails here.
        const rows = await bDecided(conn, dir, runId);
        expect(rows.length).toBe(1);
        await expectRightEnding(conn, dir, runId, aOwner, `${kind} ${sc.name}`, rows);
        if ((sc.a as any).org) expect(rows[0]![0].startsWith(`org:${(sc.a as any).org}:`) || rows[0]![0].includes(`${(sc.a as any).org}`)).toBe(true);
      }, 90_000);
    }
  });
}

// T1d: A's kill is placed. A is killed inside the transaction of its claim, the run's document written and
// nothing committed. The server keeps that transaction open with no connection under it, up to its lifetime
// (60 s, measured 72–84 s until a write got through), and every write on those documents conflicts with it:
// B took the run over and stood at its tool call, then failed the claim at the store's 60 s budget.
// The claim was never committed, so nothing ran: B runs the body, once, and completes — within the window.
describe.skipIf(!kinds().includes('mongo'))('k1 takeover of a process killed inside a transaction — mongo', () => {
  it('T1d: B is not held by the transaction A left open', async () => {
    // A database of its own: T1's B, alive to the end of this file, sweeps the one T1 ran on.
    const fresh = await freshDatabase('mongo', 'takeoverTx');
    ends.push(() => fresh.dispose());
    const conn = fresh.conn;
    const dir = mkdtempSync(join(tmpdir(), 'k1t-'));
    const runId = `k1-${Math.random().toString(36).slice(2, 8)}`;
    const B = proc({ role: 'B', conn, runId, dir });
    await waitFile(join(dir, 'B.pid'));
    await sleep(1500);
    const A = proc({ role: 'A', conn, runId, dir, dieInClaim: true });
    await waitFile(join(dir, 'a.owner'));
    const aOwner = read(join(dir, 'a.owner'));
    for (let i = 0; i < 400 && A.exitCode === null && A.signalCode === null; i++) await sleep(50);
    expect(A.signalCode).toBe('SIGKILL');
    const rows = await bDecided(conn, dir, runId);
    console.log(`[k1] T1d: outcome ${JSON.stringify(rows.map(([, v]) => v))} B.err=${(B as any).err().slice(-300)}`);
    expect(rows.length).toBe(1);
    expect(rows[0]![1]).toContain('"completed"');
    await expectRightEnding(conn, dir, runId, aOwner, 'mongo T1d', rows);
    expect(read(join(dir, 'effects')).trim()).toBe('effect B');
  }, 120_000);
});

// T1 in one process (Sqlite): B is THIS process — a registry built on the file and never called, in the test's
// own process — and A, the only child, is killed mid-run.
//
// WHERE A DIES DECIDES WHICH ENDING IS RIGHT, and the kill moment is not controlled: A reports its owner as soon
// as its execution record is `running`, and its tool (1.5 s in A) may or may not have claimed its call by then.
//   - killed before the tool's claim → B runs the whole run itself → `completed`.
//   - killed inside the tool (its claim `running`, naming A) → nobody can tell whether the side effect happened;
//     B, the crash ladder's reader, must NOT run it again: it parks the run for a human
//     (`waiting-approval`, side_effect_retry_blocked on that call). Expecting `completed` there would be
//     expecting the tool to run twice.
// Measured before this predicate (10 runs, Sqlite): 5 red, every red the second case — record parked by B,
// ending side_effect_retry_blocked on call-1 whose claim named A. T1c pins the second case deterministically.
const evKeys = async (storage: any, runId: string) => ((await storage.runs.listKeys(`${runId}:ev:`)) as string[]).sort();
async function lastStatus(storage: any, runId: string): Promise<any> {
  const keys = await evKeys(storage, runId);
  for (let i = keys.length - 1; i >= 0; i--) { const ev: any = await storage.runs.get(keys[i]!); if (ev?.kind === 'status') return ev.data; }
  return undefined;
}

/** A in a child, B = a registry in this process; A is killed when `killWhen` says so. What B decided. */
async function oneProcessTakeover(killWhen: (storage: any, runId: string, aOwner: string) => Promise<boolean>) {
  const fresh = await freshDatabase('sqlite', 'takeover');
  ends.push(() => fresh.dispose());
  const conn = fresh.conn;
  const dir = mkdtempSync(join(tmpdir(), 'k1t-'));
  const runId = `k1-${Math.random().toString(36).slice(2, 8)}`;
  const storage = openStore(distMods, conn);
  ends.push(() => storage.close());
  let bRan = 0;
  const slow = tool({ description: 'slow', inputSchema: z.object({ n: z.number() }), execute: async () => { bRan++; return 'ok'; } }) as any;
  const model = streamingModel({ words: Array.from({ length: 20 }, (_, i) => `w${i} `), gapMs: 50, tool: { name: 'slow', input: { n: 1 } } });
  createGnl({ storage, agents: { a: { model, tools: { slow } } }, detached: { sweepMs: 300, pollMs: 100 } } as any);
  await sleep(1500);
  const A = proc({ role: 'A', conn, runId, dir });
  await waitFile(join(dir, 'a.owner'));
  const aOwner = read(join(dir, 'a.owner'));
  for (let i = 0; i < 100 && !(await killWhen(storage, runId, aOwner)); i++) await sleep(20);
  // The call's claim as A left it: `running` and naming A means A died inside the tool.
  A.kill('SIGKILL');
  await sleep(50);
  const claim: any = await storage.runs.get(`${runId}:tool:${mintCallId('call-1', runId, 0, 0)}`);
  const diedInTool = claim?.status === 'running' && claim?.proc === aOwner;
  let heldByOther = false;
  let exec: any;
  let outcome: any;
  for (let i = 0; i < 200; i++) {
    for (const k of await storage.runs.listKeys('__exec__')) {
      const rec: any = await storage.runs.get(k);
      if (k.includes(runId)) exec = rec;
      if (k.includes(runId) && rec?.owner !== aOwner && (rec?.status === 'running' || rec?.status === 'parked')) heldByOther = true;
    }
    const rows = (await storage.runs.listKeys('')).filter((k: string) => k.endsWith(`${runId}:outcome`));
    expect(rows.length).toBeLessThanOrEqual(1);
    outcome = rows[0] ? await storage.runs.get(rows[0]) : undefined;
    if (outcome?.status === 'completed') break;
    if (exec?.status === 'parked' && exec.owner !== aOwner) break;
    await sleep(100);
  }
  // A's body counted where it ran: the claim read above may already be B's, when the read comes late.
  const aRan = read(join(dir, 'effects')).split('\n').filter(Boolean).length;
  return { aOwner, claim: claim?.status as string | undefined, diedInTool, heldByOther, exec, outcome, ending: await lastStatus(storage, runId), aRan, bRan };
}

describe.skipIf(!kinds().includes('sqlite'))('k1 takeover by this very process — sqlite', () => {
  it('T1b A6: a registry built here and never called continues the run of a killed process', async () => {
    const r = await oneProcessTakeover(async () => true);
    console.log(`[k1] T1b: claim=${r.claim} diedInTool=${r.diedInTool} exec=${r.exec?.status ?? 'gone'} outcome=${r.outcome?.status} ending=${r.ending?.state} aRan=${r.aRan} bRan=${r.bRan}`);
    expect(r.heldByOther).toBe(true);
    if (!r.diedInTool) {
      // No claim yet: B runs the tool. A claim A settled before dying: B replays it. Either way, once.
      expect(r.outcome?.status).toBe('completed');
      expect(r.aRan + r.bRan).toBe(1);
    } else {
      expect(r.exec?.status).toBe('parked');
      expect(r.exec?.owner).not.toBe(r.aOwner);
      expect(r.ending?.state).toBe('waiting-approval');
      expect(r.ending?.error?.code).toBe('side_effect_retry_blocked');
      expect(r.bRan).toBe(0);
    }
  }, 90_000);

  it('T1c A6: A killed INSIDE its tool — B takes the run over and parks it for a human, never runs the tool again', async () => {
    const r = await oneProcessTakeover(async (storage, runId, aOwner) => {
      const c: any = await storage.runs.get(`${runId}:tool:${mintCallId('call-1', runId, 0, 0)}`);
      return c?.status === 'running' && c?.proc === aOwner;
    });
    expect(r.diedInTool).toBe(true);
    expect(r.heldByOther).toBe(true);
    expect(r.exec?.status).toBe('parked');
    expect(r.exec?.owner).not.toBe(r.aOwner);
    expect(r.ending?.state).toBe('waiting-approval');
    expect(r.ending?.error?.code).toBe('side_effect_retry_blocked');
    expect(r.outcome?.status).not.toBe('completed');
    expect(r.bRan).toBe(0);
  }, 90_000);
});
