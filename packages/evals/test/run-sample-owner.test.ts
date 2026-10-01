// One owner builds the scoring sample for a RUN, and one owner keeps its memo.
//
// Invariant: every runner that scores a durable run — an agent's `scorers` (createGnl) and `scoreRun`
// (Studio's /runs/:id/score) — hands the scorer the same sample (the question from the run's frozen
// input, and its runId), so they share one memo: a run scored at completion is replayed, not judged
// again and overwritten. A memo is replayed only for the same scorer: an edited rubric re-scores.
//
// Measured before this file: the registry built `{ output, input: messages ?? prompt }` at its call site
// (no runId), scoreRun built `{ output, input: inputText(:input), runId }` at its own — the memo basis
// differed, so scoreRun asked the judge a second time and overwrote the record; a trajectory scorer on
// an agent got "sample.runId required"; an edited rubric under one name replayed the old score.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, createGnl } from '@gnldev/durable';
import { echoModel } from '@gnldev/durable/mock';
import { scoreRun, evalDataset, llmJudge, contains, createTrajectoryScorer, type Scorer } from '../src/index.js';

function judgeModel(score = '0.9') {
  let calls = 0;
  return {
    get calls() { return calls; },
    specificationVersion: 'v2', provider: 'mock', modelId: 'judge', supportedUrls: {},
    doGenerate: async () => {
      calls++;
      return { content: [{ type: 'text', text: `SCORE: ${score}\nREASON: fine` }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
    },
    doStream: async () => { throw new Error('no stream'); },
  };
}

describe('the registry and scoreRun build one sample for a run', () => {
  it('an agent scores a run, then scoreRun with the same scorer replays it — the judge is asked once', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const judge: Scorer = { name: 'rel', score: () => { calls++; return { score: 0.9 }; } };
    const gnl = createGnl({ journal, agents: { a: { model: echoModel(), scorers: [judge] } } });
    await gnl.run('a', { runId: 'x1', prompt: 'capital of France?' });
    const memo = await journal.get('x1:proc:eval:rel');
    const r = await scoreRun(journal, 'x1', [judge]);
    expect(calls).toBe(1);
    expect(r.scores.rel.score).toBe(0.9);
    expect(await journal.get('x1:proc:eval:rel')).toEqual(memo);
  });

  it('SIBLING: a run started with `messages` — both runners read the same question', async () => {
    const journal = new InMemoryJournal();
    const seen: unknown[] = [];
    const judge: Scorer = { name: 'rel', score: (s) => { seen.push(s.input); return { score: 1 }; } };
    const gnl = createGnl({ journal, agents: { a: { model: echoModel(), scorers: [judge] } } });
    await gnl.run('a', { runId: 'x2', messages: [{ role: 'user', content: 'MESSAGES-Q' }] } as any);
    await scoreRun(journal, 'x2', [judge], { memo: false });
    expect(seen).toEqual(['MESSAGES-Q', 'MESSAGES-Q']);
  });

  it('SIBLING: a trajectory scorer on an agent gets the runId (it used to get none and score 0)', async () => {
    const journal = new InMemoryJournal();
    const seen: unknown[] = [];
    const traj: Scorer = { name: 'traj', score: (s) => { seen.push(s.runId); return { score: 1 }; } };
    const gnl = createGnl({ journal, agents: { a: { model: echoModel(), scorers: [traj] } } });
    await gnl.run('a', { runId: 'x3', prompt: 'q' });
    expect(seen).toEqual(['x3']);
  });
});

describe('a memo is replayed only for the same scorer', () => {
  it('an edited inline scorer under the same name re-scores (S-b3)', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({ journal, agents: { a: { model: echoModel(), scorers: [{ name: 'polite', score: () => ({ score: 0.1, reason: 'old rubric' }) }] } } });
    await gnl.run('a', { runId: 'x4', prompt: 'q' });
    const r = await scoreRun(journal, 'x4', [{ name: 'polite', score: () => ({ score: 0.95, reason: 'new rubric' }) }]);
    expect(r.scores.polite.reason).toBe('new rubric');
  });

  it('llmJudge: an edited rubric re-asks the judge; the same rubric replays', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({ journal, agents: { a: { model: echoModel() } } });
    await gnl.run('a', { runId: 'x5', prompt: 'q' });
    const m = judgeModel();
    await scoreRun(journal, 'x5', [llmJudge({ model: m, name: 'polite', rubric: 'Is it polite?' })]);
    await scoreRun(journal, 'x5', [llmJudge({ model: m, name: 'polite', rubric: 'Is it polite?' })]);
    expect(m.calls).toBe(1);
    await scoreRun(journal, 'x5', [llmJudge({ model: m, name: 'polite', rubric: 'Is it polite AND brief?' })]);
    expect(m.calls).toBe(2);
  });

  it('SIBLING: factories with options — contains(x) → contains(y), a changed trajectory spec', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({ journal, agents: { a: { model: echoModel() } } });
    await gnl.run('a', { runId: 'x6', prompt: 'hello there' });
    expect((await scoreRun(journal, 'x6', [contains('hello')])).scores.contains.score).toBe(1);
    expect((await scoreRun(journal, 'x6', [contains('absent')])).scores.contains.score).toBe(0);
    const t1 = createTrajectoryScorer({ maxToolCalls: 1 });
    const t2 = createTrajectoryScorer({ maxToolCalls: 5 });
    expect(t1.fingerprint).not.toBe(t2.fingerprint);
  });

  it('SIBLING: evalDataset — a suite re-run with an edited rubric re-scores its cases', async () => {
    const journal = new InMemoryJournal();
    const dataset = { id: 'ds', cases: [{ id: 'c1', input: 'q' }] };
    const run = async () => 'answer';
    const m = judgeModel();
    await evalDataset({ dataset, run, journal, scorers: [llmJudge({ model: m, name: 'j', rubric: 'A' })] });
    await evalDataset({ dataset, run, journal, scorers: [llmJudge({ model: m, name: 'j', rubric: 'A' })] });
    expect(m.calls).toBe(1);
    await evalDataset({ dataset, run, journal, scorers: [llmJudge({ model: m, name: 'j', rubric: 'B' })] });
    expect(m.calls).toBe(2);
  });
});
