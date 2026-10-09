// The SIXTH key family: the event LOG NAMESPACE (`evt:<topic>`), which key-ambiguity.test.ts
// deliberately left out.
//
// That exclusion was argued from the WorkStore PORT: `list(ns)` is defined as "the records appended
// under exactly this ns", so a namespace needs no escaping — the store matches it whole. The
// first-party stores do exactly that (InMemory: a Map keyed by ns; SQLite/Postgres: `WHERE ns = ?`).
// GNL's own Redis adapter, since removed, did not: it stored a record at `<pfx>wl:<ns>:<id>` and read
// a namespace back with `SCAN MATCH <pfx>wl:<ns>:*` — a PREFIX scan with `:` as an unescaped delimiter
// on BOTH sides of the join. Measured on a real Redis 7 before the fix:
//
//   F1  'orders' consumer received: 2 ["global-order","EU-ONLY-ORDER"]   <- never subscribed to 'orders:eu'
//   F2  emit returns: ["x","eu:x"]                                        <- both reported success
//       'inv:eu' consumer saw: ["A-first"]                                <- 'B-PAID' was never written
//       KEYS: [... "wl:evt:inv:eu:x" ...]                                 <- ONE key for TWO events
//
// F2 is the worse half: `emit` returns an event id for a record that `SET NX` silently refused,
// because a different topic's (ns, id) split hashed onto the same key. No dead-letter row, no log
// line — the exact class of loss the escaping round existed to remove.
//
// WorkStore is a public port, and addressing a record by a concatenated key is an ordinary way to
// implement it. So this package escapes the topic into the namespace itself, and does not depend on
// a property of the store that it cannot observe. This file pins that, against a store that joins
// ns and id the way that adapter did.
import { describe, it, expect } from 'vitest';
import type { WorkStore, ListQuery, Page, LogRecord } from '@gnldev/durable';
import { emit, createConsumer } from '../src/index.js';

/**
 * A WorkStore that derives its storage key by joining `ns` and `id` with `:` and answers `list` with
 * a prefix match — the Redis adapter's layout, distilled to nine lines and with no Redis in it.
 *
 * It is here on purpose, and it is NOT a bug being pinned: it is the stand-in for any store that
 * addresses a record by a concatenated key (a Redis/Valkey/DynamoDB/S3-prefix implementation a user
 * writes against the public `WorkStore` port). The tests that use it assert a property of THIS
 * package — that events' own namespaces are self-disambiguating — which stays true no matter what
 * the adapter underneath does.
 */
function prefixJoinWork(): WorkStore {
  const log = new Map<string, LogRecord<any>>();
  const kv = new Map<string, unknown>();
  return {
    async append(ns, payload, id) {
      const eid = id ?? `${ns}-${log.size}`;
      const key = `${ns}:${eid}`;
      if (!log.has(key)) log.set(key, { id: eid, payload, ts: Date.now() } as LogRecord<any>);
      return eid;
    },
    async list<T = unknown>(ns: string, _q?: ListQuery): Promise<Page<LogRecord<T>>> {
      const items = [...log.entries()].filter(([k]) => k.startsWith(`${ns}:`)).map(([, v]) => v as LogRecord<T>);
      return { items, nextCursor: undefined };
    },
    async get<T = unknown>(key: string) { return kv.get(key) as T | undefined; },
    async put(key, value) { kv.set(key, value); },
    async ackOnce(key) { if (kv.has(key)) return false; kv.set(key, true); return true; },
  };
}

// ── The package ─────────────────────────────────────────────────────────────────────────
const CASES: Array<[string, () => WorkStore]> = [
  ['a store that joins ns and id into one key', prefixJoinWork],
];

