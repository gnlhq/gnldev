// The runners hand a scorer everything the README says it reads.
//
// Five scorers read more than the output: `answerRelevancy` and `completeness` read `sample.input`
// (the question), `faithfulness`, `hallucination` and `contextPrecision` read `sample.context`. Called
// directly with those fields, they score. Called through the two runners this package ships — which is
// how the README shows them used — they could not: `evalDataset` and `scoreRun` built the sample from
// `{ output, expected, runId }` and nothing else. Measured on 0.9.0 with a judge that answers
// `SCORE: 0.9`: evalDataset → `answer-relevancy` 0, "input required"; scoreRun → all four judges
// 0 and the judge model called ZERO times. Every such eval ever reported read "irrelevant", whatever
// the agent said.
//
// And a sibling defect in the same records: a score is keyed by its scorer's NAME (the result record,
// the aggregate, the journal memo `eval:<name>`). Two scorers with one name — two `llmJudge` rubrics
// left at the default name — collapsed into one: measured, scoreRun returned the first judge's 0.9 for
// the second judge, whose model answered 0.1 and was never asked.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runDurable } from '@gnldev/durable';
import { echoModel } from '@gnldev/durable/mock';
import {
  evalDataset, scoreRun, answerRelevancy, completeness, faithfulness, hallucination, contextPrecision, llmJudge, contains,
} from '../src/index.js';

