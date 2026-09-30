// The worker's persisted scan cursor (`qcursor`) must be a position that deletions and producer clocks
// cannot move. Measured before the fix (0.9.0, verifier probe R1): after
// `eraseSubject(storage, 'ayse', { erasers: [jobEraser(storage)] })` removed 300 finished jobs, carol's
// 10 jobs never ran — in memory and on SQLite — because the cursor was a row OFFSET and the rows under it
// had shifted 300 places. And on SQLite a job enqueued by a producer whose clock was 5s behind was
// sorted before the cursor and never ran either.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryStorage, eraseSubject, type Storage } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { enqueue, createWorker, jobEraser } from '../src/index.js';

const stores: Array<[string, () => Storage]> = [
  ['in-memory', () => new InMemoryStorage()],
  ['sqlite', () => new SqliteStorage(':memory:') as unknown as Storage],
];

afterEach(() => vi.restoreAllMocks());

const eraseAyse = (storage: Storage) => eraseSubject(storage, 'ayse', { erasers: [jobEraser(storage)] });

function recorder(storage: Storage) {
  const ran: string[] = [];
  const worker = () => createWorker(storage, { t: async (p: any) => { ran.push(p.who); } });
  return { ran, worker, count: (who: string) => ran.filter((x) => x === who).length };
}

describe.each(stores)('queue cursor vs erasure — %s', (_name, make) => {
  it('control: without an erasure, carol\'s 10 jobs after ayse\'s 300 all run', async () => {
    const storage = make();
    const r = recorder(storage);
    const w = r.worker();
    for (let i = 0; i < 300; i++) await enqueue(storage.work!, 't', { who: 'ayse' }, { resourceId: 'ayse' });
    await w.drain();
    for (let i = 0; i < 10; i++) await enqueue(storage.work!, 't', { who: 'carol' }, { resourceId: 'carol' });
    await w.drain();
    expect(r.count('carol')).toBe(10);
  });

  it('carol enqueues AFTER ayse is erased: all 10 of carol\'s jobs run, also on a fresh worker', async () => {
    const storage = make();
    const r = recorder(storage);
    const w = r.worker();
    for (let i = 0; i < 300; i++) await enqueue(storage.work!, 't', { who: 'ayse' }, { resourceId: 'ayse' });
    await w.drain();
    const report = await eraseAyse(storage);
    expect(report.byEraser.jobs ?? 0).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) await enqueue(storage.work!, 't', { who: 'carol' }, { resourceId: 'carol' });
    const w2 = r.worker(); // a new process: the cursor is in the store, not in memory
    await w.drain();
    await w2.drain();
    expect(r.count('carol')).toBe(10);
  });

  it('carol enqueued BEFORE the erasure (pending): her jobs still run', async () => {
    const storage = make();
    const r = recorder(storage);
    const w = r.worker();
    for (let i = 0; i < 300; i++) await enqueue(storage.work!, 't', { who: 'ayse' }, { resourceId: 'ayse' });
    await w.drain();
    for (let i = 0; i < 10; i++) await enqueue(storage.work!, 't', { who: 'carol' }, { resourceId: 'carol' });
    await eraseAyse(storage);
    await w.drain();
    expect(r.count('carol')).toBe(10);
  });

  it('SIBLING — ayse and carol interleaved, erased mid-way: every pending carol job runs exactly once', async () => {
    const storage = make();
    const r = recorder(storage);
    const w = r.worker();
    for (let i = 0; i < 120; i++) {
      const who = i % 2 === 0 ? 'ayse' : 'carol';
      await enqueue(storage.work!, 't', { who }, { resourceId: who });
    }
    await w.drain(); // 60 + 60, cursor persisted past the full pages
    for (let i = 0; i < 40; i++) {
      const who = i % 2 === 0 ? 'ayse' : 'carol';
      await enqueue(storage.work!, 't', { who }, { resourceId: who });
    }
    await eraseAyse(storage); // erases ayse's done AND pending jobs
    await r.worker().drain();
    expect(r.count('carol')).toBe(80);
    expect(r.count('ayse')).toBe(60); // her 20 pending jobs were erased, not run
  });
});

describe('queue cursor vs producer clocks', () => {
  it.each(stores)('%s: a job enqueued by a producer 5s behind runs', async (_name, make) => {
    const storage = make();
    const r = recorder(storage);
    const w = r.worker();
    for (let i = 0; i < 120; i++) await enqueue(storage.work!, 't', { who: 'a' }, { resourceId: 'a' });
    await w.drain();
    const real = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => real() - 5_000);
    await enqueue(storage.work!, 't', { who: 'late-clock' }, { resourceId: 'b' });
    vi.restoreAllMocks();
    await w.drain();
    expect(r.count('late-clock')).toBe(1);
  });
});

describe('UPGRADE — a `qcursor` persisted by 0.9 (a row offset)', () => {
  it.each(stores)('%s: is replaced after one pass; nothing is skipped and nothing runs twice', async (_name, make) => {
    const storage = make();
    const r = recorder(storage);
    for (let i = 0; i < 70; i++) await enqueue(storage.work!, 't', { who: `j${i}` }, { resourceId: 'x' });
    await r.worker().drain();
    expect(r.ran).toHaveLength(70);
    await storage.work!.put('qcursor', '300'); // what 0.9 left behind: an offset past today's end of log
    for (let i = 0; i < 5; i++) await enqueue(storage.work!, 't', { who: `new${i}` }, { resourceId: 'x' });
    await r.worker().drain();
    expect(r.ran.filter((x) => x.startsWith('new'))).toEqual(['new0', 'new1', 'new2', 'new3', 'new4']);
    expect(r.ran).toHaveLength(75); // the 70 done jobs were skipped by their markers, not re-run
    expect(await storage.work!.get('qcursor')).not.toBe('300'); // not a one-time rescan on every poll
  });
});
