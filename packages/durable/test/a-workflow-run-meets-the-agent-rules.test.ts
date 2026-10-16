// A workflow run is entered through the same rules as an agent run — on every store.
//
// @gnldev/workflow cannot depend on this package, so it reaches the rules through the journal it is
// handed (`beginRun`, run-identity.ts). Measured before (raporlar/2026-10-16-verify): that entry kept a
// copy of its own that skipped two of them —
//   · who won a birth race: two identities starting one new id both ran, the loser inside the
//     winner's run; and a stranger naming an existing run read its steps' outputs;
//   · whether the run still exists: a run deleted while a step was in flight was written back by that
//     step — its output, and a `wfrun:` record saying `completed`; a deleted id could be begun again.
// The in-memory journal held in audit-verify-r3.test.ts; these hold the same on Sqlite and Postgres.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newDb } from 'pg-mem';
import pg from 'pg';
import { workflow, step } from '@gnldev/workflow';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { toJournal } from '../src/storage.js';
import { purgeRun } from '../src/retention.js';
import { runFenceKey } from '../src/erasure-fence.js';
import { runOwnerOf } from '../src/run-identity.js';
import { inMemoryLiveness } from '../src/process-liveness.js';

const PG_URL = process.env.GNL_PG_URL;
const ends: Array<() => unknown> = [];
afterAll(async () => { for (const end of ends.reverse()) await end(); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Store = { storage: any };
const BACKENDS: Array<[string, () => Promise<Store>]> = [
  ['Sqlite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-wfrules-'));
    const storage = new SqliteStorage(join(dir, 'runs.db'));
    ends.push(() => { storage.close?.(); rmSync(dir, { recursive: true, force: true }); });
    return { storage };
  }],
  ['Postgres (pg-mem)', async () => {
    const { Pool } = newDb().adapters.createPg();
    return { storage: Object.assign(new PostgresStorage({ pool: new Pool() }), { processLiveness: async () => inMemoryLiveness() }) };
  }],
];
if (PG_URL) BACKENDS.push(['Postgres (real)', async () => {
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  const name = `wfrules_t_${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(PG_URL); u.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: u.toString(), max: 6 });
  pool.on('error', () => {});
  const storage = new PostgresStorage({ pool });
  ends.push(async () => { await storage.close?.().catch(() => {}); await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); });
  return { storage };
}]);

const ayse = (runId: string) => ({ kind: 'user' as const, id: 'ayse', runId });
const bora = (runId: string) => ({ kind: 'user' as const, id: 'bora', runId });
const ownerOf = async (j: any, id: string) => {
  const o = await runOwnerOf(j, id);
  return o.state === 'owned' ? (o.owner.kind === 'user' ? `user:${o.owner.id}` : o.owner.kind) : o.state;
};
const footprint = async (j: any, id: string) => [...(await j.listKeys(`${id}:`)), ...(await j.listKeys(`wfrun:${id}`))];

describe.each(BACKENDS)('a workflow run meets the agent rules — %s', (_label, make) => {
  it('two identities racing to begin one new id: one runs, it is the recorded owner, the other is refused', async () => {
    const { storage } = await make();
    const j = toJournal(storage.runs) as any;
    const ranAs: string[] = [];
    const wf = workflow<any>().then(step('s', async (_i: any, ctx: any) => { ranAs.push(ctx.identity.id); await sleep(30); return `secret-of-${ctx.identity.id}`; }));
    const settled = await Promise.allSettled([
      wf.run({}, { runId: 'race', journal: j, identity: ayse('race') }),
      wf.run({}, { runId: 'race', journal: j, identity: bora('race') }),
    ]);
    const winner = await ownerOf(j, 'race');
    expect(settled.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(ranAs.map((id) => `user:${id}`)).toEqual([winner]);
    expect(settled.find((r) => r.status === 'rejected')).toMatchObject({ reason: { name: 'RunOwnerMismatchError' } });
  });

  it('a stranger naming an existing run is refused and reads nothing of it', async () => {
    const { storage } = await make();
    const j = toJournal(storage.runs) as any;
    const wf = workflow<any>().then(step('s', async (_i: any, ctx: any) => `secret-of-${ctx.identity.id}`));
    await wf.run({}, { runId: 'own', journal: j, identity: ayse('own') });
    const before = await footprint(j, 'own');
    await expect(wf.run({}, { runId: 'own', journal: j, identity: bora('own') })).rejects.toMatchObject({ name: 'RunOwnerMismatchError' });
    await expect(wf.runResumable({}, { runId: 'own', journal: j, identity: bora('own') })).rejects.toMatchObject({ name: 'RunOwnerMismatchError' });
    expect(await footprint(j, 'own')).toEqual(before);
  });

  it('a run deleted while a step is in flight: that step writes nothing back, and the run reads as deleted, not completed', async () => {
    const { storage } = await make();
    const j = toJournal(storage.runs) as any;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const wf = workflow<any>()
      .then(step('a', async () => 'a-out'))
      .then(step('b', async () => { await gate; return 'ayse-iban-TR55'; }))
      .then(step('c', async () => 'never'));
    const running = wf.runResumable({}, { runId: 'live', journal: j, identity: ayse('live') }, { workflowName: 'w' }).then((r) => r.status, (e) => e?.name);
    for (let i = 0; i < 100 && (await j.get('live:wf:a')) === undefined; i++) await sleep(5);
    await purgeRun(j, 'live');
    expect(await j.get(runFenceKey('live'))).toBeDefined();
    release();
    expect(await running).toBe('RunErasedError');
    expect(await footprint(j, 'live')).toEqual([]);
  });

  it('a deleted id is not begun again: refused before anything is written', async () => {
    const { storage } = await make();
    const j = toJournal(storage.runs) as any;
    const wf = workflow<any>().then(step('s', async () => 1));
    await wf.run({}, { runId: 'gone', journal: j, identity: ayse('gone') });
    await purgeRun(j, 'gone');
    await expect(wf.run({}, { runId: 'gone', journal: j, identity: bora('gone') })).rejects.toMatchObject({ name: 'RunErasedError' });
    expect(await footprint(j, 'gone')).toEqual([]);
  });

  it('CONTROL — the owner continues their own run, and a run nobody deleted completes', async () => {
    const { storage } = await make();
    const j = toJournal(storage.runs) as any;
    let n = 0;
    const wf = workflow<any>().then(step('s', async () => ++n));
    expect(await wf.run({}, { runId: 'mine', journal: j, identity: ayse('mine') })).toBe(1);
    expect(await wf.run({}, { runId: 'mine', journal: j, identity: ayse('mine') })).toBe(1);
    expect(await wf.runResumable({}, { runId: 'mine', journal: j, identity: { kind: 'staff', runId: 'mine' } })).toEqual({ status: 'completed', output: 1 });
    expect(n).toBe(1);
  });
});
