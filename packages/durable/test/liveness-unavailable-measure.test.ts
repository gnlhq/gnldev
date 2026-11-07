// MEASUREMENT (not part of the suite: runs only with LU_MEASURE=1 and GNL_PG_URL). The process executing a
// run is healthy, but the database stops answering it for a few seconds (a stalled network, a swamped
// server). Its liveness proof goes unanswered, its session counts as lost, and LivenessUnavailableError
// comes into play. Does the run still end right, is the tool body run at most once, who continues it?
//
// Three app processes (test/fixtures/detached-node.ts) on one Postgres, each behind its own FreezeProxy
// (test/detached/freeze-proxy.ts), so the database can stop answering ONE process while the others are fine.
//
//   LU_MOMENT   pre-claim  — A is frozen before it is asked to start the run (the start request lands frozen)
//               model      — inside the first model call (the model takes DN_MODEL_MS; frozen once A calls it)
//               pre-body   — the call's claim was sent, its answer held: claimed, body not started
//               body       — the tool body is running (it takes DN_TOOL_MS)
//               post-body  — the body returned; the write of its success is held before the server sees it
//               ending     — the run's first `completed` write (outcome or status event) is held
//   LU_VARIANT  a          — only A's connections stop
//               all        — every process's connections stop (the database itself)
//               a-liveness — only A's liveness session stops; its pool keeps working
//   LU_FREEZE_MS  how long it stays frozen; LU_DROP_MS  if set, the server gives up on the frozen
//               sessions this long into the freeze (backends end, A's process lock goes: the others may
//               then read A as dead and take over) — A hears of it at the thaw
//   LU_HONOR    the body obeys its abortSignal (DN_HONOR: reason | timers | generic); unset: ignores it
//   LU_N trials, LU_OUT directory (one JSON per trial + summary.jsonl), LU_NAME scenario name
import { describe, it } from 'vitest';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newStore, startNode, post, sleep, linesOf, stopNode, PG_BASE, type Node, type Store } from './detached/harness.js';
import { FreezeProxy, type Selector } from './detached/freeze-proxy.js';
import { helperPool } from '../../../test/support/pg-admin.js';

const on = process.env.LU_MEASURE === '1' && !!PG_BASE;
const moment = process.env.LU_MOMENT ?? 'body';
const variant = process.env.LU_VARIANT ?? 'a';
const freezeMs = Number(process.env.LU_FREEZE_MS ?? 6000);
const dropMs = process.env.LU_DROP_MS !== undefined ? Number(process.env.LU_DROP_MS) : undefined;
// LU_DROP_SEL=liveness: the server gives up on the liveness session alone (the only one with short server
// keepalives — process-liveness.ts sets them on it; pool sessions keep the OS default of hours).
const dropSel = process.env.LU_DROP_SEL === 'liveness' ? 'liveness' as const : undefined;
const honor = process.env.LU_HONOR;
// LU_TOOL: recover (sideEffect + recover() asking the effects file by key) | idem (idempotent: true) | unset (plain sideEffect)
const toolKind = process.env.LU_TOOL;
const trials = Number(process.env.LU_N ?? 10);
const name = process.env.LU_NAME ?? `${moment}-${variant}-${freezeMs}${dropMs !== undefined ? `-drop${dropSel ? 'liv' : ''}${dropMs}` : ''}${honor ? `-${honor}` : ''}${toolKind ? `-${toolKind}` : ''}`;
const outDir = join(process.env.LU_OUT ?? '.', name);
const toolMs = Number(process.env.LU_TOOL_MS ?? (moment === 'body' ? 4000 : 300));

/** Every journal row of the run, by key (values decoded from the store's superjson text). */
async function rowsOf(where: string, runId: string): Promise<Record<string, any>> {
  const pool = helperPool(where);
  try {
    const r = await pool.query(`SELECT key, value FROM gnl_run_journal WHERE position($1 in key) > 0 ORDER BY key`, [runId]);
    const out: Record<string, any> = {};
    for (const row of r.rows) { try { const v = JSON.parse(row.value); out[row.key] = v?.json ?? v; } catch { out[row.key] = row.value; } }
    return out;
  } finally { await pool.end(); }
}

