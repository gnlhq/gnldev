// MEASUREMENT (runs only with NP_MEASURE=1): a background tool's body (`gnlTool(t, { background: true })`)
// when the process running it is frozen and — on Postgres — every session it holds is terminated.
// Same method as partition-measure.test.ts, on test/fixtures/deferred-node.ts. Counted besides the
// effect: result messages in the thread and the continuation's model calls (the wake).
//
//   NP_MEASURE=1 GNL_PG_URL=… NP_KIND=postgres NP_TOOL=recover|plain NP_MODE=cut NP_N=20 NP_OUT=<file.jsonl> vitest run test/partition-task-measure.test.ts
import { describe, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { newStore, startNode, post, waitFor, stopNode, sleep, linesOf, type Node, type Store } from './detached/harness.js';

const on = process.env.NP_MEASURE === '1';
const kind = (process.env.NP_KIND ?? 'sqlite') as 'sqlite' | 'postgres';
const toolKind = process.env.NP_TOOL ?? 'recover';
const mode = process.env.NP_MODE ?? 'cut';
const trials = Number(process.env.NP_N ?? 20);
const out = process.env.NP_OUT;
const taskMs = Number(process.env.NP_TOOL_MS ?? 3000);
const freezeMs = Number(process.env.NP_FREEZE_MS ?? 8000);
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'deferred-node.ts');
const psql = (sql: string) => execSync(`docker exec gnl-r7-pg psql -U postgres -Atc "${sql}"`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

async function tagged(s: Store, tag: string, env: Record<string, string>): Promise<Node> {
  if (s.kind !== 'postgres') return startNode(s, env, fixture);
  const u = new URL(s.where);
  u.searchParams.set('application_name', tag);
  return startNode({ ...s, where: u.toString() }, env, fixture);
}

describe.skipIf(!on)(`background task partition measurement: ${kind} / ${toolKind} / ${mode}`, () => {
  it(`${trials} trials`, { timeout: trials * 90_000 }, async () => {
    for (let t = 0; t < trials; t++) {
      const s = newStore(kind, 'np');
      const env: Record<string, string> = { DF_TASK_MS: String(taskMs), DF_SWEEP_MS: '300', DF_DEADLINE_MS: '120000', ...(toolKind === 'recover' ? { DF_RECOVER: '1' } : {}) };
      const tagA = `np_ta_${process.pid}_${t}`;
      const nodes: Node[] = [];
      try {
        const a = await tagged(s, tagA, env); nodes.push(a);
        const b = await tagged(s, `np_tb_${process.pid}_${t}`, env); nodes.push(b);
        await post(a, '/chat', { runId: 'p', threadId: 'T', text: 'research tides' }).then((r) => r.text());
        await waitFor(() => linesOf(`${s.effects}.started`).length > 0, 20_000, 'a body began');
        const runner = Number(linesOf(`${s.effects}.started`)[0]!.split(' ')[0]);
        const frozen = runner === a.pid ? a : b;
        const other = frozen === a ? b : a;
        const tagFrozen = frozen === a ? tagA : `np_tb_${process.pid}_${t}`;
        frozen.kill('SIGSTOP');
        const frozenAt = Date.now();
        let cut = 0;
        if (mode === 'cut' && kind === 'postgres') cut = Number(psql(`SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE application_name = '${tagFrozen}'`));
        let takeoverMs: number | null = null;
        while (Date.now() < frozenAt + freezeMs) {
          if (takeoverMs === null && linesOf(`${s.effects}.started`).some((l) => l.startsWith(`${other.pid} `))) takeoverMs = Date.now() - frozenAt;
          await sleep(50);
        }
        frozen.kill('SIGCONT');
        await sleep(taskMs + 6_000);
        const effects = linesOf(s.effects);
        const thread: Array<{ role: string; text: string }> = await (await fetch(other.url('/thread?threadId=T'))).json();
        const results = thread.filter((m) => m.role === 'user' && m.text.startsWith('Background task')).length;
        const wakes = linesOf(`${s.effects}.calls`).filter((l) => l.split(' ')[1] === 'cont').length;
        const row = { kind, scenario: 'task', tool: toolKind, mode, trial: t, cut, raw: effects.length, keys: new Set(effects.map((l) => l.split(' ').slice(1).join(' '))).size, byFrozen: effects.filter((l) => l.startsWith(`${frozen.pid} `)).length, byOther: effects.filter((l) => l.startsWith(`${other.pid} `)).length, takeoverMs, results, wakes };
        console.log(JSON.stringify(row));
        if (out) appendFileSync(out, `${JSON.stringify(row)}\n`);
      } catch (e: any) {
        const row = { kind, scenario: 'task', tool: toolKind, mode, trial: t, error: String(e?.message ?? e), stderr: nodes.map((n) => n.stderr().slice(-400)) };
        if (out) appendFileSync(out, `${JSON.stringify(row)}\n`);
      } finally {
        await Promise.all(nodes.map(stopNode));
        s.drop();
      }
    }
  });
});
