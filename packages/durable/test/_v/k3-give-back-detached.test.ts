// k3-b2 (3b), the detached execution record: a run that finished on A, whose record's ending write
// failed once, does not stay "running on A" for as long as A lives. Real processes (Sqlite file,
// Postgres): A stays alive throughout.
import { describe, it, expect, afterEach } from 'vitest';
import { newStore, startNode, post, readEvents, effectCount, linesOf, stopNode, sleep, PG_BASE, type Node, type Store, type StoreKind } from '../detached/harness.js';

const backend = process.env.K3_BACKEND ?? 'postgres';
const kinds: StoreKind[] = backend === 'postgres' ? (PG_BASE ? ['sqlite', 'postgres'] : ['sqlite']) : [backend as StoreKind];
const live: Node[] = [];
const stores: Store[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map(stopNode));
  stores.splice(0).forEach((s) => s.drop());
});

describe.each(kinds)('k3-b2 give-back, detached — %s', (kind) => {
  it(`GBD1 ${kind}: the finished run's record deletion fails once on A — the record does not stay A's while A lives`, { timeout: 60_000 }, async () => {
    const s = newStore(kind);
    stores.push(s);
    // A does not sweep (its own sweep would read its ended hold and finish the run itself): only another
    // process can, and to it a record naming A, alive, reads as held.
    const a = await startNode(s, { DN_FAIL_EXEC_DELETE: '1', DN_SWEEP_MS: '600000' });
    live.push(a);
    const b = await startNode(s, { DN_SWEEP_MS: '200' });
    live.push(b);
    expect((await (await post(a, '/start', { runId: 'r-gbd1' })).json()).state).toBe('started');
    const evs = await readEvents(await fetch(b.url('/events?runId=r-gbd1&after=0')));
    const final = evs.filter((e: any) => e.kind === 'status').map((e: any) => e.data.state).pop();
    let keys: string[] = [];
    const t0 = Date.now();
    for (;;) {
      keys = await (await fetch(b.url('/keys?prefix=__exec__:'))).json();
      if (keys.length === 0 || Date.now() - t0 > 5_000) break;
      await sleep(100);
    }
    const pending = await (await fetch(b.url('/pending?quiet=0'))).json();
    console.log(`[k3-b2 GBD1 ${kind}] final=${final} exec records after ${Date.now() - t0} ms: ${JSON.stringify(keys)} pending=${JSON.stringify(pending).slice(0, 200)} effects=${effectCount(s)} hooks=${linesOf(`${s.effects}.hooks`).length} A alive=${a.child.exitCode === null}`);
    expect(final).toBe('completed');
    expect(keys).toEqual([]);
    expect(effectCount(s)).toBe(1);
    expect(linesOf(`${s.effects}.hooks`)).toHaveLength(1);
  });
});
