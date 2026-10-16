// GET /runs builds its list from `listRuns()` whenever it cannot push the page down: an `agent` or `q`
// filter, a reader with no cheap status count (every organization's view). That array was paged by the
// cursor's run, then the run after it, then a COUNT of runs handed out (audit AR-3): purging the
// cursor's run, the next one and one already shown skipped survivors, and new runs arriving made a run
// repeat. It now pages by the key the tables do, `(createdAt, runId)`, so either branch resumes right
// after the last run it showed — and a cursor from one branch is read by the other.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, purgeRun } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

const IDS = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9'];

async function seed(journal: InMemoryJournal, ids: string[]) {
  for (const id of ids) {
    await journal.put(`${id}:input`, { _v: 1, prompt: 'x', agent: 'a' });
    await journal.put(`${id}:model:0`, { content: [{ type: 'text', text: 'x' }], finishReason: 'stop' });
  }
}

const ids = (page: { items: Array<{ runId: string }> }) => page.items.map((r) => r.runId);

async function walk(app: ReturnType<typeof createStudioApi>, query: string, cursor: string | undefined): Promise<string[]> {
  const out: string[] = [];
  for (let guard = 0; cursor && guard < 50; guard++) {
    const page = await (await call(app, `/runs?${query}&cursor=${encodeURIComponent(cursor)}`)).json();
    out.push(...ids(page));
    cursor = page.nextCursor;
  }
  return out;
}

/** A reader whose status count answers only `counts` times, then not — as an organization's view does. */
function countingFor(journal: InMemoryJournal, counts: number): InMemoryJournal {
  let left = counts;
  return new Proxy(journal, {
    get(t, prop) {
      if (prop === 'countRunsByStatus') return async () => (left-- > 0 ? t.countRunsByStatus() : undefined);
      const v = Reflect.get(t, prop, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

describe('GET /runs from listRuns(): the next page starts right after the last run shown', () => {
  for (const [label, query, reader] of [
    ['a `q` filter', 'limit=4&q=d', (j: InMemoryJournal) => j],
    ['an `agent` filter', 'limit=4&agent=a', (j: InMemoryJournal) => j],
    ['a reader with no status count', 'limit=4', (j: InMemoryJournal) => countingFor(j, 0)],
  ] as const) {
    it(`${label}: the cursor's run, the next one and one already shown are purged — no survivor is skipped`, async () => {
      const journal = new InMemoryJournal();
      await seed(journal, IDS);
      const app = createStudioApi({ reader: reader(journal) });
      const p1 = await (await call(app, `/runs?${query}`)).json();
      expect(ids(p1)).toEqual(['d9', 'd8', 'd7', 'd6']);
      for (const id of ['d6', 'd5', 'd9']) await purgeRun(journal, id);
      expect(await walk(app, query, p1.nextCursor)).toEqual(['d4', 'd3', 'd2', 'd1', 'd0']);
    });

    it(`${label}: the cursor's run and the next one are purged while new runs arrive — no run repeats`, async () => {
      const journal = new InMemoryJournal();
      await seed(journal, IDS);
      const app = createStudioApi({ reader: reader(journal) });
      const p1 = await (await call(app, `/runs?${query}`)).json();
      for (const id of ['d6', 'd5']) await purgeRun(journal, id);
      await seed(journal, ['n1', 'n2']);
      const rest = await walk(app, query, p1.nextCursor);
      expect(rest).toEqual(['d4', 'd3', 'd2', 'd1', 'd0']);
    });
  }

  it('a list that starts pushed down and continues from listRuns() resumes after the same run', async () => {
    const journal = new InMemoryJournal();
    await seed(journal, IDS);
    // Page one is pushed down (the count answers); every later page is built from listRuns() (it does not).
    const app = createStudioApi({ reader: countingFor(journal, 1) });
    const p1 = await (await call(app, '/runs?limit=4')).json();
    expect(ids(p1)).toEqual(['d9', 'd8', 'd7', 'd6']);
    for (const id of ['d6', 'd5', 'd9']) await purgeRun(journal, id);
    expect(await walk(app, 'limit=4', p1.nextCursor)).toEqual(['d4', 'd3', 'd2', 'd1', 'd0']);
  });
});
