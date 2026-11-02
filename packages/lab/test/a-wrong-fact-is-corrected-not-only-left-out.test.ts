// A part that said something wrong is not fixed by its absence — without it the model knows nothing —
// but by what it should have said. A correction is an arm: the person's own, or suggested by a model
// for the parts elimination blamed. A blamed part only ever left out is named in a "not found" verdict.
import { describe, it, expect } from 'vitest';
import { createMockModel } from '../../durable/test/mock.js';
import { windowMemory, agentModel, recordThread, call, final, text, trap, toolResults, usage } from './thread-fixtures.js';
import { threadPlan, diagnoseTurn } from '../src/index.js';
import { parseSuggestions } from '../src/thread-diagnose.js';

const ANKARA = { calls: [{ toolName: 'createOrder', args: { address: 'Ankara' } }] };
const SYSTEM = 'You are a shop agent.\n\nAsk for the address when you do not know it.';
const WRONG_WM = () => '# Working Memory\naddress: Izmir';

/** Ships to the working memory's address; without one, asks when the rule says so, else ships to the default, Ankara. */
const ships = (o: any) => {
  const m = /address: (\w+)/.exec(text(o));
  if (m) return call('createOrder', { address: m[1] });
  return text(o).includes('Ask for the address') ? final('Which address?') : call('createOrder', { address: 'Ankara' });
};
/** A model that answers the suggestion request with `reply`, and keeps what it was asked. */
function suggester(reply: unknown, asked: string[] = []) {
  const m = createMockModel(async (o: any) => { asked.push(JSON.stringify(o.prompt)); return { content: [{ type: 'text', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }], finishReason: 'stop', usage }; });
  m.modelId = 'judge';
  return m;
}

