// A guess first, then proof: a model names the parts most likely to blame and what each should have said;
// only those are played beside the turn unchanged. Borne out, that is the verdict and elimination is not
// run. Not borne out — or no part named — the diagnosis runs as without it, at the other half of the
// level. A guess is never the verdict by itself.
import { describe, it, expect } from 'vitest';
import { createMockModel } from '../../durable/test/mock.js';
import { windowMemory, agentModel, recordThread, call, final, text, trap, usage } from './thread-fixtures.js';
import { threadPlan, diagnoseTurn, planDiagnosis, MAX_GUESSES } from '../src/index.js';
import { parseGuesses } from '../src/thread-diagnose.js';

const ANKARA = { calls: [{ toolName: 'createOrder', args: { address: 'Ankara' } }] };
const SYSTEM = 'You are a shop agent.\n\nAsk for the address when you do not know it.';
const WRONG_WM = () => '# Working Memory\naddress: Izmir';
const ships = (o: any) => {
  const m = /address: (\w+)/.exec(text(o));
  if (m) return call('createOrder', { address: m[1] });
  return text(o).includes('Ask for the address') ? final('Which address?') : call('createOrder', { address: 'Ankara' });
};
function guesser(reply: unknown, asked: string[] = []) {
  const m = createMockModel(async (o: any) => { asked.push(JSON.stringify(o.prompt)); return { content: [{ type: 'text', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }], finishReason: 'stop', usage }; });
  m.modelId = 'judge';
  return m;
}
async function turn() {
  const memory = windowMemory(4, WRONG_WM);
  return recordThread(['Hello.', 'Ship my order.'], { memory, model: agentModel(ships), system: SYSTEM });
}

