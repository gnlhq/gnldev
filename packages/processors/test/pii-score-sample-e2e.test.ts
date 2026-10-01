// End-to-end with the REAL piiRedactor on OUTPUT: what a judge is asked to score.
//
// Invariant: a run has ONE scoring sample and its output is what the run returned (after output
// processors). The agent's `scorers` and a later rescore (`runScoreSample`, which @gnldev/evals'
// `scoreRun` and Studio's /runs/:id/score build on) get the same masked text; the raw model output a
// redactor removed is never handed to a judge.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, createGnl, runDurable, runScoreSample } from '@gnldev/durable';
import { echoModel } from '@gnldev/durable/mock';
import { piiRedactor } from '../src/pii.js';

const EMAIL = 'ayse@acme.com';

describe('piiRedactor on output + scoring', () => {
  it('registry scorers and a rescore see the same redacted output; the judge is asked once', async () => {
    const journal = new InMemoryJournal();
    const seen: string[] = []; let calls = 0;
    const judge = { name: 'rel', score: (s: { output: string }) => { calls++; seen.push(s.output); return { score: 1 }; } };
    // on: 'output', so the RAW email reaches the model and only the output processor masks it.
    const gnl = createGnl({ journal, agents: { a: { model: echoModel(), processors: [piiRedactor({ on: 'output' })], scorers: [judge] } } } as any);
    const res: any = await gnl.run('a', { runId: 'sc1', prompt: `write to ${EMAIL}` });
    expect(res.text).not.toContain(EMAIL);
    const sample = await runScoreSample(journal, 'sc1', { entries: await journal.readRun('sc1') });
    expect(sample.output).toBe(res.text);
    expect(seen).toEqual([res.text]);
    expect(calls).toBe(1);
  });

  it('bare runDurable: the journaled returned output is the redacted text', async () => {
    const journal = new InMemoryJournal();
    const res: any = await runDurable({ runId: 'sc2', journal, model: echoModel(), prompt: `write to ${EMAIL}`, processors: [piiRedactor({ on: 'output' })] } as any);
    const sample = await runScoreSample(journal, 'sc2', { entries: await journal.readRun('sc2') });
    expect(sample.output).toBe(res.text);
    expect(sample.output).not.toContain(EMAIL);
  });
});
