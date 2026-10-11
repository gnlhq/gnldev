// What a thread, a run and a person own — and every path that deletes or moves them takes exactly that.
//
// Before C+ step C the list of "what goes with a thread" was kept in eight places, and they had drifted
// (measured on 35b70348, the same world on InMemory, Sqlite, pg-mem and real Postgres —
// raporlar/…/ekler/cplus-c/h5-before-analysis.txt):
//  - deleting a thread (MemoryStore.deleteThread, AgentMemory.deleteThread, Studio DELETE /threads/:id)
//    removed its memory-store rows and nothing else: its 6 runs and their 46 journal keys (prompts,
//    tool arguments, the approval waiting on it), its observer summaries (`om:`), its idempotency
//    window (`xthr:`), its owner record and its observation vector all stayed;
//  - purgeThread removed exactly the journal half and nothing else: the messages stayed;
//  - only eraseSubject reached all of it, through a third list of its own;
//  - adoptIntoOrg: on InMemory the adopted threads kept their old id inside the record, so the
//    organization listed none of them and read none of their messages; on Sqlite it moved a platform
//    meta key (`__eeuser__:…`) into the organization; the three stores reported different skipped keys.
//
// The promises held here, on every store:
//  P1 deleting a thread takes its runs and everything the thread owns — and nothing else;
//  P2 every door that deletes a thread leaves the same store;
//  P3 an erasure is the person's threads' deletion plus their own records — nothing of anyone else;
//  P4 organizations: a root delete never touches an organization's data, nor the reverse;
//  P5 a thread with a run in flight is refused, untouched, until the run is canceled or the caller says so;
//  P6 a deletion killed half-way leaves the thread gated by its owner and finishes when run again;
//  P7 exactly-once: a cross-run claim a deleted run made still answers every run that remains;
//  P8 adoptIntoOrg moves the same things on every store;
//  P9 for the same world, each path leaves the same store on InMemory, Sqlite, pg-mem and real Postgres.
import { describe, it, expect, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import {
  eraseSubject, purgeThread, purgeRun, toJournal, withOrg, user, admitThreadRun, cancelAgentRun, ORG_RECORD_PRE, threadOwnerKey,
  ThreadRunsInFlightError,
} from '@gnldev/durable';
import { KINDS, makeBackend, closeBackends, bothWorlds, world, dump, portable, scopeOf, effects, type Backend } from './dependents-world.js';

afterAll(closeBackends);

/** The runs that live on thread t-a in the world: four turns, the fork, the rollover, and r-a1's sub-agent. */
const THREAD_RUNS = ['r-a1', 'r-a1f', 'r-a1n', 'r-a2', 'r-a4', 'agent:r-a1:c-agent_w'];
/** ayse's runs on no thread. */
const PERSON_RUNS = ['r-a3', 'agent:r-a3:c-agent_w'];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Everything in a dump that belongs to one of these runs, in scope `p` ('' or 'org:acme:'). */
const ofRuns = (runs: string[], p: string) => (x: string) => runs.some((r) => {
  const id = esc(`${p}${r}`);
  return new RegExp(`^j ${id}:`).test(x) || new RegExp(`^j ${esc(p)}__metrics__(run|done):${esc(r)}$`).test(x)
    || new RegExp(`^(run|row runs) ${id} `).test(x);
});
/** Everything thread t-a owns in scope `p`: its runs, its journal state, its owner record, its memory-store rows, its observation vector. */
const threadFootprint = (p: string) => {
  const runs = ofRuns(THREAD_RUNS, p);
  const t = esc(`${p}t-a`);
  const own = new RegExp(`^(j ${esc(p)}(mem|om|sem|xthr):t-a:|j ${esc(p)}thread:t-a:(owner|seen)$|(thread|messages|observations) ${t}$|wm ${esc(p)}thread:t-a$|row (messages|obs|batches) ${t}$|row wm ${esc(p)}thread:t-a$|row threads ${t} .* live$|(vec|row vectors) ${esc(p)}om:t-a:)`);
  const view = p ? new RegExp(`^view ${p.slice(4, -1)} (lists thread|reads messages) t-a$`) : /^$/;
  return (x: string) => runs(x) || own.test(x) || view.test(x);
};
/** What is ayse's own beside her threads: her thread-less runs, her person-keyed records, working memory, document and job. */
const personFootprint = (p: string) => {
  const runs = ofRuns(PERSON_RUNS, p);
  const org = p ? p.slice(4, -1) : '';
  const own = new RegExp(`^(j ${esc(p)}(lesson|xid):res:ayse:|wm ${esc(p)}resource:ayse$|row wm ${esc(p)}resource:ayse$|(vec|row vectors) ${esc(p)}doc-a |(work|row worklog) jobs ~o~${org}:ayse:)`);
  return (x: string) => runs(x) || own.test(x);
};
/**
 * The fence a deletion leaves for each run it takes (durable's erasure-fence.ts): a hash of the run id
 * under `__run_erased__:`, in the run's scope — so a worker still running it writes nothing back.
 */
const fenceOf = (runs: string[], p: string) => (x: string) =>
  runs.some((r) => x === `j ${p}__run_erased__:${createHash('sha256').update(r).digest('hex')}`);
/** The one row a thread delete adds: the record's tombstone (a soft delete that keeps no title). */
const tombstone = (p: string) => (x: string) => new RegExp(`^row threads ${esc(p)}t-a .* deleted$`).test(x);

async function after(b: Backend, f: () => Promise<unknown>): Promise<{ before: string[]; after: string[]; removed: string[]; added: string[] }> {
  const before = await dump(b);
  await f();
  const a = await dump(b);
  return { before, after: a, removed: before.filter((x) => !a.includes(x)), added: a.filter((x) => !before.includes(x)) };
}

for (const kind of KINDS) {
  describe(`dependents — ${kind}`, () => {
    it('P1: deleting a thread takes its runs and everything the thread owns — and nothing else', async () => {
      const b = await makeBackend(kind);
      await bothWorlds(b.storage);
      const d = await after(b, () => scopeOf(b.storage).memory.deleteThread('t-a'));
      expect(d.removed.sort()).toEqual(d.before.filter(threadFootprint('')).sort());
      expect(d.added.filter((x) => !tombstone('')(x) && !fenceOf(THREAD_RUNS, '')(x))).toEqual([]);
      // Nothing of t-a is readable any more, by run or by thread.
      const J = toJournal(b.storage.runs);
      for (const r of THREAD_RUNS) expect(await J.get(`${r}:input`), r).toBeUndefined();
      // (A root listing names every organization's runs too; acme's t-a is another thread.)
      expect((await J.listRunsPaged!({ threadId: 't-a', limit: 50 })).items.filter((r) => !r.runId.startsWith('org:'))).toEqual([]);
    }, 120_000);

    it('P2: every door that deletes a thread leaves the same store', async () => {
      const viaMemory = await makeBackend(kind);
      await bothWorlds(viaMemory.storage);
      await scopeOf(viaMemory.storage).memory.deleteThread('t-a');
      const viaPurge = await makeBackend(kind);
      await bothWorlds(viaPurge.storage);
      await purgeThread(toJournal(viaPurge.storage.runs), 't-a', { memory: viaPurge.storage.memory!, vectors: viaPurge.storage.vectors! });
      expect(await dump(viaPurge)).toEqual(await dump(viaMemory));
      // A journal-only purge (BasicMemory keeps the thread in the journal) takes the same journal half.
      const journalOnly = await makeBackend(kind);
      await bothWorlds(journalOnly.storage);
      await purgeThread(toJournal(journalOnly.storage.runs), 't-a');
      const journalHalf = (d: string[]) => d.filter((x) => /^(j |run |row runs )/.test(x));
      expect(journalHalf(await dump(journalOnly))).toEqual(journalHalf(await dump(viaMemory)));
    }, 180_000);

    it('P3: an erasure is the person\'s threads\' deletion plus their own records — nothing of anyone else', async () => {
      const b = await makeBackend(kind);
      await bothWorlds(b.storage);
      const d = await after(b, () => eraseSubject(b.storage, 'ayse'));
      const mine = (x: string) => threadFootprint('')(x) || personFootprint('')(x);
      expect(d.removed.sort()).toEqual(d.before.filter(mine).sort());
      expect(d.added.filter((x) => !tombstone('')(x) && !fenceOf([...THREAD_RUNS, ...PERSON_RUNS], '')(x))).toEqual([]);
    }, 120_000);

    it('P4: a root thread delete never touches an organization, and an organization\'s never the root', async () => {
      const b = await makeBackend(kind);
      await bothWorlds(b.storage);
      const org = await after(b, () => scopeOf(b.storage, 'acme').memory.deleteThread('t-a'));
      expect(org.removed.sort()).toEqual(org.before.filter(threadFootprint('org:acme:')).sort());
      expect(org.added.filter((x) => !tombstone('org:acme:')(x) && !fenceOf(THREAD_RUNS, 'org:acme:')(x))).toEqual([]);
      // The root's t-a, on a world where acme's t-a (the same id, and runs that name it) is still whole.
      const r = await makeBackend(kind);
      await bothWorlds(r.storage);
      const root = await after(r, () => scopeOf(r.storage).memory.deleteThread('t-a'));
      expect(root.removed.filter((x) => x.includes('org:acme') || x.includes('~o~acme'))).toEqual([]);
      // …and erasing acme's ayse leaves the root's ayse whole.
      const c = await makeBackend(kind);
      await bothWorlds(c.storage);
      const e = await after(c, () => eraseSubject(c.storage, 'ayse', { orgId: 'acme' }));
      const acmeAyse = (x: string) => threadFootprint('org:acme:')(x) || personFootprint('org:acme:')(x);
      expect(e.removed.sort()).toEqual(e.before.filter(acmeAyse).sort());
    }, 180_000);

    it('P5: a thread with a run in flight is refused and left whole — until the run is canceled, or the caller allows it', async () => {
      const b = await makeBackend(kind);
      await world(b.storage);
      const J = toJournal(b.storage.runs);
      // r-a4 back in flight: its write-ahead outcome, as a turn that is still executing leaves it. (An
      // early `at`: the cancel below must be the newer verdict, and pg-mem's clock is not this process's.)
      await J.put('r-a4:outcome', { status: 'running', at: 1 });
      const before = await dump(b);
      const memory = scopeOf(b.storage).memory;
      const err = await memory.deleteThread('t-a').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ThreadRunsInFlightError);
      expect((err as ThreadRunsInFlightError).runIds).toEqual(['r-a4']);
      await expect(purgeThread(J, 't-a')).rejects.toBeInstanceOf(ThreadRunsInFlightError);
      expect(await dump(b)).toEqual(before);
      // The way out the error names: cancel the run, then delete.
      await cancelAgentRun(J as any, 'r-a4', { reason: 'operator' });
      await memory.deleteThread('t-a');
      expect((await J.listRunsPaged!({ threadId: 't-a', limit: 50 })).items).toEqual([]);
      // …or say the run is abandoned.
      const c = await makeBackend(kind);
      await world(c.storage);
      await toJournal(c.storage.runs).put('r-a4:outcome', { status: 'running', at: 1 });
      await scopeOf(c.storage).memory.deleteThread('t-a', { allowInFlight: true });
      expect((await toJournal(c.storage.runs).listRunsPaged!({ threadId: 't-a', limit: 50 })).items).toEqual([]);
      // A canceled run still inside a step (its tool claimed `running`) is in flight too: the step
      // finishes before the cancel takes effect, and would write into the deleted thread.
      const d = await makeBackend(kind);
      await world(d.storage);
      const Jd = toJournal(d.storage.runs);
      // (r-a2: it was waiting on an approval, so the cancel is its outcome; a completed run's is not.)
      await cancelAgentRun(Jd as any, 'r-a2', { reason: 'operator' });
      await Jd.put('r-a2:tool:c-slow', { status: 'running', startedAt: 1 });
      const err2 = await scopeOf(d.storage).memory.deleteThread('t-a').catch((e: unknown) => e);
      expect((err2 as ThreadRunsInFlightError).runIds).toEqual(['r-a2']);
    }, 180_000);

    it('P6: a deletion killed half-way keeps the thread gated by its owner, and the next attempt finishes it', async () => {
      const clean = await makeBackend(kind);
      await world(clean.storage);
      await scopeOf(clean.storage).memory.deleteThread('t-a');
      const done = portable(await dump(clean));
      // Every point the deletion can die at: count its store calls once, then kill it at each.
      const calls = await countDeleteCalls(kind);
      const points = kind === 'InMemory' || kind === 'Sqlite' ? [...Array(calls).keys()] : [0, Math.floor(calls / 2), calls - 1];
      for (const k of points) {
        const b = await makeBackend(kind);
        await world(b.storage);
        const undo = killAt(b, k);
        await expect(scopeOf(b.storage).memory.deleteThread('t-a'), `crash point ${k}`).rejects.toThrow(/killed/);
        undo();
        const J = toJournal(b.storage.runs);
        const left = (await dump(b)).filter(threadFootprint(''));
        if (left.length > 0) {
          // Something of the thread is still there, so its owner record must be too: no one else can open it.
          expect(await J.get(threadOwnerKey('t-a')), `crash point ${k}: ${left.slice(0, 3).join(', ')}`).toBeDefined();
          await expect(admitThreadRun(J, undefined, 't-a', user('mallory')), `crash point ${k}`).rejects.toThrow(/belongs to/);
        }
        await scopeOf(b.storage).memory.deleteThread('t-a');
        expect(portable(await dump(b)), `crash point ${k}`).toEqual(done);
      }
    }, 600_000);

    it('P10: a run purge killed half-way subtracts its usage once — the retry never subtracts it again', async () => {
      const usage = async (b: Backend) => (await (toJournal(b.storage.runs) as any).getCounters('__usage__'))?.runs;
      const clean = await makeBackend(kind);
      await world(clean.storage);
      const before = await usage(clean);
      await purgeRun(toJournal(clean.storage.runs) as any, 'r-a1');
      const expected = await usage(clean);
      expect(expected).toBe(before - 2); // r-a1 and its sub-agent were counted
      const calls = await countCalls(kind, (b) => purgeRun(toJournal(b.storage.runs) as any, 'r-a1'));
      const points = kind === 'InMemory' || kind === 'Sqlite' ? [...Array(calls).keys()] : [0, 1, Math.floor(calls / 2)];
      for (const k of points) {
        const b = await makeBackend(kind);
        await world(b.storage);
        const undo = killAt(b, k);
        await expect(purgeRun(toJournal(b.storage.runs) as any, 'r-a1'), `crash point ${k}`).rejects.toThrow(/killed/);
        undo();
        await purgeRun(toJournal(b.storage.runs) as any, 'r-a1');
        expect(await usage(b), `crash point ${k}`).toBe(expected);
      }
    }, 600_000);

    it('P11: an erasure killed half-way finishes when the request is retried — nothing of her outlives the retry', async () => {
      const clean = await makeBackend(kind);
      await world(clean.storage);
      await eraseSubject(clean.storage, 'ayse');
      const done = portable(await dump(clean));
      const calls = await countCalls(kind, (b) => eraseSubject(b.storage, 'ayse'));
      const points = kind === 'InMemory' || kind === 'Sqlite' ? [...Array(calls).keys()] : [0, Math.floor(calls / 3), Math.floor((2 * calls) / 3), calls - 1];
      for (const k of points) {
        const b = await makeBackend(kind);
        await world(b.storage);
        const undo = killAt(b, k);
        await expect(eraseSubject(b.storage, 'ayse'), `crash point ${k}`).rejects.toThrow(/killed/);
        undo();
        await eraseSubject(b.storage, 'ayse');
        expect(portable(await dump(b)), `crash point ${k}`).toEqual(done);
      }
    }, 900_000);

    it('P7: a cross-run claim made by a run of the deleted thread still answers the runs that remain — the effect does not fire twice', async () => {
      const b = await makeBackend(kind);
      const { gnl, journal } = scopeOf(b.storage);
      effects.charge = 0;
      await gnl.run('main', { runId: 'r-c1', prompt: 'CHARGE', threadId: 't-c', caller: user('ayse') });
      expect(effects.charge).toBe(1);
      const claims = await journal.listKeys!('xrun:');
      expect(claims.length).toBeGreaterThan(0);
      await scopeOf(b.storage).memory.deleteThread('t-c');
      expect(await journal.get('r-c1:input')).toBeUndefined();
      expect(await journal.listKeys!('xrun:')).toEqual(claims);
      // Another person, another thread, the same work: answered from the claim, not executed again.
      await gnl.run('main', { runId: 'r-c2', prompt: 'CHARGE', threadId: 't-d', caller: user('bob') });
      expect(effects.charge).toBe(1);
    }, 120_000);

    it('P8: adoptIntoOrg moves the same things on every store — the organization reads what it adopted, and platform keys stay', async () => {
      const b = await makeBackend(kind);
      await bothWorlds(b.storage);
      await toJournal(b.storage.runs).put(`${ORG_RECORD_PRE}acme2`, { id: 'acme2' });
      const report = await (b.storage as any).adoptIntoOrg('acme2', { allowInFlight: true });
      const d = await dump(b);
      expect(d).toEqual(expect.arrayContaining([
        'view acme2 lists thread t-a', 'view acme2 lists thread t-b', 'view acme2 reads messages t-a', 'view acme2 reads messages t-b',
        'row meta __eeuser__:u1', 'row meta org:acme2:app-setting',
      ]));
      expect(d.filter((x) => x.startsWith('row meta '))).toEqual(['row meta __eeuser__:u1', 'row meta org:acme2:app-setting']);
      expect(report.skippedPlatformKeys).toEqual(['__eeuser__', '__org__']);
    }, 120_000);
  });
}