/** A judge that answers a fixed score and remembers every prompt it was shown. */
function judge(score = '0.9') {
  const prompts: string[] = [];
  const m = {
    specificationVersion: 'v2', provider: 'mock', modelId: 'judge', supportedUrls: {},
    prompts,
    doGenerate: async (o: { prompt: { content: unknown }[] }) => {
      prompts.push(JSON.stringify(o.prompt));
      return { content: [{ type: 'text', text: `SCORE: ${score}\nREASON: fine` }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
    },
    doStream: async () => { throw new Error('no stream'); },
  };
  return m;
}

describe('evalDataset: a case carries its input and context to the scorers', () => {
  it('answerRelevancy / completeness get the case input', async () => {
    const j = judge();
    const r = await evalDataset({
      dataset: { id: 'd', cases: [{ id: 'c1', input: 'What is the capital of France?', expected: 'Paris' }] },
      run: async () => 'Paris is the capital of France.',
      scorers: [answerRelevancy({ model: j }), completeness({ model: j })],
    });
    expect(r.aggregate['answer-relevancy']).toBeCloseTo(0.9);
    expect(r.aggregate['completeness']).toBeCloseTo(0.9);
    expect(j.prompts.every((p) => p.includes('What is the capital of France?'))).toBe(true);
  });

  it('context: from the case, or from what the runner retrieved (the runner wins)', async () => {
    const j = judge();
    const r = await evalDataset({
      dataset: { id: 'd', cases: [
        { id: 'static', input: 'q1', context: ['Paris is the capital of France.'] },
        { id: 'retrieved', input: 'q2', context: 'the case context' },
      ] },
      run: async (_input, { caseId }) => (caseId === 'retrieved' ? { output: 'Paris', context: ['retrieved chunk'] } : 'Paris'),
      scorers: [faithfulness({ model: j })],
    });
    expect(r.cases.map((c) => c.scores.faithfulness!.score)).toEqual([0.9, 0.9]);
    expect(j.prompts[0]).toContain('Paris is the capital of France.');
    expect(j.prompts[1]).toContain('retrieved chunk');
    expect(j.prompts[1]).not.toContain('the case context');
  });

  it('SIBLING: a non-string input reaches the judge as its prompt text, or as JSON', async () => {
    const j = judge();
    await evalDataset({
      dataset: { id: 'd', cases: [{ id: 'a', input: { prompt: 'what is 2+2?' } }, { id: 'b', input: { city: 'Paris' } }] },
      run: async () => '4',
      scorers: [answerRelevancy({ model: j })],
    });
    expect(j.prompts[0]).toContain('what is 2+2?');
    expect(j.prompts[1]).toContain('city');
  });

  it('SIBLING: a scorer that needs context still says so when there is none (no silent 1.0)', async () => {
    const j = judge();
    const r = await evalDataset({
      dataset: { id: 'd', cases: [{ id: 'c', input: 'q' }] },
      run: async () => 'a',
      scorers: [hallucination({ model: j })],
    });
    expect(r.cases[0]!.scores.hallucination).toMatchObject({ score: 0 });
    expect(r.cases[0]!.scores.hallucination!.reason).toContain('context required');
    expect(j.prompts).toHaveLength(0);
  });
});

describe('scoreRun: the run\'s own input is the question', () => {
  it('answerRelevancy is asked with the journaled prompt; context-needing judges take opts.context', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'c4-run', journal, prompt: 'What is the capital of France?', model: echoModel() } as never);
    const j = judge();
    const r = await scoreRun(journal, 'c4-run', [answerRelevancy({ model: j }), faithfulness({ model: j }), hallucination({ model: j }), contextPrecision({ model: j })], {
      context: ['Paris is the capital of France.'],
    });
    expect(Object.values(r.scores).map((s) => s.score)).toEqual([0.9, 0.9, 0.9, 0.9]);
    expect(j.prompts).toHaveLength(4);
    expect(j.prompts[0]).toContain('Input/Question:\\nWhat is the capital of France?');
    expect(r.input).toBe('What is the capital of France?');
  });

  it('SIBLING: a run started with `messages` — the question is the last user turn', async () => {
    const journal = new InMemoryJournal();
    await runDurable({
      runId: 'c4-msgs', journal, model: echoModel(),
      messages: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: [{ type: 'text', text: 'the real question' }] },
      ],
    } as never);
    const r = await scoreRun(journal, 'c4-msgs', [answerRelevancy({ model: judge() })]);
    expect(r.input).toBe('the real question');
    expect(r.scores['answer-relevancy']!.score).toBeCloseTo(0.9);
  });

  it('SIBLING: context can be derived from the run\'s journal entries (e.g. a retrieval tool\'s results)', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'c4-ctx', journal, prompt: 'q', model: echoModel() } as never);
    const j = judge();
    let seenEntries = 0;
    const r = await scoreRun(journal, 'c4-ctx', [faithfulness({ model: j })], {
      context: (entries) => { seenEntries = entries.length; return ['derived chunk']; },
    });
    expect(seenEntries).toBeGreaterThan(0);
    expect(r.scores.faithfulness!.score).toBeCloseTo(0.9);
    expect(j.prompts[0]).toContain('derived chunk');
  });

  it('SIBLING: opts.input overrides the journaled one (a run whose input is not the question)', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'c4-over', journal, prompt: 'SYSTEM-WRAPPED: q', model: echoModel() } as never);
    const j = judge();
    const r = await scoreRun(journal, 'c4-over', [answerRelevancy({ model: j })], { input: 'q' });
    expect(r.input).toBe('q');
    // The echo model's OUTPUT repeats the wrapped prompt, so look at the question slot only.
    expect(j.prompts[0]).toContain('Input/Question:\\nq');
    expect(j.prompts[0]).not.toContain('Input/Question:\\nSYSTEM-WRAPPED');
  });
});

