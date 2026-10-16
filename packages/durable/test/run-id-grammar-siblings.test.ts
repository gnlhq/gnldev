// Siblings of R2-1 (root 1: the run-id grammar). R2-1 was one family — `<id>:ev-delivered` — whose prefix
// reached a neighbour run. These are the run-keyed families OUTSIDE `<id>:` and the listings INSIDE it
// that had the same open boundary: each one a run `x` reaching a run whose id extends `x`.
import { describe, it, expect } from 'vitest';
import { purgeRun, stampFormat, readIdemLedger, recordIdemConflict, runKeys } from '../src/index.js';
import { hasRunningClaim } from '../src/model.js';
import { STORES, unique } from './audit-r2/stores.js';

const input = (who: string) => stampFormat({ at: 1, prompt: 'p', resourceId: who });

describe.each(STORES)('a run reaches only its own run-keyed families — %s', (_n, make) => {
  it("purging x leaves the request window of a run named 'x:args-…'", async () => {
    const s = await make(); const j = s.runs as any; const x = `x${unique()}`; const n = `${x}:args-z`;
    await j.put(runKeys.input(x), input('alice'));
    await j.put(runKeys.toolRequest(x, 'pay', 'h1'), { status: 'done', output: 'alice' });
    await j.put(runKeys.input(n), input('mallory'));
    await j.put(runKeys.toolRequest(n, 'pay', 'h2'), { status: 'done', output: 'mallory' });
    await purgeRun(j, x);
    expect({
      own: await j.get(runKeys.toolRequest(x, 'pay', 'h1')),
      neighbour: await j.get(runKeys.toolRequest(n, 'pay', 'h2')),
    }).toEqual({ own: undefined, neighbour: { status: 'done', output: 'mallory' } });
  });

  it("purging x leaves the network sub-runs of a run named 'x:5'", async () => {
    const s = await make(); const j = s.runs as any; const x = `x${unique()}`; const n = `${x}:5`;
    await j.put(runKeys.input(x), input('alice'));
    await j.put(`${x}:net:route:0`, { v: { agent: 'a', task: 't' } });
    await j.put(runKeys.input(`net:${x}:0`), input('alice'));
    await j.put(runKeys.input(n), input('mallory'));
    await j.put(`${n}:net:route:0`, { v: { agent: 'a', task: 't' } });
    await j.put(runKeys.input(`net:${n}:0`), input('mallory'));
    await j.put(runKeys.model(`net:${n}:0`, 0), { content: [] });
    await purgeRun(j, x);
    expect({
      ownChild: await j.get(runKeys.input(`net:${x}:0`)),
      neighbourChild: (await j.get(runKeys.input(`net:${n}:0`)))?.resourceId,
      neighbourChildStep: await j.get(runKeys.model(`net:${n}:0`, 0)),
    }).toEqual({ ownChild: undefined, neighbourChild: 'mallory', neighbourChildStep: { content: [] } });
  });

  it("x is not in flight because a run named 'x:y' has a running call", async () => {
    const s = await make(); const j = s.runs as any; const x = `x${unique()}`;
    await j.put(runKeys.input(x), input('alice'));
    await j.put(runKeys.input(`${x}:y`), input('mallory'));
    await j.put(runKeys.tool(`${x}:y`, 'c1'), { status: 'running' });
    expect({ x: await hasRunningClaim(j, x), neighbour: await hasRunningClaim(j, `${x}:y`) }).toEqual({ x: false, neighbour: true });
  });

  it("x's idempotency ledger lists x's conflicts, not those of a run named 'x:y'", async () => {
    const s = await make(); const j = s.runs as any; const x = `x${unique()}`;
    await recordIdemConflict(j, { runId: x, kind: 'busy' } as any, 'require');
    await recordIdemConflict(j, { runId: `${x}:y`, kind: 'busy' } as any, 'require');
    expect((await readIdemLedger(j, { runId: x })).map((r) => r.runId)).toEqual([x]);
  });
});
