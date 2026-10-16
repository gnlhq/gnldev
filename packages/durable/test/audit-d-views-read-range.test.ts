// Audit D (red): `readRange` is a read this release added to the Journal (a run's event log is read
// through it), and the two views that narrow what a reader sees do not narrow it:
//   - withRootScope "answers as if no `org:` key existed" for every read, but its readRange returns an
//     organization's records from the root;
//   - withSubjectJournal hides another person's run from get/listKeys/readRun, but its readRange (and
//     getMany) hand that run's records to the view's subject.
// Both views are proxies that pass every method they do not name straight to the raw journal.
import { it, expect } from 'vitest';
import { InMemoryStorage, withRootScope, withSubjectJournal } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';

for (const [name, make] of [['InMemory', () => new InMemoryStorage()], ['Sqlite', () => new SqliteStorage(':memory:')]] as const) {
  it(`withRootScope hides organizations' records from readRange (${name})`, async () => {
    const s: any = (make as any)(); await s.init?.();
    const j = s.runs as any;
    await j.put('org:acme:r1:input', { _v: 1, prompt: 'acme secret', resourceId: 'u1' });
    await j.put('org:acme:r1:ev:0000000001', { seq: 1, kind: 'text', data: { text: 'acme secret' } });
    const root = withRootScope(j) as any;
    expect(await root.get('org:acme:r1:ev:0000000001')).toBeUndefined(); // the rule, as `get` keeps it
    expect(await root.readRange('org:acme:r1:ev:', { limit: 10 })).toEqual([]);
  });

  it(`withSubjectJournal hides another person's run events from readRange and getMany (${name})`, async () => {
    const s: any = (make as any)(); await s.init?.();
    const j = s.runs as any;
    await j.put('r-ayse:input', { _v: 1, prompt: 'ayse secret', resourceId: 'u-ayse' });
    await j.put('r-ayse:ev:0000000001', { seq: 1, kind: 'text', data: { text: 'ayse secret' } });
    const mallory = withSubjectJournal(j, 'u-mallory') as any;
    expect(await mallory.get('r-ayse:ev:0000000001')).toBeUndefined(); // the rule, as `get` keeps it
    const viaRange = await mallory.readRange('r-ayse:ev:', { limit: 10 });
    const viaMany = mallory.getMany ? await mallory.getMany(['r-ayse:input']) : [undefined];
    expect({ viaRange, viaMany }).toEqual({ viaRange: [], viaMany: [undefined] });
  });
}