describe('a wrong fact is corrected, not only left out', () => {
  it('the working memory holds the wrong address: leaving it out does not help; the suggested correction does, and is marked', async () => {
    const memory = windowMemory(4, WRONG_WM);
    const { journal, ids } = await recordThread(['Hello.', 'Ship my order.'], { memory, model: agentModel(ships), system: SYSTEM });
    // only left out: not found — and the verdict names the blamed parts that were never corrected
    const off = await diagnoseTurn({ journal, runId: ids[1]!, model: agentModel(ships), tools: trap(), expect: ANKARA, trials: 6 });
    expect(off.verdict.kind).toBe('not-found');
    expect((off.verdict as { uncorrected?: string[] }).uncorrected).toContain('working memory');
    expect(off.verdict.sentence).toMatch(/blamed but only left out/);
    // with a suggester: the blamed parts are asked about, and the correction is played as its own arm
    const asked: string[] = [];
    const r = await diagnoseTurn({
      journal, runId: ids[1]!, model: agentModel(ships), tools: trap(), expect: ANKARA, trials: 6,
      suggest: suggester({ corrections: [{ part: 'working memory', text: '# Working Memory\naddress: Ankara' }] }, asked),
    });
    expect(r.suggestions).toEqual([{ part: 'working memory', text: '# Working Memory\naddress: Ankara' }]);
    expect(r.verdict).toMatchObject({ kind: 'cause', arm: 'correct:working memory' });
    expect(r.arms.find((a) => a.id === 'correct:working memory')!.label).toBe('working memory corrected (suggested)');
    // the suggester was shown only the blamed parts — never one elimination did not blame
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('[working memory]');
    expect(asked[0]).not.toContain('[turn 1]');
    // its tokens are counted: a suggester that proposes nothing changes no arm, only the totals
    const quiet = await diagnoseTurn({ journal, runId: ids[1]!, model: agentModel(ships), tools: trap(), expect: ANKARA, trials: 6, suggest: suggester({ corrections: [] }) });
    expect(quiet.arms.map((a) => a.id)).toEqual(off.arms.map((a) => a.id));
    expect(quiet.inputTokens - off.inputTokens).toBe(usage.inputTokens);
  });

  it("a suggestion for a part elimination did not blame, or one that changes nothing, is not played", async () => {
    const memory = windowMemory(4, WRONG_WM);
    const { journal, ids } = await recordThread(['Hello.', 'Ship my order.'], { memory, model: agentModel(ships), system: SYSTEM });
    const plan = await threadPlan({ journal, threadId: 't' });
    const unblamed = plan.turns[1]!.experiments!.suspects.find((s) => s.kind !== 'wm' && s.kind !== 'system')!.id;
    const r = await diagnoseTurn({
      journal, runId: ids[1]!, model: agentModel(ships), tools: trap(), expect: ANKARA, trials: 4,
      suggest: suggester({ corrections: [{ part: unblamed, text: 'Ship it to Ankara.' }, { part: 'working memory', text: '# Working Memory\naddress: Izmir' }] }),
    });
    expect(r.suggestions).toEqual([]);
    expect(r.arms.some((a) => a.intervention === 'correct')).toBe(false);
  });

  it("the person's own correction of an earlier message is played, whatever elimination blamed", async () => {
    const said = (o: any) => {
      if (!JSON.stringify((o.prompt as any[]).filter((m) => m.role === 'user').at(-1)).includes('Ship')) return final('Noted.');
      const all = [...text(o).matchAll(/address is (\w+)/g)];
      return all.length ? call('createOrder', { address: all.at(-1)![1] }) : final('Which address?');
    };
    const { journal, ids } = await recordThread(['My address is Izmir.', 'Ship my order.'], { memory: windowMemory(4), model: agentModel(said), system: 'You are a shop agent.' });
    const plan = await threadPlan({ journal, threadId: 't' });
    const part = plan.turns[1]!.experiments!.suspects.find((s) => s.preview.includes('Izmir'))!.id;
    const r = await diagnoseTurn({ journal, runId: ids[1]!, model: agentModel(said), tools: trap(), expect: ANKARA, trials: 6, corrections: { [part]: 'My address is Ankara.' } });
    expect(r.verdict).toMatchObject({ kind: 'cause', arm: `correct:${part}` });
    expect(r.arms.find((a) => a.id === `correct:${part}`)!.label).toBe(`${part} corrected`);
  });

  it("a tool's result corrected as JSON is put in place of each of its recorded results", async () => {
    const model = () => { const m = createMockModel(async (o: any) => {
      const results = toolResults(o);
      if (results.length === 0) return call('lookup', {}, 'l1');
      if (results.length === 1) { const a = /"address":"(\w+)"/.exec(JSON.stringify(results[0])); return call('createOrder', { address: a ? a[1] : 'unknown' }, 'c1'); }
      return final('Done.');
    }); m.modelId = 'cheap'; return m; };
    const { journal, ids } = await recordThread(['Ship my order to the address on file.'], { memory: windowMemory(4), model: model(), system: 'You are a shop agent.' });
    const r = await diagnoseTurn({ journal, runId: ids[0]!, model: model(), tools: trap(), expect: ANKARA, trials: 6, corrections: { 'lookup result': '{"address":"Ankara"}' } });
    expect(r.verdict).toMatchObject({ kind: 'cause', arm: 'correct:lookup result' });
    expect(r.arms.find((a) => a.id === 'correct:lookup result')!.paths[0]!.calls.map((c) => `${c.toolName}:${c.source}`)).toEqual(['lookup:override', 'createOrder:none']);
  });

  it('a correction of a part the turn does not have is said so, and not played', async () => {
    const { journal, ids } = await recordThread(['Ship my order.'], { memory: windowMemory(4, WRONG_WM), model: agentModel(ships), system: SYSTEM });
    const r = await diagnoseTurn({ journal, runId: ids[0]!, model: agentModel(ships), tools: trap(), expect: ANKARA, trials: 2, corrections: { 'no such part': 'x' } });
    expect(r.notes.some((n) => /'no such part'.*not tried/.test(n))).toBe(true);
    expect(r.arms.some((a) => a.intervention === 'correct')).toBe(false);
  });

  it("a suggester's reply is read leniently: its first JSON object, nothing usable is nothing", () => {
    expect(parseSuggestions('Sure! {"corrections":[{"part":"a","text":"b"}]} hope that helps')).toEqual([{ part: 'a', text: 'b' }]);
    expect(parseSuggestions('no idea')).toEqual([]);
    expect(parseSuggestions('{"corrections":[{"part":1,"text":"b"},{"part":"c"}]}')).toEqual([]);
  });
});