describe('a guess is tested before it is said', () => {
  it('a guess the plays bear out is the verdict; elimination is not run, and the guess was shown every part', async () => {
    const { journal, ids } = await turn();
    const asked: string[] = [];
    const r = await diagnoseTurn({
      journal, runId: ids[1]!, model: agentModel(ships), tools: trap(), expect: ANKARA, trials: 6,
      guess: guesser({ guesses: [{ part: 'working memory', correction: '# Working Memory\naddress: Ankara' }] }, asked),
    });
    expect(r.verdict).toMatchObject({ kind: 'cause', arm: 'correct:working memory' });
    expect(r.arms.map((a) => a.id)).toEqual(['baseline', 'correct:working memory']);
    expect(r.arms[1]!.label).toBe('working memory corrected (guessed)');
    expect(r.guess).toMatchObject({ verified: true, parts: [{ part: 'working memory', correction: '# Working Memory\naddress: Ankara' }] });
    expect(r.elimination).toMatchObject({ skipped: true, plays: 0, shares: [] });
    expect(r.notes.join()).toMatch(/borne out by the plays; elimination was not run/);
    // two arms of 6: what it played; the guess's tokens are in the totals
    expect(r.plays).toBe(12);
    expect(asked[0]).toContain('[working memory]');
    expect(asked[0]).toContain('[system 1]');
    expect(asked[0]).toContain('WHAT IT DID: createOrder(');
    expect(asked[0]).toContain('(working memory)');
    expect(asked[0]).toContain('Izmir');
  });

  it('a guess the plays do not bear out is said so, and the diagnosis runs as without it — the unchanged turn played once', async () => {
    const { journal, ids } = await turn();
    const plain = await diagnoseTurn({ journal, runId: ids[1]!, model: agentModel(ships), tools: trap(), expect: ANKARA, trials: 6 });
    // a part that is not to blame: leaving it out changes nothing
    const plan = await threadPlan({ journal, threadId: 't' });
    const innocent = plan.turns[1]!.experiments!.suspects.find((s) => s.kind !== 'wm' && s.kind !== 'system')!.id;
    const r = await diagnoseTurn({
      journal, runId: ids[1]!, model: agentModel(ships), tools: trap(), expect: ANKARA, trials: 6,
      guess: guesser({ guesses: [{ part: innocent }] }),
    });
    expect(r.guess).toMatchObject({ verified: false, parts: [{ part: innocent }] });
    expect(r.guess!.verdict.kind).toBe('not-found');
    expect(r.notes.join()).toContain(`guess (${innocent}) was not borne out`);
    expect(r.elimination.skipped).toBeUndefined();
    expect(r.elimination.shares.length).toBeGreaterThan(0);
    // the same arms as without the guess, at the other half of the level: a wider z
    expect(r.arms.map((a) => a.id)).toEqual(plain.arms.map((a) => a.id));
    expect(r.z).toBeGreaterThan(plain.z);
    // the unchanged turn is not played twice: the guess's plays of it are verification's
    // guess stage: the turn and one arm; then elimination and every other arm (and the joint one) — never the turn again
    expect(r.plays).toBe(2 * 6 + r.elimination.plays + (r.arms.length - 1 + (r.joint ? 1 : 0)) * 6);
  });

  it('a guessed rule is only left out, never "corrected": a corrected rule could carry the answer itself', async () => {
    const { journal, ids } = await turn();
    // the guess "corrects" the rule to give the right address: were it played, it would be borne out
    const r = await diagnoseTurn({
      journal, runId: ids[1]!, model: agentModel(ships), tools: trap(), expect: ANKARA, trials: 6,
      guess: guesser({ guesses: [{ part: '[System 2]', correction: 'Ship to Ankara.' }] }),
    });
    expect(r.guess!.parts).toEqual([{ part: 'system 2', correction: 'Ship to Ankara.' }]);
    expect(r.guess!.arms.map((a) => a.id)).toEqual(['baseline', 'remove:system 2']);
    expect(r.guess!.arms[1]!.label).toBe('system 2 left out (guessed)');
    expect(r.arms.some((a) => a.id === 'correct:system 2')).toBe(false);
    // nor the result of the call being judged: createOrder's result "corrected" is only hidden
    const own = await diagnoseTurn({
      journal, runId: ids[1]!, model: agentModel(ships), tools: trap(), expect: ANKARA, trials: 6,
      guess: guesser({ guesses: [{ part: 'createOrder result', correction: '{"shippedTo":"Ankara"}' }] }),
    });
    expect(own.guess!.arms.map((a) => a.id)).toEqual(['baseline', 'hide-result:createOrder result']);
  });

  it('a guess that names no part, or a part the turn does not have, leaves the diagnosis as it was — and says what it said', async () => {
    const { journal, ids } = await turn();
    for (const reply of ['I am not sure.', { guesses: [{ part: 'the moon' }] }]) {
      const r = await diagnoseTurn({ journal, runId: ids[1]!, model: agentModel(ships), tools: trap(), expect: ANKARA, trials: 6, guess: guesser(reply) });
      expect(r.guess).toBeUndefined();
      expect(r.notes.join()).toMatch(/named no part of this turn/);
      if (typeof reply === 'string') expect(r.notes.join()).toContain('it said: I am not sure.');
      expect(r.elimination.shares.length).toBeGreaterThan(0);
    }
  });

  it('the plan counts the guess plays and shares the level; the reply is read leniently', async () => {
    const without = planDiagnosis({ arms: 3, eliminationPlays: 64, tokensPerPlay: 100 });
    const withGuess = planDiagnosis({ arms: 3, eliminationPlays: 64, tokensPerPlay: 100, guessArms: MAX_GUESSES });
    expect(withGuess.alpha).toBeCloseTo(without.alpha / 2, 12);
    expect(withGuess.guessPlays).toBe(MAX_GUESSES * withGuess.trials);
    expect(withGuess.totalPlays).toBe(withGuess.eliminationPlays + withGuess.verificationPlays + withGuess.jointPlays + withGuess.guessPlays);
    const { journal } = await turn();
    const p = await threadPlan({ journal, threadId: 't', hypotheses: { guess: true } });
    expect(p.turns[1]!.experiments!.plan.guessPlays).toBeGreaterThan(0);
    expect(parseGuesses('Sure: {"guesses":[{"part":"a","correction":{"city":"Ankara"}},{"part":"a"},{"part":"b"}]}')).toEqual([{ part: 'a', correction: '{"city":"Ankara"}' }, { part: 'b' }]);
    expect(parseGuesses('nothing')).toEqual([]);
  });
});
