// A run has ONE scoring sample, and its output is what the run returned — after output processors.
//
// Invariant: an agent's `scorers` (createGnl) and `scoreRun` (Studio's /runs/:id/score) build the
// identical sample for a run, so the judge is asked once across both, and a rescore never sees text
// the run did not return.
//
// Measured before this file: under a `processOutput` processor the registry scored the processed
// `result.text` while `scoreRun` read the RAW last model step from the journal — two samples, the
// judge asked twice, the memo overwritten, and with a redactor the unredacted output reached the judge
// model on rescore.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, createGnl, runDurable, streamDurable, runScoreSample } from '@gnldev/durable';
import { echoModel } from '@gnldev/durable/mock';
import { scoreRun, type Scorer } from '../src/index.js';

const SECRET = 'ayse@example.com';
const redactor = { name: 'redact', processOutput: async (o: any) => ({ ...o, text: String(o.text).replaceAll(SECRET, '[REDACTED_EMAIL]') }) };
const masker = { name: 'mask', processOutput: async (o: any) => ({ ...o, text: String(o.text).replace(/hello/gi, '[MASKED]') }) };

function recording() {
  const seen: string[] = []; let calls = 0;
  const judge: Scorer = { name: 'rel', score: (s) => { calls++; seen.push(s.output); return { score: 1 }; } };
  return { judge, seen, get calls() { return calls; } };
}

describe('one scoring sample per run, after output processors', () => {
  it('a processor that changes the text: registry and scoreRun score the same (processed) output, judge asked once', async () => {
    const journal = new InMemoryJournal();
    const j = recording();
    const gnl = createGnl({ journal, agents: { a: { model: echoModel(), processors: [masker], scorers: [j.judge] } } } as any);
    const res: any = await gnl.run('a', { runId: 'p1', prompt: 'hello world' });
    const memo = await journal.get('p1:proc:eval:rel');
    const r = await scoreRun(journal, 'p1', [j.judge]);
    expect(res.text).not.toMatch(/hello/i);
    expect(j.seen).toEqual([res.text]);
    expect(r.output).toBe(res.text);
    expect(j.calls).toBe(1);
    expect(await journal.get('p1:proc:eval:rel')).toEqual(memo);
  });

  it('a redactor on output: a rescore (scoreRun, memo off) never sees the unredacted text', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({ journal, agents: { a: { model: echoModel(), processors: [redactor] } } } as any);
    const res: any = await gnl.run('a', { runId: 'p2', prompt: `mail ${SECRET}` });
    const j = recording();
    const r = await scoreRun(journal, 'p2', [j.judge], { memo: false });
    expect(res.text).not.toContain(SECRET);
    expect(r.output).toBe(res.text);
    expect(j.seen.join()).not.toContain(SECRET);
  });

  it('no processor: unchanged — both runners score the model text, judge asked once', async () => {
    const journal = new InMemoryJournal();
    const j = recording();
    const gnl = createGnl({ journal, agents: { a: { model: echoModel(), scorers: [j.judge] } } } as any);
    const res: any = await gnl.run('a', { runId: 'p3', prompt: 'hello world' });
    const r = await scoreRun(journal, 'p3', [j.judge]);
    expect(j.seen).toEqual([res.text]);
    expect(r.output).toBe(res.text);
    expect(j.calls).toBe(1);
    expect((journal as any).keys().some((k: string) => k.endsWith(':output'))).toBe(false);
  });

  it('bare runDurable with an output processor: scoreRun reads what the run returned', async () => {
    const journal = new InMemoryJournal();
    const res: any = await runDurable({ runId: 'p4', journal, model: echoModel(), prompt: 'hello there', processors: [masker] } as any);
    const r = await scoreRun(journal, 'p4', [recording().judge], { memo: false });
    expect(r.output).toBe(res.text);
    expect(r.output).not.toMatch(/hello/i);
  });

  it('streamDurable with an output processor: scoreRun reads the processed text the stream returned', async () => {
    const journal = new InMemoryJournal();
    const s: any = await streamDurable({ runId: 'p5', journal, model: echoModel(), prompt: 'hello stream', processors: [masker] } as any);
    for await (const _ of s.textStream) { /* drain */ }
    const text = await s.text;
    // onFinish runs after the terminal promises settle; let it land.
    for (let i = 0; i < 20 && (await journal.get('p5:outcome') as any)?.status !== 'completed'; i++) await new Promise((r) => setTimeout(r, 5));
    const r = await scoreRun(journal, 'p5', [recording().judge], { memo: false });
    expect(text).not.toMatch(/hello/i);
    expect(r.output).toBe(text);
  });

  it('runScoreSample owns the output: called with no output it reads the run\'s returned output', async () => {
    const journal = new InMemoryJournal();
    const res: any = await runDurable({ runId: 'p6', journal, model: echoModel(), prompt: 'hello again', processors: [masker] } as any);
    const sample = await runScoreSample(journal, 'p6', {});
    expect(sample.output).toBe(res.text);
    expect(sample.runId).toBe('p6');
  });
});

describe('a streamed run with no output processor', () => {
  it('scoreRun scores the text the stream returned (it used to score every streamed run as \'\')', async () => {
    const journal = new InMemoryJournal();
    const s: any = await streamDurable({ runId: 's1', journal, model: echoModel(), prompt: 'hello stream' } as any);
    for await (const _ of s.textStream) { /* drain */ }
    const text = await s.text;
    for (let i = 0; i < 20 && (await journal.get('s1:outcome') as any)?.status !== 'completed'; i++) await new Promise((r) => setTimeout(r, 5));
    const r = await scoreRun(journal, 's1', [recording().judge], { memo: false });
    expect(r.output).toBe(text);
    expect(text).toBe('echo: hello stream');
  });
});

describe('a stale returned-output record does not outlive the processor', () => {
  it('a run re-driven without its output processor is scored on what it returns now', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'r1', journal, model: echoModel(), prompt: 'hello re', processors: [masker] } as any);
    const again: any = await runDurable({ runId: 'r1', journal, model: echoModel(), prompt: 'hello re' } as any);
    const r = await scoreRun(journal, 'r1', [recording().judge], { memo: false });
    expect(r.output).toBe(again.text);
  });
});