describe('P9: for the same world, each path leaves the same store on every store', () => {
  const PATHS: Array<[string, (b: Backend) => Promise<unknown>]> = [
    ['AgentMemory.deleteThread(t-a)', (b) => scopeOf(b.storage).memory.deleteThread('t-a')],
    ['acme AgentMemory.deleteThread(t-a)', (b) => scopeOf(b.storage, 'acme').memory.deleteThread('t-a')],
    ['purgeThread(t-a)', (b) => purgeThread(toJournal(b.storage.runs), 't-a')],
    ['acme purgeThread(t-a)', (b) => purgeThread(withOrg(toJournal(b.storage.runs), 'acme'), 't-a')],
    ['purgeRun(r-a1)', (b) => purgeRun(toJournal(b.storage.runs) as any, 'r-a1')],
    ['eraseSubject(ayse)', (b) => eraseSubject(b.storage, 'ayse')],
    ['eraseSubject(ayse, acme)', (b) => eraseSubject(b.storage, 'ayse', { orgId: 'acme' })],
    ['adoptIntoOrg(acme2)', async (b) => { await toJournal(b.storage.runs).put(`${ORG_RECORD_PRE}acme2`, { id: 'acme2' }); return (b.storage as any).adoptIntoOrg('acme2', { allowInFlight: true }); }],
  ];
  for (const [name, path] of PATHS) {
    it(name, async () => {
      const dumps: Record<string, string[]> = {};
      for (const kind of KINDS) {
        const b = await makeBackend(kind);
        await bothWorlds(b.storage);
        await path(b);
        dumps[kind] = portable(await dump(b));
      }
      // As the two differences, so a failure names the rows rather than two 260-line arrays.
      for (const kind of KINDS) {
        expect({ [`only on ${kind}`]: dumps[kind]!.filter((x) => !dumps.InMemory!.includes(x)), 'only on InMemory': dumps.InMemory!.filter((x) => !dumps[kind]!.includes(x)) })
          .toEqual({ [`only on ${kind}`]: [], 'only on InMemory': [] });
      }
    }, 300_000);
  }
});

