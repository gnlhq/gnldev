// A view that hides a row hides it from EVERY read (journal-view.ts). The audit's red tests (A3/D3) caught
// `readRange`; these are the rule's siblings: the other reads by key the end user's view used to hand to
// the raw journal, a range read over a prefix that mixes hidden and shown rows, an adapter's own method,
// and a run-level read the end user's view never named. Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, afterAll } from 'vitest';
import { InMemoryStorage, withRootScope, withSubjectJournal, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { mysqlStores } from './real-backends.js';
import { JOURNAL_PORT } from '../src/journal-view.js';

const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

const PG_URL = process.env.GNL_PG_URL;
const STORES: Array<[string, () => Promise<Storage>]> = [
  ['in-memory', async () => new InMemoryStorage()],
  ['sqlite', async () => new SqliteStorage(':memory:')],
];
if (PG_URL) {
  STORES.push(['postgres (real)', async () => {
    const s = new PostgresStorage({ connectionString: PG_URL });
    ends.push(() => s.close());
    return s;
  }]);
}
for (const [name, make] of mysqlStores(' (real)')) STORES.push([name.toLowerCase(), async () => { const s = await make(); ends.push(() => s.close()); return s; }]);
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

describe.each(STORES)('a view hides a row from every read — %s', (_name, make) => {
  it('an end user\'s view hides another person\'s run from getMany, getCounters and listOwnerRecords', async () => {
    const s = await make(); await (s as { init?: () => Promise<void> }).init?.();
    const j = s.runs as any;
    const run = `r-ayse-${unique()}`;
    await j.put(`${run}:input`, { _v: 1, prompt: 'ayse secret', resourceId: 'u-ayse' });
    await j.incrBy?.(`${run}:usage`, { tokens: 7 });
    const mallory = withSubjectJournal(j, 'u-mallory') as any;
    const ayse = withSubjectJournal(j, 'u-ayse') as any;
    if (j.getMany) {
      expect(await mallory.getMany([`${run}:input`])).toEqual([undefined]);
      expect((await ayse.getMany([`${run}:input`]))[0]).toMatchObject({ prompt: 'ayse secret' });
    }
    if (j.getCounters) {
      expect(await mallory.getCounters(`${run}:usage`)).toBeUndefined();
      expect(await ayse.getCounters(`${run}:usage`)).toEqual({ tokens: 7 });
    }
    // An owner record is a thread's, never a run's: an end user's view has no reading of it.
    if (j.listOwnerRecords) expect(await mallory.listOwnerRecords('u-ayse')).toEqual([]);
  });

  it('a range read over a prefix that mixes hidden and shown rows fills its page and pages on', async () => {
    const s = await make(); await (s as { init?: () => Promise<void> }).init?.();
    const j = s.runs as any;
    if (!j.readRange) return;
    const tag = `m${unique()}`;
    // Under one prefix `o`: the root's runs `o<tag>…` and acme's rows `org:…` sort among them.
    for (let i = 0; i < 5; i++) await j.put(`org:acme:${tag}:${i}`, { i, org: true });
    for (let i = 0; i < 5; i++) await j.put(`o${tag}-${i}:x`, { i });
    const root = withRootScope(j) as any;
    const seen: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await root.readRange('o', { ...(after !== undefined ? { after } : {}), limit: 2 });
      for (const [k] of page) seen.push(k);
      if (page.length < 2) break;
      after = page[page.length - 1][0];
    }
    const mine = seen.filter((k) => k.includes(tag));
    expect(mine).toEqual([0, 1, 2, 3, 4].map((i) => `o${tag}-${i}:x`));
    expect(seen.some((k) => k.startsWith('org:'))).toBe(false);
  });

  it('an end user\'s view lists no other person\'s quiet run, and passes no method the port does not have', async () => {
    const s = await make(); await (s as { init?: () => Promise<void> }).init?.();
    const j = s.runs as any;
    const mallory = withSubjectJournal(j, 'u-mallory') as any;
    const root = withRootScope(j) as any;
    expect(mallory.listStaleRuns).toBeUndefined();
    for (const v of [mallory, root]) {
      for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(j))) {
        if (name === 'constructor' || typeof j[name] !== 'function' || name in JOURNAL_PORT) continue;
        expect(v[name], `${name} passed through a view`).toBeUndefined();
      }
    }
  });
});
