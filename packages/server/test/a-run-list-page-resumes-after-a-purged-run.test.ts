// GET /runs over a journal whose `listRuns()` answers an array (a legacy JournalReader): the server
// pages that array (`asReaderJournal`, or its own fallback — both `pageRunsFromArray`). It used to be
// placed by the cursor's run, then the run after it, then a COUNT of runs handed out (audit AR-3), so
// purging the cursor's run, the next one and one already shown skipped survivors, and new runs
// arriving made a run repeat. It pages by `(createdAt, runId)` now, as Sqlite and Postgres do.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, purgeRun } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';

const IDS = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9'];

/** The in-memory journal as a legacy reader: `listRuns()` answers an array, and there is no `listRunsPaged`. */
function legacyReader(j: InMemoryJournal): InMemoryJournal {
  return new Proxy(j, {
    get(t, prop) {
      if (prop === 'listRunsPaged') return undefined;
      const v = Reflect.get(t, prop, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
    has: (t, prop) => prop !== 'listRunsPaged' && Reflect.has(t, prop),
  });
}

async function seed(j: InMemoryJournal, ids: string[]) {
  for (const id of ids) await j.put(`${id}:model:0`, { content: [{ type: 'text', text: 'x' }], finishReason: 'stop' });
}

async function page(api: ReturnType<typeof createRestApi>, cursor?: string): Promise<{ items: Array<{ runId: string }>; nextCursor?: string }> {
  const res = await api.fetch(new Request(`http://x/runs?limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
  expect(res.status).toBe(200);
  return res.json() as never;
}

async function rest(api: ReturnType<typeof createRestApi>, cursor: string | undefined): Promise<string[]> {
  const out: string[] = [];
  for (let guard = 0; cursor && guard < 50; guard++) {
    const p = await page(api, cursor);
    out.push(...p.items.map((r) => r.runId));
    cursor = p.nextCursor;
  }
  return out;
}

describe('GET /runs over an array reader: the next page starts right after the last run shown', () => {
  it('the cursor\'s run, the next one and one already shown are purged — no survivor is skipped', async () => {
    const j = new InMemoryJournal();
    await seed(j, IDS);
    const api = createRestApi({ journal: legacyReader(j), agents: {} } as never);
    const p1 = await page(api);
    expect(p1.items.map((r) => r.runId)).toEqual(['d0', 'd1', 'd2', 'd3']);
    for (const id of ['d3', 'd4', 'd0']) await purgeRun(j, id);
    expect(await rest(api, p1.nextCursor)).toEqual(['d5', 'd6', 'd7', 'd8', 'd9']);
  });

  it('the cursor\'s run and the next one are purged while new runs arrive — no run repeats, none is skipped', async () => {
    const j = new InMemoryJournal();
    await seed(j, IDS);
    const api = createRestApi({ journal: legacyReader(j), agents: {} } as never);
    const p1 = await page(api);
    for (const id of ['d3', 'd4']) await purgeRun(j, id);
    await seed(j, ['n1', 'n2']);
    expect(await rest(api, p1.nextCursor)).toEqual(['d5', 'd6', 'd7', 'd8', 'd9', 'n1', 'n2']);
  });
});
