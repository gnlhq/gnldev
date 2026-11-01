// @vitest-environment jsdom
// The Lab's tools beyond explaining a run: which words decided its next call (each share with its chance
// when the value was sampled), whether removing a prompt section changes anything (its tools answered
// from the page, the control saying whether the check can tell), a best form's tools taken away or
// written on the page, and only the ticked scenarios played.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Words, groupsOf, byChance } from '../src/views/lab-words';
import { Prune, otherwiseOf } from '../src/views/lab-prune';
import { Lab, NewAgent, formToolOf } from '../src/views/Lab';
import { PANEL_ROUTES } from './lab-panel-fixtures';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); posts.length = 0; gets.length = 0; });
vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });

const posts: Array<{ url: string; body: any }> = [];
const gets: string[] = [];
function stubFetch(routes: Record<string, unknown>) {
  routes = { ...PANEL_ROUTES, ...routes };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST') posts.push({ url: u, body: JSON.parse(String(init.body)) }); else gets.push(u);
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => u.includes(k));
    const value = key ? routes[key] : {};
    if ((init?.headers as Record<string, string> | undefined)?.accept === 'text/event-stream') {
      const bytes = new TextEncoder().encode(`event: done\ndata: ${JSON.stringify(value)}\n\n`);
      return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) };
    }
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => value };
  }));
}
function wrap(node: React.ReactNode, at = '/lab') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter initialEntries={[at]}><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>);
}
/** The confirmation's own button: the last one by that name. */
const confirm = async (name: string | RegExp) => fireEvent.click((await screen.findAllByRole('button', { name })).at(-1)!);

describe('pure', () => {
  it('groups are lines; a share within two standard deviations is chance; a default answer is JSON or nothing', () => {
    expect(groupsOf(' It arrived\n\nbroken \n')).toEqual(['It arrived', 'broken']);
    expect(byChance({ share: 0.1, sd: 0.06 })).toBe(true);
    expect(byChance({ share: 0.2, sd: 0.06 })).toBe(false);
    expect(byChance({ share: 0 })).toBe(false);
    expect(otherwiseOf({ a: '{"ok":true}', b: ' ' })).toEqual({ otherwise: { a: { ok: true } } });
    expect(otherwiseOf({ a: '{nope' })).toEqual({ bad: 'a' });
    expect(formToolOf({ name: 'escalate', description: 'Hand over', parameters: '', output: '' }, [])).toEqual({ tool: { name: 'escalate', description: 'Hand over', parameters: { type: 'object' }, output: null } });
    expect(formToolOf({ name: 'bad name', description: '', parameters: '', output: '' }, [])).toEqual({ error: 'name' });
    expect(formToolOf({ name: 'refund', description: '', parameters: '', output: '' }, ['refund'])).toEqual({ error: 'taken' });
    expect(formToolOf({ name: 'x', description: '', parameters: '{"type":"string"}', output: '' }, [])).toEqual({ error: 'parameters' });
    expect(formToolOf({ name: 'x', description: '', parameters: '', output: '{' }, [])).toEqual({ error: 'output' });
  });
});