function summarize(rows: Record<string, any>, runId: string) {
  const events = Object.entries(rows).filter(([k]) => k.includes(`${runId}:ev:`)).map(([, v]) => v).sort((a, b) => a.seq - b.seq);
  const statuses = events.filter((e) => e.kind === 'status').map((e) => e.data?.state);
  const outcome = Object.entries(rows).find(([k]) => k.endsWith(`${runId}:outcome`))?.[1];
  const exec = Object.entries(rows).find(([k]) => k.startsWith('__exec__'))?.[1];
  const tool = Object.entries(rows).find(([k]) => k.includes(`${runId}:tool:`))?.[1];
  const toolErrors = events.filter((e) => e.kind === 'tool-error').map((e) => e.data?.error?.name ?? e.data?.error?.message);
  const toolResults = events.filter((e) => e.kind === 'tool-result').length;
  return { statuses, lastStatus: statuses.at(-1), outcome: outcome ? { status: outcome.status, error: outcome.error, errorName: outcome.errorName } : undefined, exec: exec ? { status: exec.status, owner: exec.owner, reason: exec.reason, awaits: exec.awaits } : undefined, tool: tool ? { status: tool.status, error: tool.error } : undefined, toolErrors, toolResults, events: events.length };
}

describe.skipIf(!on)(`liveness unavailable: ${name}`, () => {
  it(`${trials} trials`, { timeout: trials * 120_000 }, async () => {
    mkdirSync(outDir, { recursive: true });
    const up = new URL(PG_BASE!);
    for (let t = 0; t < trials; t++) {
      const s: Store = newStore('postgres', 'lu');
      const runId = `lu-${t}-${Date.now().toString(36)}`;
      const proxies = ['A', 'B', 'C'].map((n) => new FreezeProxy({ host: up.hostname, port: Number(up.port || 5432) }, n));
      const nodes: Node[] = [];
      const t0 = Date.now();
      let stopWatch: () => Promise<void> = async () => {};
      const rec: any = { name, trial: t, runId, moment, variant, freezeMs, dropMs, dropSel, honor, toolKind, toolMs, t0 };
      try {
        await Promise.all(proxies.map((p) => p.start()));
        const env: Record<string, string> = {
          DN_TOOL_MS: String(toolMs), DN_WORDS: 'done', DN_SWEEP_MS: '300', DN_DEADLINE_MS: '150000', DN_MODEL_LOG: '1', DN_TS: '1',
          ...(moment === 'model' ? { DN_MODEL_MS: '3000' } : {}),
          ...(honor ? { DN_HONOR: honor } : {}),
          ...(toolKind === 'recover' ? { DN_RECOVER: '1' } : {}),
          ...(toolKind === 'idem' ? { DN_IDEMPOTENT: '1' } : {}),
        };
        // Every session of a process names it (application_name), so a snapshot of the server says whose it is.
        for (const p of proxies) { const u = new URL(p.urlFor(s.where)); u.searchParams.set('application_name', `lu_${p.name}`); nodes.push(await startNode({ ...s, where: u.toString() }, env)); }
        const [a] = nodes as [Node, Node, Node];
        // Every process warm before the run: its store booted (schema check) by its first sweep. A process
        // booting DURING a freeze queues DDL behind A's open transaction (a harness artifact here, a real
        // effect of a deploy that starts a process while another one is stalled — observed and noted apart).
        for (const n of nodes) { const end = Date.now() + 15_000; while (Date.now() < end && !((await (await fetch(n.url('/stats'))).json()).store > 0)) await sleep(50); }
        await sleep(400);
        rec.pids = { A: nodes[0]!.pid, B: nodes[1]!.pid, C: nodes[2]!.pid };
        const who = (pid: number) => (Object.entries(rec.pids).find(([, p]) => p === pid)?.[0] ?? String(pid));
        const pa = proxies[0]!;
        // Whose is the execution record, over time (read straight from the database, not through a proxy).
        const ids: Record<string, string> = {};
        for (const [i, n] of nodes.entries()) ids[(await (await fetch(n.url('/stats'))).json()).livenessId] = ['A', 'B', 'C'][i]!;
        rec.execHistory = [] as string[];
        const watchPool = helperPool(s.where);
        let watching = true;
        const watcher = (async () => {
          let last = '';
          while (watching) {
            try {
              const r = await watchPool.query(`SELECT value FROM gnl_run_journal WHERE key LIKE '__exec__%' AND position($1 in key) > 0`, [runId]);
              const v = r.rows[0] ? (JSON.parse(r.rows[0].value).json ?? {}) : undefined;
              const cur = v ? `${ids[v.owner] ?? v.owner}:${v.status}${v.reason ? `(${String(v.reason).slice(0, 60)})` : ''}` : 'none';
              if (cur !== last) { rec.execHistory.push(`${Date.now() - t0} ${cur}`); last = cur; }
            } catch { /* keep watching */ }
            await sleep(25);
          }
        })();
        stopWatch = async () => { watching = false; await watcher; await watchPool.end(); };
        const sel: Selector = variant === 'a-liveness' ? 'liveness' : 'all';
        pa.triggerSelector = sel;
        let frozenAt: number | undefined;
        let thawedAt: number | undefined;
        /** A is frozen (by a trigger or by hand): the others too in variant `all`; thawed after freezeMs; a drop on the way. */
        const followFreeze = async () => {
          while (!pa.frozen) await sleep(2);
          frozenAt = Date.now();
          if (variant === 'all') for (const p of proxies.slice(1)) p.freeze('all', 'with A');
          if (dropMs !== undefined) { await sleep(dropMs); for (const p of proxies) if (p.frozen) p.dropServer(dropSel); await sleep(Math.max(0, freezeMs - dropMs)); }
          else await sleep(freezeMs);
          // What the database is waiting on just before the thaw: sessions blocked on a lock, and by what.
          try {
            const snap = helperPool(s.where);
            rec.blockedBeforeThaw = (await snap.query(`SELECT pid, application_name, backend_start, xact_start, wait_event_type, state, left(query, 160) AS query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname = current_database() AND (wait_event_type = 'Lock' OR state LIKE 'idle in transaction%')`)).rows;
            await snap.end();
          } catch (e) { rec.blockedBeforeThaw = String(e); }
          for (const p of proxies) p.thaw();
          thawedAt = Date.now();
        };
        let once = false;
        const trigger = (test: (c: string) => boolean, how: 'freeze-before' | 'freeze-after') => pa.onClientData((chunk) => {
          if (once) return undefined;
          const c = chunk.toString('latin1');
          if (!test(c)) return undefined;
          once = true;
          rec.triggerChunk = c.replace(/[^\x20-\x7e]/g, '.').slice(0, 400);
          return how;
        });
        if (moment === 'pre-body') trigger((c) => c.includes(`${runId}:tool:`) && c.includes('"status":"running"'), 'freeze-after');
        if (moment === 'post-body') trigger((c) => c.includes(`${runId}:tool:`) && c.includes('"status":"succeeded"'), 'freeze-before');
        if (moment === 'ending') trigger((c) => !c.includes(':tool:') && (c.includes('"state":"completed"') || (c.includes(`${runId}:outcome`) && c.includes('"status":"completed"'))), 'freeze-before');
        const freezing = moment === 'none' ? Promise.resolve() : followFreeze();
        let startRes: any;
        if (moment === 'pre-claim') {
          pa.freeze(sel, 'before start');
          const r = await post(a, '/start', { runId }).then(async (res) => ({ status: res.status, body: await res.text() }), (e) => ({ error: String(e) }));
          startRes = r;
        } else {
          const r = await post(a, '/start', { runId });
          startRes = { status: r.status, body: await r.text() };
          if (moment === 'model') {
            while (!linesOf(`${s.effects}.model`).some((l) => l.startsWith(`${a.pid} 0 `))) await sleep(2);
            pa.freeze(sel, 'inside model call');
          }
          if (moment === 'body') {
            while (!linesOf(`${s.effects}.started`).length) await sleep(2);
            pa.freeze(sel, 'inside body');
          }
        }
        rec.start = startRes;
        // A moment that never came (its trigger did not fire within the run): said, not counted as a freeze.
        const fired = await Promise.race([freezing.then(() => true), sleep(40_000).then(() => false)]);
        rec.freezeFired = moment === 'none' ? 'control' : fired;
        rec.frozenAt = frozenAt !== undefined ? frozenAt - t0 : null;
        rec.thawedAt = thawedAt !== undefined ? thawedAt - t0 : null;
        rec.heldBytes = Object.fromEntries(proxies.map((p) => [p.name, p.log.filter((e) => e.ev === 'held').reduce((x, e) => x + (e.bytes ?? 0), 0)]));
        // A client whose start failed retries it once the database answers again (what a client does with a 5xx/503).
        if (moment === 'pre-claim' && (startRes.status === undefined || startRes.status >= 500)) {
          await sleep(500);
          const r2 = await post(a, '/start', { runId }).then(async (res) => ({ status: res.status, body: await res.text() }), (e) => ({ error: String(e) }));
          rec.retry = r2;
        }
        // Settle: the run ends (completed/failed — the completion hook), or parks; then a while longer for late duplicates.
        const end = Date.now() + 45_000;
        let settledAt: number | undefined;
        while (Date.now() < end) {
          const hooks = linesOf(`${s.effects}.hooks`);
          const rows = await rowsOf(s.where, runId).catch(() => ({}));
          const sum = summarize(rows, runId);
          // Parked on a call another attempt holds (`awaits`) is not settled: a sweep continues it.
          if (hooks.length || (sum.exec?.status === 'parked' && !sum.exec.awaits) || (!sum.exec && sum.lastStatus && sum.lastStatus !== 'running')) { settledAt = Date.now(); break; }
          await sleep(250);
        }
        await sleep(4000);
        const rows = await rowsOf(s.where, runId);
        const sum = summarize(rows, runId);
        const hooks = linesOf(`${s.effects}.hooks`).map((l) => { const [pid, , state] = l.split(' '); return { by: who(Number(pid)), state }; });
        Object.assign(rec, {
          settledMs: settledAt !== undefined ? settledAt - t0 : null,
          final: hooks.at(-1)?.state ?? (sum.exec?.status === 'parked' ? `parked:${sum.lastStatus}` : sum.exec ? `exec:${sum.exec.status}` : `no-exec:${sum.lastStatus}`),
          endedBy: hooks.map((h) => h.by),
          hooks,
          bodyStarts: linesOf(`${s.effects}.started`).map((l) => who(Number(l.split(' ')[0]))),
          bodyTimes: linesOf(`${s.effects}.started`).map((l) => `${who(Number(l.split(' ')[0]))}@${Number(l.split(' ')[2]) - t0}`),
          effectTimes: linesOf(s.effects).map((l) => `${who(Number(l.split(' ')[0]))}@${Number(l.split(' ')[2]) - t0}`),
          hookTimes: linesOf(`${s.effects}.hooks`).map((l) => l),
          effects: linesOf(s.effects).map((l) => who(Number(l.split(' ')[0]))),
          aborted: linesOf(`${s.effects}.aborted`),
          modelCalls: linesOf(`${s.effects}.model`).map((l) => { const [pid, turns] = l.split(' '); return `${who(Number(pid))}:${turns}`; }),
          ...sum,
          proxyLog: Object.fromEntries(proxies.map((p) => [p.name, p.log.filter((e) => e.ev !== 'accept' && e.ev !== 'close').map((e) => ({ ...e, t: e.t - t0 }))])),
          stderr: Object.fromEntries(nodes.map((n, i) => [['A', 'B', 'C'][i], n.stderr().slice(-4000)])),
          rows,
        });
      } catch (e) {
        rec.harnessError = String((e as Error)?.stack ?? e);
      } finally {
        await stopWatch().catch(() => undefined);
        await Promise.all(nodes.map(stopNode));
        await Promise.all(proxies.map((p) => p.close().catch(() => undefined)));
        s.drop();
      }
      writeFileSync(join(outDir, `t${t}.json`), JSON.stringify(rec, null, 2));
      const line = { trial: t, execHistory: rec.execHistory, bodyTimes: rec.bodyTimes, final: rec.final, lastStatus: rec.lastStatus, outcome: rec.outcome?.status, exec: rec.exec?.status, tool: rec.tool?.status, bodies: rec.bodyStarts?.length, bodyBy: rec.bodyStarts, effects: rec.effects, endedBy: rec.endedBy, statuses: rec.statuses, toolErrors: rec.toolErrors, fired: rec.freezeFired, frozenAt: rec.frozenAt, thawedAt: rec.thawedAt, held: rec.heldBytes, start: rec.start?.status ?? rec.start?.error, retry: rec.retry?.status, settledMs: rec.settledMs, err: rec.harnessError?.slice(0, 200) };
      appendFileSync(join(outDir, 'summary.jsonl'), `${JSON.stringify(line)}\n`);
      console.log(`[LU ${name}] ${JSON.stringify(line)}`);
    }
  });
});
