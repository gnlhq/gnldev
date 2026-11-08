// THE DATABASE STOPS ANSWERING A HEALTHY PROCESS for a few seconds (a stalled network, a swamped server):
// its liveness proof goes unanswered, its session counts as lost and LivenessUnavailableError comes into
// play. Three app processes (test/fixtures/detached-node.ts) on one Postgres, each behind its own
// FreezeProxy (test/detached/freeze-proxy.ts), so the database stops answering process A alone.
//
// What must hold, whatever the moment: the run is never `completed` without its tool call, the body runs at
// most once, and the run ends — completed, or parked for a person when a body that started was stopped.
// The freeze is proven, not assumed: A's proxy must have held bytes while frozen.
//
// Measured over 10 trials per moment (framework-s0/liveness-audit); here one trial each, the moments
// whose path is deterministic. Runs only with GNL_PG_URL.
import { describe, it, expect, afterEach } from 'vitest';
import { newStore, startNode, post, sleep, linesOf, stopNode, PG_BASE, type Node, type Store } from './detached/harness.js';
import { FreezeProxy } from './detached/freeze-proxy.js';
import { helperPool } from '../../../test/support/pg-admin.js';
import { derivedRunId } from '../src/index.js';

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

interface Trial {
  /** When A's database stops answering. */
  moment: 'pre-body' | 'body' | 'ending';
  freezeMs: number;
  /** The server gives up on A's liveness session this long into the freeze (its lock goes; the others may take over). */
  dropLivenessMs?: number;
  /** Every process's database stops (the server itself), and the server drops EVERY session this long into it (a restart, a failover). */
  everyoneDropMs?: number;
  /** The pool thaws first and the liveness session this much later: A's session is certainly still gone when its claim is answered. */
  livenessLagMs?: number;
  env?: Record<string, string>;
  /** After the run settles, the user sends the same request again as a NEW run, to this process (0 = A, 1 = B). */
  retryOn?: number;
  /** The request names WORK (a workKey): the run's id is derived (`run1_`), as on an authenticated chat (d25 U6). */
  workKey?: boolean;
}