/**
 * Kills the k-th store call a thread deletion makes (journal deletes and memory-store deletes, in the
 * order they happen) by throwing, as a process dying there would leave it. Returns the undo.
 */
function killAt(b: Backend, k: number): () => void {
  let n = 0;
  const targets: Array<[any, string]> = [[b.storage.runs, 'deletePrefix'], [b.storage.memory, 'deleteThread'], [b.storage.vectors, 'delete']];
  const saved = targets.map(([o, m]) => [o, m, o[m]] as const);
  for (const [o, m, f] of saved) {
    o[m] = async (...a: unknown[]) => {
      if (n++ === k) throw new Error(`killed at store call ${k} (${m})`);
      return f.apply(o, a);
    };
  }
  return () => { for (const [o, m] of saved) delete o[m]; };
}
/** How many store calls `f` makes in the world (journal deletes, memory-store deletes, vector deletes). */
async function countCalls(kind: string, f: (b: Backend) => Promise<unknown>): Promise<number> {
  const b = await makeBackend(kind);
  await world(b.storage);
  let n = 0;
  const targets: Array<[any, string]> = [[b.storage.runs, 'deletePrefix'], [b.storage.memory, 'deleteThread'], [b.storage.vectors, 'delete']];
  for (const [o, m] of targets) { const g = o[m]; o[m] = async (...a: unknown[]) => { n++; return g.apply(o, a); }; }
  await f(b);
  return n;
}
/** How many store calls one thread deletion makes in the world. */
const countDeleteCalls = (kind: string) => countCalls(kind, (b) => scopeOf(b.storage).memory.deleteThread('t-a'));