describe.each(CASES)('@gnldev/events — the event log namespace on %s', (_name, makeWork) => {
  // F1. `orders` and `orders:eu` are two ordinary topic names (the same regional convention
  // key-ambiguity.test.ts pins for consumers). A subscriber to the parent must not be handed the
  // child's events: it never subscribed, its handler is written for a different payload shape, and
  // on a fan-out bus "a topic I did not name" is an authorization boundary, not a nuisance.
  it('a topic does not receive a neighbouring topic\'s events', async () => {
    const work = makeWork();
    const got: string[] = [];
    const c = createConsumer(work, 'orders', (p: any) => void got.push(p.tag), { name: 'plain' });

    await emit(work, 'orders', { tag: 'global-order' }, { id: 'o-1' });
    await emit(work, 'orders:eu', { tag: 'EU-ONLY-ORDER' }, { id: 'o-2' });

    expect(await c.poll()).toBe(1); // 2 = 'orders:eu' leaked into the 'orders' scan
    expect(got).toEqual(['global-order']);
  });

  // ...and the leak is not one-directional bleed-through: the child must still get its own event
  // exactly once, so a fix that simply narrowed the scan into losing records is not green here.
  it('the neighbouring topic still receives its own event', async () => {
    const work = makeWork();
    const got: string[] = [];
    const c = createConsumer(work, 'orders:eu', (p: any) => void got.push(p.tag), { name: 'plain' });

    await emit(work, 'orders', { tag: 'global-order' }, { id: 'o-1' });
    await emit(work, 'orders:eu', { tag: 'EU-ONLY-ORDER' }, { id: 'o-2' });

    expect(await c.poll()).toBe(1);
    expect(got).toEqual(['EU-ONLY-ORDER']);
    expect(await c.poll()).toBe(0); // still exactly-once
  });

  // F2, the silent-loss half. `(topic 'inv:eu', id 'x')` and `(topic 'inv', id 'eu:x')` are two
  // different events by every rule this package states; they collapsed onto one storage key, and
  // append is first-write-wins, so the SECOND emit returned an id for a record that does not exist.
  it('an emit is never silently dropped by another topic\'s record', async () => {
    const work = makeWork();
    const first = await emit(work, 'inv:eu', { tag: 'A-first' }, { id: 'x' });
    const second = await emit(work, 'inv', { tag: 'B-PAID' }, { id: 'eu:x' });
    expect([first, second]).toEqual(['x', 'eu:x']); // both reported success before the fix too

    const seenEu: string[] = [];
    const seenPlain: string[] = [];
    const cEu = createConsumer(work, 'inv:eu', (p: any) => void seenEu.push(p.tag), { name: 'mail' });
    const cPlain = createConsumer(work, 'inv', (p: any) => void seenPlain.push(p.tag), { name: 'mail' });

    await cEu.poll();
    await cPlain.poll();
    expect(seenEu).toEqual(['A-first']);
    expect(seenPlain).toEqual(['B-PAID']); // [] = the second emit's payload was never stored
  });

  // The escape has to be injective for the namespace exactly as it is for the five marker families:
  // a topic literally named `inv%3Aeu` and the topic `inv:eu` are different topics, and a `%`-blind
  // escape maps them onto one namespace and re-creates the leak one level down.
  it('a topic containing the escape sequence itself stays a separate topic', async () => {
    const work = makeWork();
    const literal: string[] = [];
    const colon: string[] = [];
    const cL = createConsumer(work, 'inv%3Aeu', (p: any) => void literal.push(p.tag), { name: 'm' });
    const cC = createConsumer(work, 'inv:eu', (p: any) => void colon.push(p.tag), { name: 'm' });

    await emit(work, 'inv%3Aeu', { tag: 'LITERAL' }, { id: 'e1' });
    await emit(work, 'inv:eu', { tag: 'COLON' }, { id: 'e2' });

    expect(await cL.poll()).toBe(1);
    expect(await cC.poll()).toBe(1);
    expect(literal).toEqual(['LITERAL']);
    expect(colon).toEqual(['COLON']);
  });

  // The `evt:` PREFIX, the other half of `logNsOf` and the one with no coverage at all: deleting it
  // left all 61 events tests green, because every one of them reads back through the same function.
  // It is not decoration. A WorkStore is SHARED — @gnldev/queue keeps every job in the plain
  // namespace `qjob` (queue/src/index.ts:111,153) and the caller can use any name it likes — so
  // without the prefix a topic named `qjob` IS the queue's job log: the consumer is handed job
  // records its handler was never written for, and `listJobs` is handed events it will try to run.
  it('an event topic cannot collide with a non-events namespace of the same name', async () => {
    const work = makeWork();
    // The queue, writing its own log through the same store (its real ns, no events involved).
    await work.append('qjob', { type: 'send-mail', payload: {} }, 'j-1');

    const got: unknown[] = [];
    const c = createConsumer(work, 'qjob', (p: any) => void got.push(p), { name: 'w' });
    await emit(work, 'qjob', { tag: 'AN-EVENT' }, { id: 'e-1' });

    expect(await c.poll()).toBe(1); // 2 = the queue's job was delivered as an event
    expect(got).toEqual([{ tag: 'AN-EVENT' }]);
    // …and the other direction: the queue's own log is not polluted with events.
    expect((await work.list('qjob')).items.map((i) => i.id)).toEqual(['j-1']);
  });
});
