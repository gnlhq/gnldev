/**
 * `@gnldev/durable/testing` — the scenarios a `Journal` has to pass, for any journal: the three stores
 * shipped here and one you write yourself (ADR-0007 decision 6).
 *
 * WHY. What the engine asks of a journal is more than its method signatures: a `putIfAbsent` that two
 * workers race on must let exactly one win (exactly-once rests on it), a prefix must be a prefix and not
 * a SQL pattern, a run's status must follow one precedence, a person's runs must be found whether or not
 * an older writer placed them, and a thread delete must take what the model (`model.ts`) says it owns
 * and nothing else. Those promises were tested inside this repository only, on its own stores — so a
 * fourth store, or a fifth written by a user, had no way to learn it had broken one. Four copies of the
 * query code stay (one per adapter, ADR-0007 "accepted trade-offs"); this suite is what catches them
 * drifting apart.
 *
 * SHAPE. One function registers the scenarios with the caller's test runner: it takes `describe` and
 * `it`, and asserts with `node:assert`, so vitest, jest, mocha and `node:test` all run it and none of
 * them is a dependency of this package. A scenario gets a fresh journal from `make` and closes it after.
 *
 * WHAT IS NOT HERE. Scenarios that need a memory store, a vector store or the agent engine (an
 * `AgentMemory` thread delete, `eraseSubject` over a whole `Storage`, adoption) stay in the packages
 * that own them; everything below is expressed on the journal alone.
 */
import assert from 'node:assert/strict';
import type { Journal, JournalReader, RunSummary, RunStatus, RunListQuery } from './journal.js';
import { claim, parseJournalKey, runIdOfKey, outcomeStatusOf, deriveRunStatus, isOwnerRecordKey, ownerOfRecord, nestedAgentRunId, runKeys } from './journal.js';
import { stampFormat } from './format.js';
import { withOrg, ORG_RECORD_PRE } from './organization.js';
import { threadOwnerKey, threadSeenKey } from './thread-owner.js';
import { memKey, semanticLogKey } from './memory.js';
import { metricsRunKey } from './metrics.js';
import { purgeThread, purgeRun, purgeResource } from './retention.js';
import { ThreadRunsInFlightError } from './errors.js';
import { refuseUnknownNames } from '@gnldev/options';
import { JOURNAL_CONFORMANCE_NAMES } from './option-names.js';

/** The journal under test: the `Journal` port, with the `JournalReader` surface the run scenarios read. */
export type ConformanceJournal = Journal & Partial<JournalReader>;

/** What `make` hands each scenario. */
export interface ConformanceSubject {
  /** A new, EMPTY journal. Each scenario gets its own. */
  journal: ConformanceJournal;
  /**
   * Write one key the way an EARLIER version of this store wrote it — for a store that keeps derived
   * columns (Sqlite's and Postgres's relation columns), a write that does not fill them, so the row is
   * "not placed yet". Every lookup must still find it. Leave it out when every writer of your store
   * writes the same way (the scenarios then write through `put`).
   */
  writeAsOlderVersion?(key: string, value: unknown): Promise<void>;
  /** Called when the scenario ends, passed or not. */
  close?(): Promise<void> | void;
}

/** The test runner's registration functions, and what the scenarios may assume of the store. */
export interface JournalConformanceOptions {
  /** Your runner's `describe` (vitest, jest, mocha, `node:test`). */
  describe: (name: string, fn: () => void) => unknown;
  /** Your runner's `it`; `timeout` is passed as its third argument. */
  it: (name: string, fn: () => Promise<void>, timeout?: number) => unknown;
  /** Per-scenario timeout in ms, handed to `it`. */
  timeout?: number;
  /**
   * `false` only for a test double that cannot report a lost `putIfAbsent` (pg-mem answers `true` to
   * `INSERT … ON CONFLICT DO NOTHING` either way). The value is still checked; the boolean is not. A
   * real store that needs this cannot give exactly-once.
   */
  exactClaim?: boolean;
  /**
   * `false` only for a test double that cannot read a second page of a run list (pg-mem cannot compare
   * rows, which the keyset cursor needs). Listings are then read in one page.
   */
  pageWalk?: boolean;
}

/**
 * Register the journal conformance scenarios under `describe(\`journal conformance — ${name}\`)`.
 *
 * ```ts
 * import { describe, it } from 'vitest';
 * import { journalConformance } from '@gnldev/durable/testing';
 * journalConformance('my KV store', () => ({ journal: new MyJournal() }), { describe, it });
 * ```
 */
