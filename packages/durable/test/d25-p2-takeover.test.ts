// d25 P2 maddeler 5 + 7, REAL TWO PROCESSES on one Sqlite file (ports 41700+): process A takes a sealed
// request (user ayse, org org-1), runs the tool body's effect and is killed -9 before the effect's record.
// Process B takes the run over. What B's recover()/idempotencyKey()/lookup() and its dynamic `tools` /
// `system` functions are told must be the run's own caller — user AND org — not nobody.
//
// Spec by behaviour: the fixture (fixtures/d25-takeover-node.ts) writes what the code saw; it reads
// `identityOf(opts)` in the hooks and `serverIdentityOf(ctx)` / `ctx.org` in the dynamic functions.
import { describe, it, expect, afterEach } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newStore, startNode, post, waitFor, stopNode, linesOf, effectCount, type Node, type Store } from './detached/harness.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'd25-takeover-node.ts');
const live: Node[] = []; const stores: Store[] = [];
afterEach(async () => { await Promise.all(live.splice(0).map(stopNode)); stores.splice(0).forEach((s) => s.drop()); });
const node = async (s: Store, env: Record<string, string>) => { const n = await startNode(s, env, fixture); live.push(n); return n; };
const outcome = async (n: Node, runId: string) => (await (await fetch(n.url(`/outcome?runId=${encodeURIComponent(runId)}`))).json()) as { status?: string } | null;
const lines = (s: Store, name: string) => linesOf(`${s.effects}.${name}`).map((l) => { const i = l.indexOf(' '); return { pid: Number(l.slice(0, i)), v: JSON.parse(l.slice(i + 1)) }; });

async function takeover(who = 'ayse', org = 'org-1', ports: [number, number] = [41700, 41701]) {
  const s = newStore('sqlite', 'd25'); stores.push(s);
  const env = { DT_KILL: '1', DT_SWEEP_MS: '200' };
  const a = await node(s, { ...env, DT_PORT: String(ports[0]) });
  const b = await node(s, { ...env, DT_PORT: String(ports[1]) });
  await post(a, '/run', { runId: 'tk1', who, org }).catch(() => undefined);
  await waitFor(() => linesOf(`${s.effects}.killed`).length > 0, 20_000, 'the kill of A');
  await waitFor(async () => (await outcome(b, 'tk1'))?.status === 'completed', 30_000, 'B to finish the run');
  const killedPid = a.pid;
  return { s, a, b, killedPid, by: (name: string) => lines(s, name).filter((l) => l.pid !== killedPid).map((l) => l.v) };
}

describe('P2-5 a takeover (kill -9 of the first process): the successor\'s hooks see the run\'s caller', () => {
  it('recover() in the successor is handed ayse / org-1 / the run, and the effect landed exactly once', { timeout: 60_000 }, async () => {
    const t = await takeover();
    const rec = t.by('recover');
    expect(rec.length, 'B asked recover()').toBeGreaterThanOrEqual(1);
    for (const r of rec) expect(r).toMatchObject({ kind: 'user', id: 'ayse', orgId: 'org-1', runId: 'tk1' });
    expect(effectCount(t.s)).toBe(1);
  });

  it('sibling: idempotencyKey() and lookup() in the successor see the same caller (if they run there at all)', { timeout: 60_000 }, async () => {
    const t = await takeover('mehmet', 'org-2', [41702, 41703]);
    for (const name of ['idem', 'lookup']) for (const r of t.by(name)) expect(r, name).toMatchObject({ kind: 'user', id: 'mehmet', orgId: 'org-2', runId: 'tk1' });
    for (const r of t.by('recover')) expect(r).toMatchObject({ kind: 'user', id: 'mehmet', orgId: 'org-2' });
    expect(t.by('recover').length).toBeGreaterThanOrEqual(1);
  });
});

describe('P2-7 a takeover: the dynamic tools / system argument carries the run\'s caller, not an empty context', () => {
  it('the successor\'s dynamic `tools` function is called with resourceId ayse and org org-1', { timeout: 60_000 }, async () => {
    const t = await takeover('ayse', 'org-1', [41704, 41705]);
    const dyn = t.by('dyn');
    expect(dyn.length, 'B resolved the agent\'s tools').toBeGreaterThanOrEqual(1);
    for (const d of dyn) expect(d).toMatchObject({ resourceId: 'ayse', orgId: 'org-1', org: 'org-1' });
  });

  it('sibling: the dynamic `system` function sees it too, and the first process saw the same values (door-sealed)', { timeout: 60_000 }, async () => {
    const t = await takeover('ayse', 'org-1', [41706, 41707]);
    for (const d of t.by('sys')) expect(d).toMatchObject({ resourceId: 'ayse', orgId: 'org-1', org: 'org-1' });
    const first = lines(t.s, 'dyn').filter((l) => l.pid === t.killedPid).map((l) => l.v);
    expect(first[0]).toMatchObject({ resourceId: 'ayse', orgId: 'org-1' });
  });
});
