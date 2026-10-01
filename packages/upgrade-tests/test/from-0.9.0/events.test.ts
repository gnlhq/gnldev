// Upgrade from 0.9.0, @gnldev/events: a topic 0.9.0 left behind — 70 delivered events, a row-offset
// `evtcursor` ("50"), five events emitted after the last poll, and a quarantined poison event.
import { describe, expect, it } from 'vitest';
import { eraseSubject } from '@gnldev/durable';
import { createConsumer, emit, eventEraser, listDeadEvents, retryDeadEvent } from '@gnldev/events';
import * as S from '../../generate/shapes.mjs';
import { itMigrates, notes090, openFixture, rowsContaining } from '../support.js';

const E = S.EVENTS;
const pad = (n: number) => String(n).padStart(3, '0');
const pendingOn090 = [
  ...Array.from({ length: E.pendingAfter }, (_, i) => `e${pad(E.deliveredOn090 + i)}`),
  ...Array.from({ length: E.carolPending }, (_, i) => `c${i}`),
];
type Work = Parameters<typeof createConsumer>[0];
const consumer = (work: Work, seen: string[]) => createConsumer(work, E.topic, async (p: { n: string }) => { seen.push(p.n); }, { name: E.consumer });

describe('upgrade from 0.9.0 — events', () => {
  itMigrates('events.db');

  it('the fixture is what it claims: 0.9.0 persisted a row-offset cursor and left five events undelivered', () => {
    expect(notes090.events.cursor).toBe('50');
    expect(notes090.events.deliveredOn090).toHaveLength(E.ayseEvents + E.deliveredOn090);
    expect(notes090.events.dead).toEqual([E.poisonId]);
  });

  it('the first poll after the upgrade delivers exactly the events 0.9.0 had not, once', async () => {
    const { storage } = openFixture('events.db');
    const seen: string[] = [];
    const c = consumer(storage.work, seen);
    await c.poll();
    await c.poll();
    expect([...seen].sort()).toEqual([...pendingOn090].sort());
  });

  it('a consumer restarted after that delivers nothing again', async () => {
    const f = openFixture('events.db');
    await consumer(f.storage.work, []).poll();
    const again: string[] = [];
    await consumer(f.reopen().work, again).poll();
    expect(again).toEqual([]);
  });

  it('erasing a person right after the upgrade skips none of anybody else\'s events', async () => {
    const { storage } = openFixture('events.db');
    await eraseSubject(storage, 'ayse', { erasers: [eventEraser(storage.work)] });
    const seen: string[] = [];
    await consumer(storage.work, seen).poll();
    expect([...seen].sort()).toEqual([...pendingOn090].sort());
  });

  it('the erasure leaves nothing of the erased person\'s 0.9.0 events behind', async () => {
    const f = openFixture('events.db');
    await eraseSubject(f.storage, 'ayse', { erasers: [eventEraser(f.storage.work)] });
    expect(rowsContaining(f.path, '~o~:ayse:')).toEqual([]);
  });

  it('an event emitted after the upgrade is delivered once', async () => {
    const { storage } = openFixture('events.db');
    const seen: string[] = [];
    await emit(storage.work, E.topic, { n: 'new-1' }, { id: 'new-1' });
    await consumer(storage.work, seen).poll();
    await consumer(storage.work, seen).poll();
    expect(seen.filter((n) => n === 'new-1')).toHaveLength(1);
  });

  it('the 0.9.0 poison event stays quarantined until released, and is delivered once after retryDeadEvent', async () => {
    const { storage } = openFixture('events.db');
    expect((await listDeadEvents(storage.work, E.poisonTopic, E.poisonConsumer)).map((d) => d.id)).toEqual([E.poisonId]);
    const seen: string[] = [];
    const c2 = createConsumer(storage.work, E.poisonTopic, async (p: { n: string }) => { seen.push(p.n); }, { name: E.poisonConsumer, retryDelayMs: 0 });
    await c2.poll();
    expect(seen).toEqual([]);
    expect(await retryDeadEvent(storage.work, E.poisonTopic, E.poisonConsumer, E.poisonId)).toBe(true);
    await c2.poll();
    await c2.poll();
    expect(seen).toEqual(['poison']);
  });
});

describe('upgrade from 0.9.0 — a topic 0.9.0 itself erased a person from', () => {
  itMigrates('events-erased.db');

  it('the fixture is what it claims: 0.9.0 removed 30 events from under its row-offset cursor', () => {
    expect(notes090.eventsErasedOn090.erase.byEraser.events).toBe(E.ayseEvents);
    expect(notes090.eventsErasedOn090.cursor).toBe('50');
  });

  it('the first poll after the upgrade delivers every event that was undelivered when 0.9.0 erased, once', async () => {
    const { storage } = openFixture('events-erased.db');
    const seen: string[] = [];
    await consumer(storage.work, seen).poll();
    await consumer(storage.work, seen).poll();
    expect([...seen].sort()).toEqual([...pendingOn090].sort());
  });
});