export function journalConformance(
  name: string,
  make: () => ConformanceSubject | Promise<ConformanceSubject>,
  opts: JournalConformanceOptions,
): void {
  refuseUnknownNames('journalConformance', opts, JOURNAL_CONFORMANCE_NAMES);
  const exactClaim = opts.exactClaim !== false;
  const pageWalk = opts.pageWalk !== false;
  const scenario = (title: string, body: (s: Subject) => Promise<void>) => opts.it(title, async () => {
    const made = await make();
    const s: Subject = { ...made, older: made.writeAsOlderVersion ? (k, v) => made.writeAsOlderVersion!(k, v) : (k, v) => made.journal.put(k, v), pageWalk };
    try { await body(s); } finally { await made.close?.(); }
  }, opts.timeout);

  opts.describe(`journal conformance — ${name}`, () => {
    // ── The key-value contract ───────────────────────────────────────────────────────────────────
    scenario('K1 get/put: a value reads back as written, an overwrite replaces it, a missing key is undefined', async ({ journal: j }) => {
      const v = { s: 'x', n: 1.5, b: true, nested: { a: [1, 'two', { three: null }] } };
      await j.put('k1:a', v);
      assert.deepEqual(await j.get('k1:a'), v);
      await j.put('k1:a', { s: 'y' });
      assert.deepEqual(await j.get('k1:a'), { s: 'y' });
      await j.put('k1:list', [1, 2, 3]);
      assert.deepEqual(await j.get('k1:list'), [1, 2, 3]);
      await j.put('k1:str', 'text');
      assert.equal(await j.get('k1:str'), 'text');
      assert.equal(await j.get('k1:missing'), undefined);
    });

    scenario('K2 exactly-once claim: one of many racing claims wins, the rest see it lost, and the winner\'s value stays', async ({ journal: j }) => {
      assert.equal(typeof j.putIfAbsent, 'function', 'putIfAbsent is what makes a claim atomic; without it `claim()` is get→put, safe in one process only');
      assert.equal(await j.putIfAbsent!('k2:once', 1), true);
      const again = await j.putIfAbsent!('k2:once', 2);
      if (exactClaim) assert.equal(again, false);
      assert.equal(await j.get('k2:once'), 1);
      // Racing: every caller at once, as workers resuming the same step would.
      const won = await Promise.all(Array.from({ length: 16 }, (_, i) => claim(j, 'k2:race', { by: i })));
      const winners = won.flatMap((w, i) => (w ? [i] : []));
      if (exactClaim) {
        assert.equal(winners.length, 1, `exactly one claim wins, got ${winners.length}`);
        assert.deepEqual(await j.get('k2:race'), { by: winners[0] });
      }
      const kept = await j.get<{ by: number }>('k2:race');
      assert.ok(kept && Number.isInteger(kept.by), 'one claimant\'s value is kept whole');
    });

    scenario('K3 putIfMatch: a matching record is replaced, a stale or missing one is not touched', async ({ journal: j }) => {
      if (typeof j.putIfMatch !== 'function') return; // optional: run-lock falls back to get→put
      const stale = { owner: 'A', expires: 1000, token: 'tok-a' };
      const fresh = { owner: 'B', expires: 99_000, token: 'tok-b' };
      await j.put('k3:lock', stale);
      // What the run lock hands back: the record as read, after a round trip through the store.
      assert.equal(await j.putIfMatch('k3:lock', await j.get('k3:lock'), fresh), true);
      assert.deepEqual(await j.get('k3:lock'), fresh);
      assert.equal(await j.putIfMatch('k3:lock', stale, { owner: 'C' }), false);
      assert.deepEqual(await j.get('k3:lock'), fresh);
      assert.equal(await j.putIfMatch('k3:missing', stale, fresh), false);
      assert.equal(await j.get('k3:missing'), undefined);
    });

    scenario('K4 listKeys/deletePrefix: a prefix is literal text — no pattern characters, no case folding, no neighbour', async ({ journal: j }) => {
      assert.equal(typeof j.listKeys, 'function', 'listKeys is how purges, sweeps and the dependents model find keys');
      assert.equal(typeof j.deletePrefix, 'function', 'deletePrefix is the one deletion the dependents model runs');
      const keys = ['p:a', 'p:a:b', 'p:ab', 'p_a', 'p%a', 'P:a', 'p:\\x', 'q:a', 'r-1:model:0', 'r-10:model:0'];
      for (const k of keys) await j.put(k, { k });
      const sorted = async (p: string) => (await j.listKeys!(p)).sort();
      assert.deepEqual(await sorted('p:a'), ['p:a', 'p:a:b', 'p:ab']);
      assert.deepEqual(await sorted('p_'), ['p_a'], "'_' is a character, not a wildcard");
      assert.deepEqual(await sorted('p%'), ['p%a'], "'%' is a character, not a wildcard");
      assert.deepEqual(await sorted('p:\\'), ['p:\\x'], "'\\' is a character, not an escape");
      assert.deepEqual(await sorted('P:'), ['P:a'], 'a prefix keeps case');
      assert.deepEqual(await sorted('r-1:'), ['r-1:model:0'], "run r-1's prefix does not reach r-10");
      assert.deepEqual(await sorted(''), [...keys].sort());
      const probe = await j.listKeys!('p:', { limit: 1 });
      assert.ok(probe.length <= 1 && probe.every((k) => k.startsWith('p:')), 'a limited listing is a bounded probe of the prefix');
      assert.equal(await j.deletePrefix!('p_'), 1);
      assert.equal(await j.deletePrefix!('p:a:'), 1);
      assert.equal(await j.deletePrefix!('r-1:'), 1);
      assert.deepEqual((await j.listKeys!('')).sort(), ['P:a', 'p%a', 'p:\\x', 'p:a', 'p:ab', 'q:a', 'r-10:model:0']);
    });

    scenario('K5 counters: increments are exact under a race, a negative one subtracts, and deletePrefix takes them', async ({ journal: j }) => {
      if (typeof j.incrBy !== 'function' || typeof j.getCounters !== 'function') return; // optional: budgets fall back to get→put
      const after = await Promise.all(Array.from({ length: 16 }, () => j.incrBy!('k5:org:acme:__usage__', { runs: 1 })));
      assert.deepEqual(await j.getCounters('k5:org:acme:__usage__'), { runs: 16 });
      // A store that hands back the new value hands back each one once (limits take a share by it).
      if (after.every((r) => r !== undefined)) assert.deepEqual(after.map((r) => (r as Record<string, number>).runs).sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i + 1));
      await j.incrBy('k5:org:acme:__usage__', { runs: -6, costUsd: 1.5 });
      assert.deepEqual(await j.getCounters('k5:org:acme:__usage__'), { runs: 10, costUsd: 1.5 });
      await j.incrBy('k5:org:other:__usage__', { runs: 7 });
      await j.put('k5:org:acme:r1:input', { p: 'x' });
      await j.deletePrefix?.('k5:org:acme:');
      assert.equal(await j.getCounters('k5:org:acme:__usage__'), undefined, 'a counter is a key: an organization\'s purge takes its usage');
      assert.equal(await j.get('k5:org:acme:r1:input'), undefined);
      assert.deepEqual(await j.getCounters('k5:org:other:__usage__'), { runs: 7 });
    });

    scenario('K6 applyBatch and getMany: a claimed batch applies once, all of it or none; getMany keeps order', async ({ journal: j }) => {
      if (typeof j.applyBatch === 'function') {
        const batch = { claim: { key: 'k6:claim', value: { at: 1 } }, incrs: [{ key: 'k6:ctr', fields: { runs: 1, tokens: 10 } }], puts: [{ key: 'k6:row', value: { v: 1 } }] };
        assert.equal(await j.applyBatch(batch), true);
        assert.deepEqual(await j.get('k6:row'), { v: 1 });
        assert.deepEqual(await j.getCounters?.('k6:ctr'), j.getCounters ? { runs: 1, tokens: 10 } : undefined);
        const second = await j.applyBatch({ ...batch, puts: [{ key: 'k6:row', value: { v: 2 } }] });
        if (exactClaim) {
          assert.equal(second, false);
          assert.deepEqual(await j.get('k6:row'), { v: 1 }, 'a lost claim writes nothing');
          if (j.getCounters) assert.deepEqual(await j.getCounters('k6:ctr'), { runs: 1, tokens: 10 }, 'a lost claim counts nothing');
        }
        assert.equal(await j.applyBatch({ incrs: [{ key: 'k6:nb', fields: { n: 1 } }] }), true);
        assert.equal(await j.applyBatch({ incrs: [{ key: 'k6:nb', fields: { n: 1 } }] }), true);
        if (j.getCounters) assert.deepEqual(await j.getCounters('k6:nb'), { n: 2 }, 'a batch with no claim always applies');
      }
      if (typeof j.getMany === 'function') {
        await j.put('k6:a', { v: 1 });
        await j.put('k6:c', { v: 3 });
        assert.deepEqual(await j.getMany(['k6:a', 'k6:b', 'k6:c']), [{ v: 1 }, undefined, { v: 3 }]);
      }
    });

    // ── Runs: what makes one, what it reports, its status ────────────────────────────────────────
    scenario('R1 a run is what its records name: a step, a tool call, a stamped :input, an outcome — never a neighbour or a look-alike', async ({ journal: j }) => {
      const reader = requireReader(j);
      await j.put('m1:model:0', { text: 'a step' });
      await j.put('t1:tool:c1', { status: 'succeeded', output: 1 });
      await j.put('i1:input', stampFormat({ at: 1, resourceId: 'ayse' }));
      await j.put('o1:outcome', { status: 'canceled', at: 1 }); // canceled before it started: the outcome is all there is
      await j.put('r9:input', stampFormat({ at: 1 }));
      await j.put('r9:tool:call:input', stampFormat({ at: 1, status: 'ok' })); // r9's tool record, not the input of a run 'r9:tool:call'
      await j.put('plain:input', { prompt: 'unstamped' }); // a caller's payload under the same suffix
      await j.put('log:outcome', { text: 'an appendLog record named outcome' });
      await j.put('r-1:model:0', { text: 'one' });
      await j.put('r-10:model:0', { text: 'ten' });
      assert.deepEqual((await listAll(reader, {}, pageWalk)).map((r) => r.runId).sort(), ['i1', 'm1', 'o1', 'r-1', 'r-10', 'r9', 't1'].sort());
      assert.deepEqual((await reader.readRun('r-1')).map((e) => e.key), ['r-1:model:0']);
      assert.deepEqual((await reader.readRun('r9')).map((e) => e.key), ['r9:tool:call:input']);
      assert.deepEqual(await reader.readRun('i1'), [], 'a run with only its :input has no entries');
    });

    scenario('R2 a run\'s summary: counts, and who/where/which agent from its :input; readRun in write order, one entry per key', async ({ journal: j }) => {
      const reader = requireReader(j);
      await j.put('rs:input', stampFormat({ at: 1, prompt: 'hi', threadId: 'th-9', agent: 'starwars', resourceId: 'u-a', workKey: 'invoice-4', parentRunId: 'rp' }));
      await j.put('rs:model:0', { text: 'a' });
      await j.put('rs:tool:t1', { status: 'running', startedAt: 1 });
      await j.put('rs:model:1', { text: 'b' });
      await j.put('rs:tool:t1', { status: 'succeeded', output: 1 }); // an overwrite: still one tool call
      await j.put('bare:model:0', { text: 'no :input' });
      const all = await listAll(reader, {}, pageWalk);
      const rs = all.find((r) => r.runId === 'rs')!;
      assert.deepEqual(
        { status: rs.status, modelSteps: rs.modelSteps, toolCalls: rs.toolCalls, threadId: rs.threadId, agent: rs.agent, resourceId: rs.resourceId, workKey: rs.workKey, parentRunId: rs.parentRunId },
        { status: 'completed', modelSteps: 2, toolCalls: 1, threadId: 'th-9', agent: 'starwars', resourceId: 'u-a', workKey: 'invoice-4', parentRunId: 'rp' },
      );
      const bare = all.find((r) => r.runId === 'bare')!;
      assert.deepEqual([bare.threadId, bare.agent, bare.resourceId, bare.workKey, bare.parentRunId], [undefined, undefined, undefined, undefined, undefined]);
      const entries = await reader.readRun('rs');
      // Ordering (JournalReader.readRun): ascending first-write time. Writes in the same millisecond
      // tie, and how a store breaks a tie is not asserted here (the SQL stores use the key), so only
      // the time order is; a store that keeps no write times must give write order itself.
      assert.deepEqual(entries.map((e) => e.key).sort(), ['rs:model:0', 'rs:model:1', 'rs:tool:t1'], 'one entry per key');
      const entry = (k: string) => entries.find((e) => e.key === k)!;
      if (entries.every((e) => e.ts !== undefined)) {
        const ts = (k: string) => entry(k).ts!;
        assert.ok(entries.every((e, i) => i === 0 || entries[i - 1]!.ts! <= e.ts!), 'ascending by first write');
        assert.ok(ts('rs:model:0') <= ts('rs:tool:t1') && ts('rs:tool:t1') <= ts('rs:model:1'), 'an overwrite keeps its first-write time');
      } else {
        assert.deepEqual(entries.map((e) => e.key), ['rs:model:0', 'rs:tool:t1', 'rs:model:1'], 'write order');
      }
      assert.deepEqual([entry('rs:model:0').kind, entry('rs:tool:t1').kind, entry('rs:model:1').kind], ['model', 'tool', 'model']);
      assert.deepEqual(entry('rs:tool:t1').value, { status: 'succeeded', output: 1 }, 'the entry holds the latest value');
    });

    scenario('R3 status: after every write of a scripted history, every run reads deriveRunStatus of its own records — listed, filtered, counted', async ({ journal: j }) => {
      const reader = requireReader(j);
      const suspendedRec = { status: 'suspended', output: { __gnl_suspend: { toolCallId: 'c1', toolName: 'pay', reason: 'approve' } } };
      const steps: Array<[string, () => Promise<unknown>]> = [
        ['started, then a crash', async () => { await j.put('crashed:input', stampFormat({ at: 1, resourceId: 'ayse' })); await j.put('crashed:outcome', { status: 'running', at: 1 }); }],
        ['suspended', async () => { await j.put('wait:model:0', { text: 'x' }); await j.put('wait:tool:c0', suspendedRec); }],
        ['resumed and completed', async () => { await j.put('wait:tool:c0', { status: 'succeeded', output: 1 }); await j.put('wait:outcome', { status: 'completed', at: 2 }); }],
        ['failed', () => j.put('fail:outcome', { status: 'failed', at: 1, error: '401' })],
        ['canceled after failed', () => j.put('fail:outcome', { status: 'canceled', at: 2 })],
        ['canceled while suspended', async () => { await j.put('cs:tool:c1', suspendedRec); await j.put('cs:outcome', { status: 'canceled', at: 1 }); }],
        ['failed, then suspended', async () => { await j.put('fsr:outcome', { status: 'failed', at: 1 }); await j.put('fsr:tool:c1', suspendedRec); }],
        ['failed, suspended, then resolved', () => j.put('fsr:tool:c1', { status: 'succeeded', output: 1 })],
        ['two approvals pending', async () => { await j.put('two:tool:a', suspendedRec); await j.put('two:tool:b', suspendedRec); }],
        ['one of two resolved', () => j.put('two:tool:a', { status: 'succeeded', output: 1 })],
        ['both resolved', () => j.put('two:tool:b', { status: 'succeeded', output: 2 })],
        ['running replaced by completed (putIfMatch)', async () => {
          await j.put('pim:outcome', { status: 'running', at: 1 });
          if (j.putIfMatch) await j.putIfMatch('pim:outcome', { status: 'running', at: 1 }, { status: 'completed', at: 2 });
        }],
        ['a batch: a suspended claim and a failed outcome', () => (j.applyBatch
          ? j.applyBatch({ claim: { key: 'bat:tool:c1', value: suspendedRec }, puts: [{ key: 'bat:outcome', value: { status: 'failed', at: 1 } }] })
          : Promise.all([j.put('bat:tool:c1', suspendedRec), j.put('bat:outcome', { status: 'failed', at: 1 })]))],
        ['the batch resolves it', () => (j.applyBatch ? j.applyBatch({ puts: [{ key: 'bat:tool:c1', value: { status: 'succeeded', output: 1 } }] }) : j.put('bat:tool:c1', { status: 'succeeded', output: 1 }))],
        ['a takeover suspends a failed run (putIfMatch)', async () => {
          await j.put('tko:outcome', { status: 'failed', at: 1 });
          await j.put('tko:tool:c1', { status: 'running', startedAt: 1 });
          if (j.putIfMatch) await j.putIfMatch('tko:tool:c1', { status: 'running', startedAt: 1 }, suspendedRec);
          else await j.put('tko:tool:c1', suspendedRec);
        }],
        ['the takeover resolves it', () => j.put('tko:tool:c1', { status: 'succeeded', output: 1 })],
        // (Not on a double that reports a lost claim as won: its adapter then counts the write.)
        ...(exactClaim ? [['a lost claim changes nothing', async () => { await j.putIfAbsent?.('tko:tool:c1', suspendedRec); }] as [string, () => Promise<unknown>]] : []),
      ];
      const ALL: RunStatus[] = ['completed', 'suspended', 'failed', 'running', 'canceled'];
      const OPEN: RunStatus[] = ['canceled', 'suspended', 'failed', 'running'];
      for (const [step, write] of steps) {
        await write();
        const expected = await statusesFromRecords(j);
        const listed = await listAll(reader, {}, pageWalk);
        assert.deepEqual(Object.fromEntries(listed.map((r) => [r.runId, r.status])), expected, `after '${step}': the listing`);
        for (const st of ALL) {
          const want = listed.filter((r) => r.status === st).map((r) => r.runId);
          assert.deepEqual((await listAll(reader, { status: st }, pageWalk)).map((r) => r.runId), want, `after '${step}': status '${st}', filtered before it is sliced`);
        }
        assert.deepEqual((await listAll(reader, { statuses: OPEN }, pageWalk)).map((r) => r.runId), listed.filter((r) => OPEN.includes(r.status)).map((r) => r.runId), `after '${step}': the open statuses`);
        if (typeof reader.countRunsByStatus === 'function') {
          const tally: Record<string, number> = {};
          for (const r of listed) tally[r.status] = (tally[r.status] ?? 0) + 1;
          assert.deepEqual(dropZeros(await reader.countRunsByStatus()), tally, `after '${step}': countRunsByStatus`);
        }
        if (typeof reader.countRuns === 'function') assert.equal(await reader.countRuns(), listed.length, `after '${step}': countRuns`);
      }
    });

    scenario('R4 paging: a walk hands out every run once, in both orders, and every filter applies before the slice', async ({ journal: j }) => {
      const reader = requireReader(j);
      const owners = ['u-a', 'u-b', 'u-a', undefined, 'u-a', 'u-b', 'u-a'];
      for (let i = 0; i < owners.length; i++) {
        const id = `pg${i}`;
        if (owners[i]) await j.put(`${id}:input`, stampFormat({ at: 1, resourceId: owners[i], agent: i % 2 ? 'beta' : 'alpha', ...(i === 2 ? { parentRunId: 'pg0' } : {}) }));
        await j.put(`${id}:model:0`, { ok: true });
        if (i % 3 === 0) await j.put(`${id}:tool:c1`, { status: 'suspended', output: {} });
      }
      const all = await listAll(reader, {}, pageWalk);
      assert.equal(all.length, owners.length);
      const filters: RunListQuery[] = [{}, { resourceId: 'u-a' }, { agent: 'alpha' }, { status: 'suspended' }, { status: 'completed' }, { topLevel: true }, { resourceId: 'u-a', agent: 'alpha' }];
      for (const f of filters) {
        const want = all.filter((r) => (f.resourceId === undefined || r.resourceId === f.resourceId) && (f.agent === undefined || r.agent === f.agent)
          && (f.status === undefined || r.status === f.status) && (!f.topLevel || !r.parentRunId)).map((r) => r.runId);
        const asc = (await listAll(reader, f, pageWalk, 2)).map((r) => r.runId);
        assert.deepEqual(asc, want, `${JSON.stringify(f)}: ascending, page by page`);
        const desc = (await listAll(reader, { ...f, order: 'desc' }, pageWalk, 2)).map((r) => r.runId);
        assert.deepEqual(desc, [...want].reverse(), `${JSON.stringify(f)}: descending`);
      }
    });

    // ── Relations: whose a run is, where it ran, whose a thread is ───────────────────────────────
    scenario('L1 a person\'s and a thread\'s runs: exact ids, older writers\' rows included, a rewritten :input moves the run', async (s) => {
      const { journal: j, older } = s;
      const reader = requireReader(j);
      const input = (f: Record<string, unknown>) => stampFormat({ at: 1, ...f });
      await j.put('p1:input', input({ resourceId: 'ayse', threadId: 't-1' }));
      await j.put('p2:input', input({ resourceId: 'ayse', threadId: 't-10' }));
      await j.put('p3:input', input({ resourceId: 'ayse2', threadId: 't-1:x' }));
      await j.put('p4:input', input({ resourceId: 'bob:evil', threadId: 't-1' }));
      // Written by an earlier version: the store must find them without having placed them.
      await older('o1:input', input({ resourceId: 'ayse', threadId: 't-1' }));
      await older('o1:model:0', { text: 'older' });
      await older('o2:input', input({ resourceId: 'ayse' }));
      // This version places it; an earlier version then hands the run to carl on another thread.
      await j.put('m1:input', input({ resourceId: 'ayse', threadId: 't-1' }));
      await older('m1:input', input({ resourceId: 'carl', threadId: 't-2' }));
      // A run whose :input arrives after its first step, from an earlier version.
      await j.put('n1:model:0', { text: 'driven without run()' });
      await older('n1:input', input({ resourceId: 'carl', threadId: 't-3' }));
      const ids = async (q: RunListQuery) => (await listAll(reader, q, pageWalk, 2)).map((r) => r.runId).sort();
      assert.deepEqual(await ids({ resourceId: 'ayse' }), ['o1', 'o2', 'p1', 'p2']);
      assert.deepEqual(await ids({ resourceId: 'ayse2' }), ['p3']);
      assert.deepEqual(await ids({ resourceId: 'carl' }), ['m1', 'n1']);
      assert.deepEqual(await ids({ resourceId: 'bob' }), []);
      assert.deepEqual(await ids({ threadId: 't-1' }), ['o1', 'p1', 'p4']);
      assert.deepEqual(await ids({ threadId: 't-2' }), ['m1']);
      assert.deepEqual(await ids({ threadId: 't-1:x' }), ['p3']);
      const asc = (await listAll(reader, { resourceId: 'ayse' }, pageWalk, 2)).map((r) => r.runId);
      assert.deepEqual((await listAll(reader, { resourceId: 'ayse', order: 'desc' }, pageWalk, 2)).map((r) => r.runId), [...asc].reverse());
      // An unstamped :input written over a stamped one: a filtered listing is the unfiltered one, filtered.
      await j.put('u1:input', input({ resourceId: 'ayse' }));
      await j.put('u1:input', { resourceId: 'carl', threadId: 't-9' });
      const all = await listAll(reader, {}, pageWalk);
      for (const who of ['ayse', 'carl']) assert.deepEqual(await ids({ resourceId: who }), all.filter((r) => r.resourceId === who).map((r) => r.runId).sort(), `${who}: filtered = unfiltered, filtered`);
      for (const t of ['t-1', 't-9']) assert.deepEqual(await ids({ threadId: t }), all.filter((r) => r.threadId === t).map((r) => r.runId).sort(), `${t}: filtered = unfiltered, filtered`);
    });

    scenario('L2 owner records: listOwnerRecords names exactly the records that name the person — older writers\' and rewritten ones too', async (s) => {
      const { journal: j, older } = s;
      if (typeof j.listOwnerRecords !== 'function') return; // optional: an erasure then reads every owner record
      await j.put(ORG_RECORD_PRE + 'acme', { id: 'acme' });
      await j.put(threadOwnerKey('t-1'), { at: 1, resourceId: 'ayse' });
      await older(threadOwnerKey('t-2'), { at: 1, resourceId: 'ayse' });
      await j.put(threadOwnerKey('t-3'), { at: 1, resourceId: 'ayse' });
      await older(threadOwnerKey('t-3'), { at: 2, resourceId: 'carl' });
      await j.put(threadOwnerKey('t-4'), { at: 1, ownerKind: 'staff' });
      await j.put(threadOwnerKey('t-5'), { at: 1 });
      await j.put(threadOwnerKey('t-6'), { at: 1, resourceId: 'ayse2' });
      await j.put(threadOwnerKey('t-7:owner:x'), { at: 1, resourceId: 'ayse' }); // a thread whose id holds ':owner'
      await j.put(threadSeenKey('t-1'), { at: 1, resourceId: 'ayse' }); // names her, but is not an owner record
      await withOrg(j, 'acme').put(threadOwnerKey('t-1'), { at: 1, resourceId: 'ayse' });
      for (const [who, prefix] of [['ayse', 'thread:'], ['carl', 'thread:'], ['ayse', 'org:acme:'], ['ayse', ''], ['nobody', '']] as const) {
        const want: string[] = [];
        for (const k of await j.listKeys!(prefix)) if (isOwnerRecordKey(k) && ownerOfRecord(await j.get(k)) === who) want.push(k);
        assert.deepEqual((await j.listOwnerRecords(who, { prefix })).sort(), want.sort(), `${who} under '${prefix}'`);
      }
      assert.deepEqual((await j.listOwnerRecords('carl', { prefix: 'thread:' })), [threadOwnerKey('t-3')]);
    });

    // ── The dependents model: what a deletion takes ──────────────────────────────────────────────
    scenario('D1 deleting a thread takes its runs (an older writer\'s, a sub-agent), its state and its records — and nothing else', async (s) => {
      const w = await world(s);
      const before = await snapshot(s.journal);
      await purgeThread(s.journal, 't-a');
      await assertRemoved(s.journal, before, w.root.thread['t-a']!, 'purgeThread(t-a)');
      assert.deepEqual((await listAll(requireReader(s.journal), { threadId: 't-a' }, false)).filter((r) => !r.runId.startsWith('org:')), []);
    });

    scenario('D2 organizations: a root deletion never reaches an organization\'s data, and an organization\'s never the root\'s', async (s) => {
      const w = await world(s);
      const before = await snapshot(s.journal);
      await purgeThread(withOrg(s.journal, 'acme'), 't-a');
      await assertRemoved(s.journal, before, w.acme.thread['t-a']!, 'acme purgeThread(t-a)');
      const mid = await snapshot(s.journal);
      await purgeRun(s.journal, 'r-a5');
      await assertRemoved(s.journal, mid, w.root.run['r-a5']!, 'root purgeRun(r-a5)');
    });

    scenario('D3 a thread with a run in flight is refused and left whole, until the caller says the run is abandoned', async (s) => {
      await world(s);
      const j = s.journal;
      await j.put('r-a1:outcome', { status: 'running', at: 1 });
      const before = await snapshot(j);
      const err = await purgeThread(j, 't-a').then(() => undefined, (e: unknown) => e);
      assert.ok(err instanceof ThreadRunsInFlightError, `refused with ThreadRunsInFlightError, got ${String(err)}`);
      assert.deepEqual(err.runIds, ['r-a1']);
      assert.deepEqual(await snapshot(j), before, 'a refused deletion deletes nothing');
      // A canceled run still inside a step: the step finishes after the cancel, so it is in flight too.
      await j.put('r-a1:outcome', { status: 'completed', at: 2 });
      await j.put('r-a2:outcome', { status: 'canceled', at: 2 });
      await j.put('r-a2:tool:c-slow', { status: 'running', startedAt: 1 });
      const err2 = await purgeThread(j, 't-a').then(() => undefined, (e: unknown) => e);
      assert.deepEqual((err2 as ThreadRunsInFlightError | undefined)?.runIds, ['r-a2']);
      await purgeThread(j, 't-a', { allowInFlight: true });
      assert.equal(await j.get('r-a2:tool:c-slow'), undefined);
    });

    scenario('D4 a thread deletion killed at any point keeps the thread gated by its owner, and the next attempt finishes it', async (s) => {
      // A clean deletion first: the end state every interrupted one must reach on its retry.
      const w = await world(s);
      const footprint = w.root.thread['t-a']!;
      const calls = { n: 0 };
      await purgeThread(killable(s.journal, calls, -1), 't-a');
      const done = await snapshot(s.journal);
      assert.ok(calls.n > 3, 'the deletion is several store calls');
      for (let k = 0; k < calls.n; k++) {
        // The same world again, written the same way (an older writer's rows unplaced again).
        await s.journal.deletePrefix!('');
        await world(s);
        await assert.rejects(purgeThread(killable(s.journal, { n: 0 }, k), 't-a'), /killed/, `crash point ${k}`);
        const left = Object.keys(await snapshot(s.journal)).filter((key) => footprint.has(key));
        if (left.length > 0) assert.notEqual(await s.journal.get(threadOwnerKey('t-a')), undefined, `crash point ${k}: ${left.slice(0, 3).join(', ')} still there, and the owner record is gone`);
        await purgeThread(s.journal, 't-a');
        assert.deepEqual(await snapshot(s.journal), done, `crash point ${k}: the retry finishes the deletion`);
      }
    });

    scenario('D5 purging a run takes its sub-agent and its records outside its namespace — never a run whose id extends it', async (s) => {
      const w = await world(s);
      const before = await snapshot(s.journal);
      await purgeRun(s.journal, 'r-a1');
      await assertRemoved(s.journal, before, w.root.run['r-a1']!, 'purgeRun(r-a1)');
      assert.notEqual(await s.journal.get('r-a10:input'), undefined);
    });

    scenario('D6 erasing a person takes their threads, their runs (an older writer\'s too) and their records — nobody else\'s, in no other scope', async (s) => {
      const w = await world(s);
      const before = await snapshot(s.journal);
      await purgeResource(s.journal, 'ayse', { outsideOrganizations: true });
      await assertRemoved(s.journal, before, w.root.person['ayse']!, 'purgeResource(ayse)');
    });

    scenario('D7 exactly-once outlives a deletion: a cross-run claim made by a deleted run still answers, and cannot be taken again', async (s) => {
      await world(s);
      const j = s.journal;
      const claimKey = 'xrun:charge:k-1';
      assert.notEqual(await j.get(claimKey), undefined);
      await purgeThread(j, 't-a');
      await purgeResource(j, 'ayse', { outsideOrganizations: true });
      assert.deepEqual(await j.get(claimKey), { status: 'succeeded', output: { charged: true }, ranBy: { runId: 'r-a1', toolCallId: 'c-charge' } });
      if (exactClaim) assert.equal(await claim(j, claimKey, { status: 'running' }), false, 'the effect does not run a second time');
    });
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────────────────────────

interface Subject extends ConformanceSubject {
  /** `writeAsOlderVersion`, or `put` when the store has one way of writing. */
  older(key: string, value: unknown): Promise<void>;
  pageWalk: boolean;
}

function requireReader(j: ConformanceJournal): ConformanceJournal & Required<Pick<JournalReader, 'readRun' | 'listRunsPaged'>> {
  // Without a paged listing a thread delete cannot find the thread's runs and an erasure cannot find the
  // person's (`listRunsWhere`): they would delete the rest and leave the runs, with a count that looks done.
  assert.equal(typeof j.listRunsPaged, 'function', 'listRunsPaged is how a thread\'s and a person\'s runs are found (JournalReader)');
  assert.equal(typeof j.readRun, 'function', 'readRun is how a run\'s children and cost are found (JournalReader)');
  return j as ConformanceJournal & Required<Pick<JournalReader, 'readRun' | 'listRunsPaged'>>;
}

/** Every run a filter lists, page by page (one big page when the store cannot walk). */
async function listAll(j: ConformanceJournal, q: RunListQuery, pageWalk: boolean, limit = 3): Promise<RunSummary[]> {
  if (!pageWalk) return (await j.listRunsPaged!({ ...q, limit: 10_000 })).items;
  const out: RunSummary[] = [];
  let cursor: string | undefined;
  for (let guard = 0; ; guard++) {
    assert.ok(guard < 10_000, 'the cursor walk ends');
    const page = await j.listRunsPaged!({ ...q, limit, ...(cursor ? { cursor } : {}) });
    assert.ok(page.items.length <= limit, `a page holds at most ${limit}`);
    out.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.equal(new Set(out.map((r) => r.runId)).size, out.length, 'no run twice across pages');
  return out;
}

/** The reference: each run's status from its own records, read as raw keys — independent of the listing under test. */
async function statusesFromRecords(j: ConformanceJournal): Promise<Record<string, RunStatus>> {
  const runs = new Map<string, { suspended: boolean; outcome?: 'running' | 'failed' | 'canceled' | 'completed' }>();
  const at = (id: string) => runs.get(id) ?? (runs.set(id, { suspended: false }), runs.get(id)!);
  for (const key of await j.listKeys!('')) {
    const value = await j.get(key);
    const p = parseJournalKey(key);
    if (p) {
      const r = at(p.runId);
      if (p.kind === 'tool' && (value as { status?: unknown } | undefined)?.status === 'suspended') r.suspended = true;
      continue;
    }
    const owner = runIdOfKey(key, value);
    if (owner) at(owner);
    const oc = outcomeStatusOf(key, value);
    if (oc !== null) at(key.slice(0, -':outcome'.length)).outcome = oc;
  }
  return Object.fromEntries([...runs].map(([id, r]) => [id, deriveRunStatus(r.suspended, r.outcome ? { status: r.outcome } : null)] as const));
}

const dropZeros = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).filter(([, n]) => n > 0));

/** Every key and its value, as text. Counters are not keys `get` reads, so they are not in it. */
async function snapshot(j: ConformanceJournal): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const k of (await j.listKeys!('')).sort()) {
    const v = await j.get(k);
    if (v !== undefined) out[k] = JSON.stringify(v);
  }
  return out;
}