describe('which words decided', () => {
  const plan = { runId: 'r', agent: 'a', words: ['It arrived', 'broken,', 'refund please.'], tools: ['lookup', 'refund'], tool: 'lookup', method: 'sampled', samples: 5, subsets: 8, calls: 40, estimatedTokens: 4000, estimatedCostUsd: 0.002 };
  const result = { agent: 'a', model: 'm', tool: 'refund', method: 'sampled', samples: 5, full: 0.8, none: 0, calls: 8, inputTokens: 3000, outputTokens: 100, costUsd: 0.001, priced: true,
    shares: [{ word: 'It arrived', share: 0.02, sd: 0.05 }, { word: 'broken,', share: 0.08, sd: 0.05 }, { word: 'refund please.', share: 0.7, sd: 0.05 }] };

  it('plans before it spends, sends the groups as edited and the tool chosen, and marks a share chance can make', async () => {
    stubFetch({ '/lab/words-plan': plan, '/lab/words': result });
    wrap(<Words runId="r" models={['m']} />);
    expect((await screen.findByTestId('words-plan')).textContent).toMatch(/8 subsets × 5 tries = 40 calls/);
    expect(screen.getByText(/gives no probability for a tool call/)).toBeTruthy();
    fireEvent.change(screen.getByTestId('words-groups'), { target: { value: 'It arrived broken,\nrefund please.' } });
    // the plan is asked again with the edited groups
    await waitFor(() => expect(gets.some((g) => g.includes('/lab/words-plan') && decodeURIComponent(g).includes('["It arrived broken,","refund please."]'))).toBe(true));
    fireEvent.change(screen.getByTestId('words-tool'), { target: { value: 'refund' } });
    fireEvent.click(screen.getByRole('button', { name: 'Measure the words' }));
    await confirm('Measure the words');
    const r = await screen.findByTestId('words-result');
    expect(posts.at(-1)).toMatchObject({ url: expect.stringContaining('/lab/words'), body: { runId: 'r', model: 'm', tool: 'refund', words: ['It arrived broken,', 'refund please.'], samples: 5 } });
    expect(r.textContent).toMatch(/'refund' is picked 80% of the time; with no words, 0%/);
    // ± is two standard deviations; the first share is inside it
    expect(within(r).getAllByTestId('words-chance')).toHaveLength(2);
    expect(within(r).getAllByTestId('words-share')[2]!.textContent).toMatch(/\+0\.70.*± 0\.10/);
  });

  it('more groups than ten: said, and nothing can be spent', async () => {
    stubFetch({ '/lab/words-plan': plan });
    wrap(<Words runId="r" models={['m']} />);
    await screen.findByTestId('words-plan');
    fireEvent.change(screen.getByTestId('words-groups'), { target: { value: Array.from({ length: 11 }, (_, i) => `w${i}`).join('\n') } });
    expect(screen.getByRole('alert').textContent).toMatch(/11 groups; at most 10/);
    expect((screen.getByRole('button', { name: 'Measure the words' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('removing a section', () => {
  const plan = { runId: 'r', agent: 'a', sections: [{ id: 'system 1', kind: 'system', source: 'layout', preview: 'You are a support agent.' }, { id: 'system 2', kind: 'system', source: 'layout', preview: 'Always look the order up first.' }, { id: 'system 3', kind: 'system', source: 'layout', preview: 'Be brief.' }],
    tools: [{ name: 'lookup', description: 'Look an order up', parameters: { type: 'object' } }], arms: 4, runs: 40, estimatedTokens: 44000, estimatedCostUsd: 0.01 };
  const result = { agent: 'a', model: 'm', noise: 0.05, removed: { distance: 0.04, perPrompt: [{ prompt: 'It is cracked.', distance: 0.04 }] }, control: { distance: 0.9, perPrompt: [{ prompt: 'It is cracked.', distance: 0.9 }] },
    harmless: true, controlSeparates: true, runs: 40, failed: 0, inputTokens: 40000, outputTokens: 400, costUsd: 0.01, priced: true, unanswered: [{ toolName: 'refund', args: { orderId: '7' }, count: 3 }] };

  it('the last section picked by default, a control and new messages, each tool answered — and the verdict beside the noise', async () => {
    stubFetch({ '/lab/prune-plan': plan, '/lab/prune': result });
    wrap(<Prune runId="r" models={['m']} />);
    await screen.findByText('Always look the order up first.');
    const go = screen.getByRole('button', { name: 'Try removing it' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true); // no message yet
    fireEvent.change(screen.getByTestId('prune-control'), { target: { value: 'system 2' } });
    fireEvent.change(screen.getByTestId('prune-prompts'), { target: { value: 'It is cracked.' } });
    fireEvent.change(screen.getByTestId('prune-answer'), { target: { value: '{"item":"lamp"}' } });
    expect((await screen.findByTestId('prune-plan')).textContent).toMatch(/4 arms × 1 messages × 10 runs = 40 runs/);
    fireEvent.click(go);
    await confirm('Try removing it');
    const r = await screen.findByTestId('prune-result');
    expect(posts.at(-1)!.body).toEqual({ runId: 'r', model: 'm', remove: 'system 3', control: 'system 2', prompts: ['It is cracked.'], trials: 10, otherwise: { lookup: { item: 'lamp' } } });
    expect(within(r).getByTestId('prune-verdict').textContent).toMatch(/harmless on these messages.*4% apart.*5% \(the noise\)/);
    expect(within(r).getByTestId('prune-control-line').textContent).toMatch(/90% apart: the check can tell/);
    expect(within(r).getByTestId('prune-unanswered').textContent).toMatch(/refund.*× 3/);
  });

  it('an answer that is not JSON is named and nothing is sent; a prompt of one section has nothing to remove', async () => {
    stubFetch({ '/lab/prune-plan': plan });
    wrap(<Prune runId="r" models={['m']} />);
    await screen.findByText('Be brief.');
    fireEvent.change(screen.getByTestId('prune-prompts'), { target: { value: 'x' } });
    fireEvent.change(screen.getByTestId('prune-answer'), { target: { value: '{nope' } });
    expect(screen.getByRole('alert').textContent).toMatch(/lookup's answer is not valid JSON/);
    expect((screen.getByRole('button', { name: 'Try removing it' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    stubFetch({ '/lab/prune-plan': { ...plan, sections: plan.sections.slice(0, 1) } });
    wrap(<Prune runId="r" models={['m']} />);
    expect(await screen.findByTestId('prune-one-section')).toBeTruthy();
  });
});

describe("a new agent's forms with tools", () => {
  it('a tool the scenarios offer taken away, one written on the page added — both planned and sent', async () => {
    const formPlan = { agent: 'kritik', components: [{ id: 'section 1', kind: 'system', preview: 'x' }], scenarios: 1, trials: 2, forms: 2, runs: 4, tools: ['getOrder', 'refund'] };
    stubFetch({ '/lab/scenarios': { items: [{ id: 's1', category: 'c', prompt: 'p' }] }, '/lab/form-plan': formPlan, '/lab/best-form': { agent: 'kritik', model: 'm', forms: [], shares: {}, target: 0, componentsDetail: [], scenarios: ['s1'] }, '/lab/experiments': { items: [] } });
    wrap(<NewAgent agent="kritik" models={['m']} />);
    const box = await screen.findByTestId('form-tools');
    fireEvent.click((await within(box).findAllByTestId('form-without'))[0]!);
    fireEvent.change(within(box).getByTestId('form-tool-name'), { target: { value: 'escalate' } });
    fireEvent.click(within(box).getByRole('button', { name: 'Add' }));
    expect(within(box).getByTestId('form-added').textContent).toMatch(/escalate/);
    await waitFor(() => expect(gets.some((g) => g.includes('/lab/form-plan') && g.includes('withoutTools=getOrder') && decodeURIComponent(g).includes('"name":"escalate"'))).toBe(true));
    // a name the scenarios offer already is refused before anything is asked
    fireEvent.change(within(box).getByTestId('form-tool-name'), { target: { value: 'refund' } });
    fireEvent.click(within(box).getByRole('button', { name: 'Add' }));
    expect(within(box).getByRole('alert').textContent).toMatch(/already/);
    fireEvent.click(screen.getByRole('button', { name: 'Try every form' }));
    await confirm('Try every form');
    await waitFor(() => expect(posts.at(-1)?.body).toMatchObject({ agent: 'kritik', withoutTools: ['getOrder'], addTools: [{ name: 'escalate', parameters: { type: 'object', properties: {} }, output: { ok: true } }] }));
  });
});

describe('only the ticked scenarios', () => {
  const kept = (id: string, title: string) => ({ v: 1, id, agent: 'kritik', title, at: 1, by: 'u', from: { runId: 'r' }, system: '', messages: [], expect: { calls: [{ toolName: 'refund' }] }, results: [], answers: [] });
  it('ticking two plays those two, by id; none ticked plays them all', async () => {
    const items = [kept('a', 'First'), kept('b', 'Second'), kept('c', 'Third')];
    stubFetch({ '/lab/saved-scenarios/run': { agent: 'kritik', model: 'm', scenarios: [], allPassed: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, priced: false }, '/lab/saved-scenarios': { items }, '/lab/scenarios': { items: [] }, '/lab': { agents: ['kritik'], models: ['m'] }, '/capabilities': { lab: true } });
    wrap(<Lab />, '/lab?mode=scenarios');
    const ticks = await screen.findAllByTestId('saved-tick');
    fireEvent.click(ticks[0]!); fireEvent.click(ticks[2]!);
    fireEvent.click(screen.getByRole('button', { name: 'Play the ticked (2)' }));
    await confirm('Play the ticked (2)');
    await waitFor(() => expect(posts.at(-1)?.body).toMatchObject({ agent: 'kritik', ids: ['a', 'c'] }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tick all' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tick all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Play them all' }));
    await confirm('Play them all');
    await waitFor(() => expect(posts.length).toBe(2));
    expect(posts.at(-1)!.body.ids).toBeUndefined();
  });
});