describe('two scorers with one name are refused, naming both and the fix', () => {
  it('scoreRun throws before scoring anything', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'c4-col', journal, prompt: 'hi', model: echoModel() } as never);
    const a = judge('0.9');
    const b = judge('0.1');
    const polite = llmJudge({ model: a, rubric: 'is it polite?' });
    const concise = llmJudge({ model: b, rubric: 'is it concise?' });
    const err = await scoreRun(journal, 'c4-col', [polite, concise]).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("'llm-judge'");
    expect((err as Error).message).toContain('scorers[0]');
    expect((err as Error).message).toContain('scorers[1]');
    expect((err as Error).message).toContain('name');
    expect(a.prompts.length + b.prompts.length).toBe(0);
  });

  it('evalDataset throws too (its result and aggregate are keyed by name as well)', async () => {
    await expect(evalDataset({
      dataset: { id: 'd', cases: [{ id: 'c', input: 'x' }] },
      run: async () => 'x',
      scorers: [contains('a'), contains('b')],
    })).rejects.toThrow(/scorers\[0\] and scorers\[1\] are both named 'contains'/);
  });

  it('the way through: a `name` on the factory, or a renamed copy of any scorer', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'c4-ok', journal, prompt: 'hi', model: echoModel() } as never);
    const r = await scoreRun(journal, 'c4-ok', [
      llmJudge({ name: 'polite', model: judge('0.9'), rubric: 'p' }),
      llmJudge({ name: 'concise', model: judge('0.1'), rubric: 'c' }),
    ]);
    expect(r.scores.polite!.score).toBeCloseTo(0.9);
    expect(r.scores.concise!.score).toBeCloseTo(0.1);
    // Rule-based factories take no options; a spread renames them.
    const d = await evalDataset({
      dataset: { id: 'd2', cases: [{ id: 'c', input: 'x' }] },
      run: async () => 'ab',
      scorers: [{ ...contains('a'), name: 'has-a' }, { ...contains('z'), name: 'has-z' }],
    });
    expect(d.aggregate).toEqual({ 'has-a': 1, 'has-z': 0 });
  });
});

// Round 2 (K2): a memoized score is replayed only for the sample it was computed on. 0.9.0 memoized the
// judges' 0 ("input required") under `eval:<name>`; keyed by name alone, scoreRun replayed that 0 after
// the upgrade, for every run scored before it (measured by the review: judgeCalls=0, score 0).
describe('memoized scores from before the sample was complete are not replayed', () => {
  it('scoreRun: a 0.9.0 memo (no basis) is recomputed with the question, then replayed', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'run-e', journal, model: echoModel(), prompt: 'What is the capital of France?' });
    await journal.put('run-e:proc:eval:answer-relevancy', { v: { score: 0, reason: 'input required' } });
    const j = judge();
    const first = await scoreRun(journal, 'run-e', [answerRelevancy({ model: j as any })]);
    expect(first.scores['answer-relevancy']!.score).toBe(0.9);
    expect(j.prompts).toHaveLength(1);
    const again = await scoreRun(journal, 'run-e', [answerRelevancy({ model: j as any })]);
    expect(again.scores['answer-relevancy']!.score).toBe(0.9);
    expect(j.prompts).toHaveLength(1); // exactly-once for the same sample
  });

  it('scoreRun: another `expected` for an already-scored run is scored again, not answered from the memo', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'run-x', journal, model: echoModel(), prompt: 'abc' });
    expect((await scoreRun(journal, 'run-x', [contains()], { expected: 'zzz' })).scores.contains!.score).toBe(0);
    expect((await scoreRun(journal, 'run-x', [contains()], { expected: 'abc' })).scores.contains!.score).toBe(1);
  });

  it('evalDataset: a case memoized under another scorer list is run again, so the new scorer is scored', async () => {
    const journal = new InMemoryJournal();
    const dataset = { id: 'ds-m', cases: [{ id: 'c1', input: 'q', expected: 'a' }] };
    let runs = 0;
    const run = async () => { runs++; return 'ab'; };
    await evalDataset({ dataset, run, scorers: [contains('a')], journal });
    const second = await evalDataset({ dataset, run, scorers: [contains('a'), { ...contains('b'), name: 'has-b' }], journal });
    expect(second.cases[0]!.scores['has-b']?.score).toBe(1);
    expect(runs).toBe(2);
    await evalDataset({ dataset, run, scorers: [contains('a'), { ...contains('b'), name: 'has-b' }], journal });
    expect(runs).toBe(2); // same case, same scorers: resumed from the journal
  });
});
