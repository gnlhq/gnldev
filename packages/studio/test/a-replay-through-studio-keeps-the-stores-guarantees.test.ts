// Studio's reader is the store Studio's own writes go through — a fork, an approval. It used to forward
// four of the store's eight guarantees by hand: measured on Postgres, a replay through Studio (the
// regression route, since removed — a run played again is the Lab's capsule, which writes nothing)
// wrote its records by read-then-put (no compare-and-set, no shared clock) and never reached the
// metrics. Now the reader forwards every guarantee, and a reader that can write without them is refused.
// Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, afterAll } from 'vitest';
import { InMemoryStorage, toJournal, JOURNAL_GUARANTEES, type Storage } from '@gnldev/durable';
import { PostgresStorage } from '@gnldev/durable/postgres';
import { createStudioApi } from '../src/server.js';

const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });
const STORES: Array<[string, () => Storage]> = [['in-memory', () => new InMemoryStorage()]];
if (process.env.GNL_PG_URL) STORES.push(['postgres (real)', () => { const s = new PostgresStorage({ connectionString: process.env.GNL_PG_URL! }); ends.push(() => s.close()); return s; }]);

describe.each(STORES)('a replay through Studio keeps the store\'s guarantees, %s', (_n, make) => {
  it('a reader that can write without the guarantees is refused, naming them; a read-only one is welcome', () => {
    const j = toJournal(make());
    const partial = { get: j.get.bind(j), put: j.put.bind(j), listRuns: j.listRuns.bind(j), readRun: j.readRun.bind(j) };
    expect(() => createStudioApi({ reader: partial } as never)).toThrow(new RegExp(JOURNAL_GUARANTEES.map((m) => `\`${m}\``).join(', ')));
    const readOnly = { get: j.get.bind(j), listRuns: j.listRuns.bind(j), readRun: j.readRun.bind(j) };
    expect(() => createStudioApi({ reader: readOnly } as never)).not.toThrow();
  });
});
