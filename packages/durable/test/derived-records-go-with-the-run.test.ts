// `<runId>:derived:…` — what a reader made out of a run and keeps (Studio's Lab experiments) — is
// deleted by every path that deletes the run, without any of them knowing the family exists.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { InMemoryStorage, runDurable, runKeys, runRecordKey, runRecordPrefix, purgeRun, eraseSubject, sweepRuns, toJournal, withOrg, admitRunId } from '../src/index.js';
import { createMockModel, finalTextResult } from './mock.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const reply = () => createMockModel(async () => finalTextResult('reply'));
const keep = (j: any, runId: string, n: number) => j.put(runRecordKey(runId, 'derived', `lab:exp:explain:${n}`), { v: 1, request: { system: 'Ayse prompt' }, result: { text: 'about Ayse' } });
const derived = (j: any, runId: string) => j.listKeys(runRecordPrefix(runId, 'derived'));

describe('derived records go with the run', () => {
  for (const [name, make] of [['memory', () => new InMemoryStorage()], ['sqlite', () => new SqliteStorage(':memory:')]] as const) {
    it(`${name}: purgeRun, eraseSubject and sweepRuns each take them; another person's stay`, async () => {
      const storage = make();
      const j = toJournal(storage);
      for (const [id, who] of [['p1', 'ayse'], ['p2', 'ayse'], ['p3', 'bob'], ['p4', 'cem']] as const) {
        await runDurable({ runId: id, journal: j, model: reply(), prompt: 'hi', resourceId: who } as any);
        await keep(j, id, 1);
        expect(await derived(j, id)).toHaveLength(1);
      }
      await purgeRun(j as any, 'p1');
      expect(await derived(j, 'p1')).toEqual([]);
      await eraseSubject(storage as any, 'ayse');
      expect(await derived(j, 'p2')).toEqual([]);
      expect(await derived(j, 'p3')).toHaveLength(1); // bob's run: untouched
      await sweepRuns(j as any, { olderThanMs: 1, now: Date.now() + 60_000 });
      expect(await derived(j, 'p3')).toEqual([]);
      expect(await derived(j, 'p4')).toEqual([]);
    });
  }

  it('inside an organization: eraseSubject with orgId takes them', async () => {
    const storage = new InMemoryStorage();
    const org = withOrg(toJournal(storage), 'acme');
    await runDurable({ runId: 'o1', journal: org, model: reply(), prompt: 'hi', resourceId: 'ayse' } as any);
    await keep(org, 'o1', 1);
    await eraseSubject(storage as any, 'ayse', { orgId: 'acme' });
    expect(await derived(org, 'o1')).toEqual([]);
  });

  it('is bookkeeping (a derived record alone is not a run) and its prefix is exact (an id with the segment is refused)', async () => {
    await expect(admitRunId('x:derived:y')).rejects.toThrow();
    expect(runKeys.memoryContext('x')).toBe('x:memctx');
  });
});