async function trial(t: Trial) {
  const s: Store = newStore('postgres', 'luperm');
  const up = new URL(PG_BASE!);
  const proxies = ['A', 'B', 'C'].map((n) => new FreezeProxy({ host: up.hostname, port: Number(up.port || 5432) }, n));
  const nodes: Node[] = [];
  cleanups.push(async () => { await Promise.all(nodes.map(stopNode)); await Promise.all(proxies.map((p) => p.close().catch(() => undefined))); s.drop(); });
  await Promise.all(proxies.map((p) => p.start()));
  // What the request names, and the run's id (the same string unless it names work).
  const named = `lup-${Date.now().toString(36)}`;
  const idOf = (n: string) => (t.workKey ? derivedRunId('agent:fixture', 'resource', 'alice', n) : n);
  const runId = idOf(named);
  const againId = idOf(`${named}-again`); // the retry's run (retryOn); a derived id does not contain the first one's
  const env = { DN_TOOL_MS: t.moment === 'body' ? '3000' : '200', DN_WORDS: 'done', DN_SWEEP_MS: '300', DN_DEADLINE_MS: '90000', ...(t.workKey ? { DN_WORKKEY: '1' } : {}), ...(t.env ?? {}) };
  for (const p of proxies) nodes.push(await startNode({ ...s, where: p.urlFor(s.where) }, env));
  // Every process warm (its store booted) before the run: a boot during the freeze would queue DDL behind A's open transaction.
  for (const n of nodes) { const end = Date.now() + 15_000; while (Date.now() < end && !((await (await fetch(n.url('/stats'))).json()).store > 0)) await sleep(50); }
  const pa = proxies[0]!;
  const who = (pid: number) => ['A', 'B', 'C'][nodes.findIndex((n) => n.pid === pid)] ?? String(pid);
  let once = false;
  if (t.moment === 'pre-body') pa.onClientData((c) => (!once && c.includes(`${runId}:tool:`) && c.includes('"status":"running"') ? ((once = true), 'freeze-after') : undefined));
  if (t.moment === 'ending') pa.onClientData((c) => (!once && !c.includes(':tool:') && (c.includes('"state":"completed"') || (c.includes(`${runId}:outcome`) && c.includes('"status":"completed"'))) ? ((once = true), 'freeze-before') : undefined));
  const res = await post(nodes[0]!, '/start', { runId: named });
  expect(res.status).toBe(202);
  if (t.moment === 'body') { while (!linesOf(`${s.effects}.started`).length) await sleep(2); pa.freeze('all', 'inside body'); }
  for (let i = 0; i < 2000 && !pa.frozen; i++) await sleep(5);
  expect(pa.frozen, 'the moment came: A was frozen').toBe('all');
  if (t.everyoneDropMs !== undefined) {
    for (const p of proxies.slice(1)) p.freeze('all', 'with A');
    await sleep(t.everyoneDropMs); for (const p of proxies) p.dropServer(); await sleep(t.freezeMs - t.everyoneDropMs);
  } else if (t.dropLivenessMs !== undefined) { await sleep(t.dropLivenessMs); pa.dropServer('liveness'); await sleep(t.freezeMs - t.dropLivenessMs); }
  else await sleep(t.freezeMs);
  const held = pa.heldBytes;
  if (t.livenessLagMs) { pa.thawAllButLiveness(); await sleep(t.livenessLagMs); }
  for (const p of proxies) p.thaw();
  // Until the run ends (its completion hook) or parks; then long enough for a late duplicate to show.
  const rows = async () => {
    const pool = helperPool(s.where);
    try { return (await pool.query(`SELECT key, value FROM gnl_run_journal WHERE position($1 in key) > 0 OR position($2 in key) > 0`, [runId, againId])).rows.map((r: any) => [r.key, JSON.parse(r.value).json]) as Array<[string, any]>; }
    finally { await pool.end(); }
  };
  const end = Date.now() + 30_000;
  let r: Array<[string, any]> = [];
  while (Date.now() < end) {
    r = await rows();
    const exec = r.find(([k]) => k.startsWith('__exec__'))?.[1];
    // Parked for a person ends the wait; parked on a call another attempt holds (`awaits`) is continued by a sweep.
    if (linesOf(`${s.effects}.hooks`).length || (exec?.status === 'parked' && !exec.awaits)) break;
    await sleep(200);
  }
  await sleep(2500);
  r = await rows();
  const events = r.filter(([k]) => k.includes(`${runId}:ev:`)).map(([, v]) => v).sort((a, b) => a.seq - b.seq);
  const tool = r.find(([k]) => k.includes(`${runId}:tool:`))?.[1];
  const statuses = r.filter(([k]) => k.includes(`${runId}:ev:`)).map(([, v]) => v).sort((a, b) => a.seq - b.seq).filter((e) => e.kind === 'status').map((e) => e.data.state);
  const exec = r.find(([k]) => k.startsWith('__exec__'))?.[1];
  const out = {
    held,
    statuses,
    last: statuses.at(-1),
    exec: exec?.status,
    tool: tool?.status,
    toolErrors: events.filter((e) => e.kind === 'tool-error').map((e) => String(e.data?.error?.message ?? '').slice(0, 80)),
    hooks: linesOf(`${s.effects}.hooks`).map((l) => l.split(' ')[2]),
    bodies: linesOf(`${s.effects}.started`).map((l) => who(Number(l.split(' ')[0]))),
    effects: linesOf(s.effects).map((l) => who(Number(l.split(' ')[0]))),
    stderr: nodes.map((n) => n.stderr().slice(-800)),
  };
  let second: { ended: boolean; statuses: string[]; last?: string; exec?: string; toolErrors: string[]; effects: number; bodies: number } | undefined;
  if (t.retryOn !== undefined) {
    const run2 = againId;
    const res2 = await post(nodes[t.retryOn]!, '/start', { runId: `${named}-again` });
    expect(res2.status).toBe(202);
    // Ended: completed or failed (its hook), or parked for a person. Not ended within 30 s: it hangs.
    let ended = false;
    let ev2: any[] = [];
    let exec2: any;
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      const r2 = await rows();
      ev2 = r2.filter(([k]) => k.includes(`${run2}:ev:`)).map(([, v]) => v).sort((a, b) => a.seq - b.seq);
      exec2 = r2.find(([k]) => k.startsWith('__exec__') && k.includes(run2))?.[1];
      if (linesOf(`${s.effects}.hooks`).some((l) => l.includes(run2)) || (exec2?.status === 'parked' && !exec2.awaits)) { ended = true; break; }
      await sleep(250);
    }
    await sleep(1500);
    const st2 = ev2.filter((e) => e.kind === 'status').map((e) => e.data.state);
    second = { ended, statuses: st2, last: st2.at(-1), exec: exec2?.status, toolErrors: ev2.filter((e) => e.kind === 'tool-error').map((e) => String(e.data?.error?.message ?? '').slice(0, 80)), effects: linesOf(s.effects).length, bodies: linesOf(`${s.effects}.started`).length };
  }
  console.log(`[liveness-unavailable ${t.moment}${t.dropLivenessMs !== undefined ? ' drop' : ''}${t.retryOn !== undefined ? ` retry-on-${t.retryOn}` : ''}${t.workKey ? ' workKey' : ''}] ${JSON.stringify({ ...out, stderr: undefined, second })}`);
  return { ...out, second };
}

