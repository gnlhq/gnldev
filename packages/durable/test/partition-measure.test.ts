// MEASUREMENT (not part of the suite: runs only with NP_MEASURE=1). How many times does a side effect
// run when the process executing it is frozen and loses its database while it holds the call?
//
// Real processes (test/fixtures/detached-node.ts). Process A starts a run whose tool body takes
// NP_TOOL_MS; when the body has begun, A is frozen (SIGSTOP). On Postgres every session A holds — the
// process-liveness lock and the pool — is terminated (what the server does to a partitioned host after
// its keepalive gives up). Process B, on the same store, sweeps. Then A is resumed (SIGCONT) and its
// body finishes what it was doing. Counted from the effects file, outside the database:
//   raw    — how many times the body produced the effect (what a provider that ignores the key sees)
//   keys   — distinct idempotency keys among them (what a provider that dedups on the key executes)
//
// Tool kinds: recover  — sideEffect + recover() asking the provider by key (the key-accepting system)
//             plain    — sideEffect, no recover (the crash ladder stops for a human)
//             idem     — idempotent: true (the developer declared a repeat harmless)
// Modes:      cut      — freeze + every session of A terminated
//             freeze   — freeze only (sessions stay: the kernel answers keepalives)
//             cascade  — NP_HOPS partitions in a row: each process that took the body over is frozen and
//                        cut in its turn (NP_HOPS + 1 processes); then all are resumed
//
//   NP_HOLD_MS (cascade: how long the frozen processes stay frozen), NP_DB_PREFIX (database name prefix)
//   NP_MEASURE=1 GNL_PG_URL=… NP_KIND=postgres NP_TOOL=recover NP_MODE=cut NP_N=20 NP_OUT=<file.jsonl> vitest run test/partition-measure.test.ts
import { describe, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { newStore, startNode, post, waitFor, stopNode, sleep, linesOf, readEvents, type Node, type Store } from './detached/harness.js';

const on = process.env.NP_MEASURE === '1';
const kind = (process.env.NP_KIND ?? 'sqlite') as 'sqlite' | 'postgres';
const toolKind = process.env.NP_TOOL ?? 'recover';
const mode = process.env.NP_MODE ?? 'cut';
const trials = Number(process.env.NP_N ?? 20);
const out = process.env.NP_OUT;
const toolMs = Number(process.env.NP_TOOL_MS ?? 3000);
const freezeMs = Number(process.env.NP_FREEZE_MS ?? 8000);

const psql = (sql: string) => execSync(`docker exec gnl-r7-pg psql -U postgres -Atc "${sql}"`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/** A node whose every Postgres session carries `application_name` = its tag, so they can be cut as one. */
async function tagged(s: Store, tag: string, env: Record<string, string>): Promise<Node> {
  if (s.kind !== 'postgres') return startNode(s, env);
  const u = new URL(s.where);
  u.searchParams.set('application_name', tag);
  return startNode({ ...s, where: u.toString() }, env);
}

describe.skipIf(!on)(`partition measurement: ${kind} / ${toolKind} / ${mode}`, () => {
  it(`${trials} trials`, { timeout: trials * (60_000 + Number(process.env.NP_HOLD_MS ?? 0)) }, async () => {
    for (let t = 0; t < trials; t++) {
      const s = newStore(kind, process.env.NP_DB_PREFIX ?? 'np');
      const env: Record<string, string> = {
        DN_TOOL_MS: String(toolMs), DN_WORDS: 'done', DN_SWEEP_MS: '300', DN_DEADLINE_MS: '120000',
        ...(toolKind === 'recover' ? { DN_RECOVER: '1' } : {}),
        ...(toolKind === 'idem' ? { DN_IDEMPOTENT: '1' } : {}),
      };
      const tagA = `np_a_${process.pid}_${t}`;
      const nodes: Node[] = [];
      const t0 = Date.now();
      let takeoverMs: number | null = null;
      let note = '';
      try {
        const a = await tagged(s, tagA, env); nodes.push(a);
        const b = await tagged(s, `np_b_${process.pid}_${t}`, env); nodes.push(b);
        if (mode === 'cascade') {
          const hops = Number(process.env.NP_HOPS ?? 4);
          const tags = [tagA, `np_b_${process.pid}_${t}`];
          for (let h = 2; h <= hops; h++) { tags.push(`np_${h}_${process.pid}_${t}`); nodes.push(await tagged(s, tags[h]!, env)); }
          await post(a, '/start', { runId: 'r' });
          const started = () => linesOf(`${s.effects}.started`).map((l) => Number(l.split(' ')[0]));
          const frozen = new Set<number>();
          let hopsDone = 0;
          for (let h = 0; h < hops; h++) {
            // The process that holds the body now (the last one that began it, not yet frozen).
            try { await waitFor(() => started().some((p) => !frozen.has(p)), 15_000, `hop ${h}: a live process began the body`); } catch { break; }
            const pid = started().find((p) => !frozen.has(p))!;
            const i = nodes.findIndex((n) => n.pid === pid);
            nodes[i]!.kill('SIGSTOP');
            frozen.add(pid);
            if (kind === 'postgres') psql(`SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE application_name = '${tags[i]}'`);
            hopsDone++;
          }
          // How long the frozen processes stay frozen before they are resumed (NP_HOLD_MS, default 3 s): past
          // their claim TTL (30 s) a late holder is the case a timer could not cover.
          await sleep(Number(process.env.NP_HOLD_MS ?? 3_000));
          for (const n of nodes) n.kill('SIGCONT');
          await sleep(toolMs + 5_000);
          const effects = linesOf(s.effects);
          const pending = await (await fetch(nodes[nodes.length - 1]!.url('/pending?quiet=0'))).json().catch(() => null);
          // What a reader of the run sees: its last status, and what the call answered.
          const evs = await readEvents(await fetch(nodes[nodes.length - 1]!.url('/events?runId=r&after=0'))).catch(() => [] as any[]);
          const statuses = evs.filter((e) => e.kind === 'status').map((e) => e.data.state);
          const toolOut = evs.filter((e) => e.kind === 'tool-result').map((e) => (e.data.output?.__gnl_blocked ? `blocked:${e.data.output.__gnl_blocked.code}` : e.data.output));
          // The call's record as the store holds it (Postgres), and the processes' last words when the run failed.
          const db = kind === 'postgres' ? new URL(s.where).pathname.slice(1) : '';
          const record = db ? execSync(`docker exec gnl-r7-pg psql -U postgres -d ${db} -Atc "SELECT left(value, 300) FROM gnl_run_journal WHERE key = 'r:tool:call-1'"`).toString().trim() : undefined;
          const final = statuses[statuses.length - 1];
          const stderr = final === 'failed' ? nodes.map((n) => n.stderr().slice(-1500)) : undefined;
          const row = { kind, tool: toolKind, mode, trial: t, hops: hopsDone, final, toolOut, record, stderr, raw: effects.length, keys: new Set(effects.map((l) => l.split(' ').slice(1).join(' '))).size, began: started().length, hooks: linesOf(`${s.effects}.hooks`).map((l) => l.split(' ').slice(2).join(' ')), pending: Array.isArray(pending) ? pending.length : pending, ms: Date.now() - t0, ...(process.env.NP_EVENTS === '1' ? { events: evs.map((e) => [e.seq, e.kind, e.step, e.kind === 'status' ? e.data.state : e.kind === 'tool-result' ? String(e.data.output?.__gnl_blocked ? 'blocked' : e.data.output) : '']) } : {}) };
          console.log(JSON.stringify(row));
          if (out) appendFileSync(out, `${JSON.stringify(row)}\n`);
          continue;
        }
        await post(a, '/start', { runId: 'r' });
        await waitFor(() => linesOf(`${s.effects}.started`).some((l) => l.startsWith(`${a.pid} `)), 20_000, 'A began the body');
        a.kill('SIGSTOP');
        const frozenAt = Date.now();
        let cut = 0;
        if (mode === 'cut' && kind === 'postgres') cut = Number(psql(`SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE application_name = '${tagA}'`));
        // Wait while A is frozen: does B start the body itself?
        const end = frozenAt + freezeMs;
        while (Date.now() < end) {
          if (takeoverMs === null && linesOf(`${s.effects}.started`).some((l) => l.startsWith(`${b.pid} `))) takeoverMs = Date.now() - frozenAt;
          await sleep(50);
        }
        a.kill('SIGCONT');
        // A's body finishes; B (if it took over) finishes too; the run settles or stops for a human.
        await sleep(toolMs + 4_000);
        const effects = linesOf(s.effects);
        const raw = effects.length;
        const keys = new Set(effects.map((l) => l.split(' ').slice(1).join(' '))).size;
        const byA = effects.filter((l) => l.startsWith(`${a.pid} `)).length;
        const byB = effects.filter((l) => l.startsWith(`${b.pid} `)).length;
        const hooks = linesOf(`${s.effects}.hooks`).map((l) => l.split(' ').slice(2).join(' '));
        const pending = await (await fetch(b.url('/pending?quiet=0'))).json().catch(() => null);
        const row = { kind, tool: toolKind, mode, trial: t, cut, raw, keys, byA, byB, takeoverMs, hooks, pending: Array.isArray(pending) ? pending.length : pending, ms: Date.now() - t0, note };
        console.log(JSON.stringify(row));
        if (out) appendFileSync(out, `${JSON.stringify(row)}\n`);
      } catch (e: any) {
        note = String(e?.message ?? e);
        const row = { kind, tool: toolKind, mode, trial: t, error: note, stderr: nodes.map((n) => n.stderr().slice(-500)) };
        console.log(JSON.stringify(row));
        if (out) appendFileSync(out, `${JSON.stringify(row)}\n`);
      } finally {
        await Promise.all(nodes.map(stopNode));
        s.drop();
      }
    }
  });
});