/** Exactly `footprint` went; every other key is still there with the same value. */
async function assertRemoved(j: ConformanceJournal, before: Record<string, string>, footprint: Set<string>, what: string): Promise<void> {
  const after = await snapshot(j);
  const removed = Object.keys(before).filter((k) => !(k in after)).sort();
  const added = Object.keys(after).filter((k) => !(k in before)).sort();
  const changed = Object.keys(after).filter((k) => k in before && after[k] !== before[k]).sort();
  assert.deepEqual({ removed, added, changed }, { removed: [...footprint].filter((k) => k in before).sort(), added: [], changed: [] }, `${what}: exactly its footprint`);
  assert.ok(footprint.size > 0 && [...footprint].every((k) => k in before), `${what}: the world held its whole footprint`);
}

/** The journal with its `deletePrefix` counted, and killed (thrown) at call `k` — a process dying there. */
function killable(j: ConformanceJournal, calls: { n: number }, k: number): ConformanceJournal {
  return new Proxy(j, {
    get(t, p) {
      if (p === 'deletePrefix') return async (prefix: string) => {
        if (calls.n++ === k) throw new Error(`killed at store call ${k}`);
        return t.deletePrefix!(prefix);
      };
      const v = Reflect.get(t, p, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

interface ScopeFootprints {
  /** What deleting each thread must take, as full keys. */
  thread: Record<string, Set<string>>;
  /** What purging each run (with its children) must take. */
  run: Record<string, Set<string>>;
  /** What erasing each person must take: their threads, their other runs, their own records. */
  person: Record<string, Set<string>>;
}

/**
 * One world, written as the engine writes it, in the root scope and again (same ids) in organization
 * `acme`. Every key is recorded against what owns it, so a deletion's expected effect is read off the
 * world rather than retyped in each scenario.
 *
 *   ayse, thread t-a:   r-a1 (calls a sub-agent; its request window, its metrics row, a cross-run claim it made)
 *                       its sub-agent; r-a2 (suspended on an approval); r-a3 (written by an older version)
 *                       the thread's state (mem:, xthr:, om:, sem:), its owner record and mark
 *   ayse, thread t-a:x: r-ax — a thread whose id EXTENDS t-a
 *   ayse, no thread:    r-a5 and its sub-agent; her lesson and cross-channel id records
 *   bob, thread t-b:    r-a10 — a run whose id EXTENDS r-a1 — and r-b1 (older version)
 *   ayse2:              r-z — a person whose id extends ayse's
 */
async function world(s: Subject): Promise<{ root: ScopeFootprints; acme: ScopeFootprints }> {
  await s.journal.put(ORG_RECORD_PRE + 'acme', { id: 'acme' });
  const root = await scope(s, s.journal, '');
  const acme = await scope(s, withOrg(s.journal, 'acme'), 'org:acme:');
  return { root, acme };
}

async function scope(s: Subject, j: ConformanceJournal, prefix: string): Promise<ScopeFootprints> {
  const fp: ScopeFootprints = { thread: {}, run: {}, person: {} };
  const add = (set: Record<string, Set<string>>, owner: string, key: string) => (set[owner] ??= new Set()).add(prefix + key);
  let current: Array<[Record<string, Set<string>>, string]> = [];
  const put = async (key: string, value: unknown, how: 'put' | 'older' = 'put') => {
    if (how === 'older') await s.older(prefix + key, value);
    else await j.put(key, value);
    for (const [set, owner] of current) add(set, owner, key);
  };
  const owning = async (owners: Array<[Record<string, Set<string>>, string]>, f: () => Promise<void>) => { const was = current; current = owners; await f(); current = was; };
  const input = (f: Record<string, unknown>) => stampFormat({ at: 1, ...f });
  const child = (parent: string) => nestedAgentRunId(parent, 'c-agent_w');
  const subAgentCall = { status: 'succeeded', output: { text: 'child done' } };

  // Thread t-a, and everything on it.
  await owning([[fp.thread, 't-a'], [fp.person, 'ayse']], async () => {
    await put(threadOwnerKey('t-a'), { at: 1, resourceId: 'ayse' });
    await put(threadSeenKey('t-a'), { at: 1 });
    await put(memKey('t-a', 'messages'), [{ role: 'user', content: 'AYSE on t-a' }]);
    await put('xthr:t-a:dup-0123', { toolName: 'note' });
    await put('om:t-a:observedSeq', 1);
    await put(semanticLogKey('t-a'), { log: 'AYSE-SEM' });
    await owning([...current, [fp.run, 'r-a1']], async () => {
      await put('r-a1:input', input({ resourceId: 'ayse', threadId: 't-a', agent: 'main' }));
      await put('r-a1:model:0', { text: 'AYSE asked' });
      await put('r-a1:tool:c-agent_w', subAgentCall);
      await put('r-a1:tool:c-charge', { status: 'succeeded', output: { charged: true }, mirrorOf: 'xreq:r-a1:args-charge-1' });
      await put(runKeys.memAppended('r-a1'), { at: 1 });
      await put(metricsRunKey('r-a1'), { steps: 1 });
      await put('xreq:r-a1:args-charge-1', { status: 'succeeded', output: { charged: true } });
      await put(`${child('r-a1')}:input`, input({ resourceId: 'ayse', threadId: 't-a', agent: 'w', parentRunId: 'r-a1' }));
      await put(`${child('r-a1')}:model:0`, { text: 'child done' });
    });
    await put('r-a2:input', input({ resourceId: 'ayse', threadId: 't-a', agent: 'main' }));
    await put('r-a2:model:0', { text: 'AYSE asked to pay' });
    await put('r-a2:tool:c-pay', { status: 'suspended', output: { __gnl_suspend: { toolCallId: 'c-pay', toolName: 'pay', reason: 'approve' } } });
    await put('r-a3:input', input({ resourceId: 'ayse', threadId: 't-a' }), 'older');
    await put('r-a3:model:0', { text: 'AYSE, written by an older version' }, 'older');
  });
  // A cross-run claim r-a1 made: shared by every run that dedups against it, owned by none.
  await j.put('xrun:charge:k-1', { status: 'succeeded', output: { charged: true }, ranBy: { runId: 'r-a1', toolCallId: 'c-charge' } });
  // Thread t-a:x — its id extends t-a's.
  await owning([[fp.thread, 't-a:x'], [fp.person, 'ayse']], async () => {
    await put(threadOwnerKey('t-a:x'), { at: 1, resourceId: 'ayse' });
    await put(memKey('t-a:x', 'messages'), [{ role: 'user', content: 'AYSE on t-a:x' }]);
    await put('r-ax:input', input({ resourceId: 'ayse', threadId: 't-a:x' }));
    await put('r-ax:model:0', { text: 'AYSE on t-a:x' });
  });
  // Ayse, on no thread.
  await owning([[fp.person, 'ayse'], [fp.run, 'r-a5']], async () => {
    await put('r-a5:input', input({ resourceId: 'ayse' }));
    await put('r-a5:model:0', { text: 'AYSE, no thread' });
    await put('r-a5:tool:c-agent_w', subAgentCall);
    await put(`${child('r-a5')}:input`, input({ resourceId: 'ayse', agent: 'w', parentRunId: 'r-a5' }));
    await put(`${child('r-a5')}:model:0`, { text: 'child done' });
  });
  await owning([[fp.person, 'ayse']], async () => {
    await put('lesson:res:ayse:L1', { text: 'AYSE-LESSON' });
    await put('xid:res:ayse:pay:0123456789abcdef', { toolName: 'pay' });
  });
  // Other people: bob (a run whose id extends r-a1, and an older version's run), ayse2.
  await owning([[fp.thread, 't-b'], [fp.person, 'bob']], async () => {
    await put(threadOwnerKey('t-b'), { at: 1, resourceId: 'bob' });
    await put(memKey('t-b', 'messages'), [{ role: 'user', content: 'BOB' }]);
    await put('r-a10:input', input({ resourceId: 'bob', threadId: 't-b' }));
    await put('r-a10:model:0', { text: 'BOB' });
    await put('r-b1:input', input({ resourceId: 'bob', threadId: 't-b' }), 'older');
    await put('r-b1:model:0', { text: 'BOB, older version' }, 'older');
  });
  await owning([[fp.person, 'ayse2']], async () => {
    await put('r-z:input', input({ resourceId: 'ayse2' }));
    await put('r-z:model:0', { text: 'AYSE2' });
    await put('lesson:res:ayse2:L1', { text: 'AYSE2-LESSON' });
  });
  return fp;
}