describe.skipIf(!PG_BASE)('the database stops answering a healthy process (Postgres, 3 processes)', () => {
  it('claimed, body not started: A is refused (LivenessUnavailableError), the run is released and completes once', { timeout: 90_000 }, async () => {
    const o = await trial({ moment: 'pre-body', freezeMs: 6000, livenessLagMs: 1000 });
    expect(o.held, 'the database really stopped answering A').toBeGreaterThan(0);
    expect(o.statuses.filter((x) => x === 'running').length, 'A released its execution: the run was continued').toBe(2);
    expect(o.last).toBe('completed');
    expect(o.hooks).toEqual(['completed']);
    expect(o.bodies.length, 'the body ran once').toBe(1);
    expect(o.effects.length).toBe(1);
  });

  it('inside a body that rethrows its stop: the run is not completed, it waits for a person; the body ran once', { timeout: 90_000 }, async () => {
    const o = await trial({ moment: 'body', freezeMs: 6000, env: { DN_HONOR: 'reason' } });
    expect(o.held).toBeGreaterThan(0);
    expect(o.statuses).not.toContain('completed');
    expect(o.exec).toBe('parked');
    expect(o.last).toBe('waiting-approval');
    expect(o.bodies.length).toBe(1);
    expect(o.effects.length, 'stopped before its effect').toBe(0);
  });

  it('inside a body that ignores its stop: it finishes, the run completes on A, the body ran once', { timeout: 90_000 }, async () => {
    const o = await trial({ moment: 'body', freezeMs: 6000 });
    expect(o.held).toBeGreaterThan(0);
    expect(o.last).toBe('completed');
    expect(o.bodies).toEqual(['A']);
    expect(o.effects).toEqual(['A']);
  });

  it('the run\'s ending write held: it lands after the thaw, completed once', { timeout: 90_000 }, async () => {
    const o = await trial({ moment: 'ending', freezeMs: 6000 });
    expect(o.held).toBeGreaterThan(0);
    expect(o.last).toBe('completed');
    expect(o.hooks).toEqual(['completed']);
    expect(o.bodies.length).toBe(1);
  });

  // liveness-audit D2 (red before the fix): the server drops A's liveness session only (the one session with
  // short server keepalives) while A's claim waits for its answer. Another process takes the run over; A, back,
  // is refused its body and gives the claim back; the taker met A's claim still held and ended the run `failed`
  // (RunBusyError) — 6 of 6 trials with warm processes, body run 0 times, nobody continues the run. Now the
  // taker waits for the call (parked on it, detached.ts) and continues once A gave it back; A never starts the
  // body after the takeover (D4, Attempt.assertHeld).
  // The same with a workKey run (d25 U6 audit): the taker continues it from its recorded input (registry
  // resumeLaunch). Before the U6 fix that takeover was refused as "different work" and the run stayed parked.
  for (const workKey of [false, true]) {
    it(`claimed, then A's liveness session dropped by the server: the run still completes, its body once${workKey ? ' (workKey run)' : ''}`, { timeout: 90_000 }, async () => {
      const o = await trial({ moment: 'pre-body', freezeMs: 10_000, dropLivenessMs: 1000, workKey, env: { DN_RECOVER: '1' } });
      expect(o.held).toBeGreaterThan(0);
      expect(o.bodies.length, 'at most once').toBeLessThanOrEqual(1);
      expect(o.last).toBe('completed');
      expect(o.bodies.length, 'and once').toBe(1);
    });
  }

  // liveness-audit D3 (red before the fix): the server drops every session (a restart, a failover) while a body
  // runs. The body finishes its effect; the write of its success fails on a dead pooled connection (and was
  // reported as "the pool given to PostgresStorage has no connect()", which it has). The model was told the tool
  // FAILED, answered, and the run ended `completed` — the effect happened once, its record stayed `running`: 10
  // of 10 trials. Now the success is written once the store answers and the run continues from it.
  it('the server drops every session under a running body: the model is not told a done effect failed', { timeout: 90_000 }, async () => {
    const o = await trial({ moment: 'body', freezeMs: 10_000, everyoneDropMs: 1000 });
    expect(o.held).toBeGreaterThan(0);
    expect(o.effects.length, 'the effect happened once').toBe(1);
    expect(o.toolErrors, 'a done effect is never told to the model as failed').toEqual([]);
    expect(o.tool).toBe('succeeded');
  });
  // D3 RETRY (framework-s0/d3-retry-denetim, red before the fix): after D3 the user sends the same
  // request again — a new run, the call keyed by its business key in a 'thread' or 'cross-run' window — and a
  // load balancer hands it to ANOTHER process (B). A's attempt had ended with its stamp still the record; A is
  // alive (its session back), so B read that stamp as a live attempt and waited on it with no end: the second
  // run hung in `tool`, no answer, no error, for as long as A lived (>70 s measured). Now A's success is
  // written once the store answers: the second run meets the call answered and ends, the effect done once.
  for (const [window, workKey] of [['thread', false], ['cross-run', false], ['thread', true], ['cross-run', true]] as const) {
    it(`after D3, the same request again on another process ('${window}' window): it ends, the effect once${workKey ? ' (workKey runs)' : ''}`, { timeout: 120_000 }, async () => {
      const o = await trial({ moment: 'body', freezeMs: 10_000, everyoneDropMs: 1000, retryOn: 1, workKey, env: { DN_WINDOW: window, DN_THREAD: `lup-thread-${Date.now().toString(36)}` } });
      expect(o.held).toBeGreaterThan(0);
      expect(o.effects.length, 'the effect happened in the first run').toBe(1);
      // The first run is continued past its call too (a workKey run's takeover used to be refused: parked for good, d25 U6).
      expect(o.last, 'the first run ends').toBe('completed');
      expect(o.second!.ended, 'the second run ends (it does not hang)').toBe(true);
      expect(o.second!.effects, 'the effect still happened once').toBe(1);
      expect(o.second!.bodies, 'the body ran once').toBe(1);
    });
  }
});
