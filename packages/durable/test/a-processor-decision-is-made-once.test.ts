// A processor's journaled decision (`ctx.step`, `durableProcessorStep`) is made ONCE per run: two
// attempts computing it together — a twin resume, a stale worker waking late — both return the
// decision recorded first, and a replay returns it too. A later writer replacing it made the run act
// on one verdict while its history said another.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { durableProcessorStep } from '../src/processor.js';

const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };

describe('a processor decision is made once', () => {
  it('two attempts in flight together both return the decision recorded first, and so does a replay', async () => {
    const journal = new InMemoryJournal();
    const inA = gate(); const releaseA = gate();
    const a = durableProcessorStep(journal, 'r1', 'verdict', async () => { inA.open(); await releaseA.p; return 'allow'; });
    await inA.p;
    const b = await durableProcessorStep(journal, 'r1', 'verdict', async () => 'block');
    releaseA.open();
    expect(b).toBe('block');
    expect(await a).toBe('block');
    expect(await journal.get(runKeys.proc('r1', 'verdict'))).toEqual({ v: 'block' });
    expect(await durableProcessorStep(journal, 'r1', 'verdict', async () => 'allow')).toBe('block');
  });

  it('an undefined decision is a decision: it is replayed, not computed again', async () => {
    const journal = new InMemoryJournal();
    let computed = 0;
    expect(await durableProcessorStep(journal, 'r2', 'none', async () => { computed++; return undefined; })).toBeUndefined();
    expect(await durableProcessorStep(journal, 'r2', 'none', async () => { computed++; return 'x'; })).toBeUndefined();
    expect(computed).toBe(1);
  });
});
