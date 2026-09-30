// A consumer's persisted cursor (`evtcursor:<topic>:<name>`) must be a position that deletions and
// producer clocks cannot move. Measured before the fix (0.9.0, verifier probe R1): after
// `eventEraser(work)` removed 300 of ayse's delivered events, carol's 10 later events were never
// delivered (in memory and SQLite) — the cursor was a row OFFSET and the rows under it had shifted.
// On SQLite an event from a producer whose clock was 5s behind was sorted before the cursor and lost.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryStorage, eraseSubject, type Storage } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { emit, createConsumer, eventEraser } from '../src/index.js';

const stores: Array<[string, () => Storage]> = [
  ['in-memory', () => new InMemoryStorage()],
  ['sqlite', () => new SqliteStorage(':memory:') as unknown as Storage],
];

afterEach(() => vi.restoreAllMocks());

function consumer(storage: Storage, topic = 'topic') {
  const got: string[] = [];
  const c = createConsumer(storage.work!, topic, async (p: any) => { got.push(p.who); }, { name: 'c1' });
  return { c, got, count: (who: string) => got.filter((x) => x === who).length };
}

describe.each(stores)('events cursor vs erasure — %s', (_name, make) => {
  it('control: without an erasure, carol\'s 10 events after ayse\'s 300 are delivered', async () => {
    const storage = make();
    const { c, count } = consumer(storage);
    for (let i = 0; i < 300; i++) await emit(storage.work!, 'topic', { who: 'ayse' }, { resourceId: 'ayse' });
    await c.poll();
    for (let i = 0; i < 10; i++) await emit(storage.work!, 'topic', { who: 'carol' }, { resourceId: 'carol' });
    await c.poll();
    expect(count('carol')).toBe(10);
  });

  it('carol emits AFTER ayse is erased: all 10 events are delivered', async () => {
    const storage = make();
    const { c, count } = consumer(storage);
    for (let i = 0; i < 300; i++) await emit(storage.work!, 'topic', { who: 'ayse' }, { resourceId: 'ayse' });
    await c.poll();
    await eraseSubject(storage, 'ayse', { erasers: [eventEraser(storage.work!)] });
    for (let i = 0; i < 10; i++) await emit(storage.work!, 'topic', { who: 'carol' }, { resourceId: 'carol' });
    await c.poll();
    expect(count('carol')).toBe(10);
  });

  it('SIBLING — interleaved owners, erased mid-way, consumer restarted: carol\'s undelivered events arrive exactly once', async () => {
    const storage = make();
    const first = consumer(storage);
    for (let i = 0; i < 160; i++) {
      const who = i % 2 === 0 ? 'ayse' : 'carol';
      await emit(storage.work!, 'topic', { who }, { resourceId: who });
    }
    await first.c.poll();
    for (let i = 0; i < 40; i++) {
      const who = i % 2 === 0 ? 'ayse' : 'carol';
      await emit(storage.work!, 'topic', { who }, { resourceId: who });
    }
    await eraseSubject(storage, 'ayse', { erasers: [eventEraser(storage.work!)] });
    const second = consumer(storage); // same consumer name, new process
    await second.c.poll();
    expect(first.count('carol') + second.count('carol')).toBe(100);
    expect(second.count('carol')).toBe(20);
  });
});

describe('events cursor vs producer clocks', () => {
  it.each(stores)('%s: an event emitted by a producer 5s behind is delivered', async (_name, make) => {
    const storage = make();
    const { c, count } = consumer(storage);
    for (let i = 0; i < 120; i++) await emit(storage.work!, 'topic', { who: 'a' });
    await c.poll();
    const real = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => real() - 5_000);
    await emit(storage.work!, 'topic', { who: 'late-clock' });
    vi.restoreAllMocks();
    await c.poll();
    expect(count('late-clock')).toBe(1);
  });
});

describe('UPGRADE — an `evtcursor` persisted by 0.9 (a row offset)', () => {
  it.each(stores)('%s: is replaced after one pass; nothing is skipped and nothing is redelivered', async (_name, make) => {
    const storage = make();
    const { c, got } = consumer(storage);
    for (let i = 0; i < 70; i++) await emit(storage.work!, 'topic', { who: `e${i}` });
    await c.poll();
    expect(got).toHaveLength(70);
    await storage.work!.put('evtcursor:topic:c1', '300'); // what 0.9 left behind
    for (let i = 0; i < 5; i++) await emit(storage.work!, 'topic', { who: `new${i}` });
    await c.poll();
    expect(got.filter((x) => x.startsWith('new'))).toEqual(['new0', 'new1', 'new2', 'new3', 'new4']);
    expect(got).toHaveLength(75);
    expect(await storage.work!.get('evtcursor:topic:c1')).not.toBe('300');
  });
});
