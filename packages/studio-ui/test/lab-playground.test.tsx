// @vitest-environment jsdom
// The New agent tab is a playground: an agent written on the page — copied from one the code defines, or
// from nothing — talked to with every tool call answered from the page, measured against what a right
// answer does beside an earlier definition (A), and kept as a scenario. The older form search is below it.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n';
import { Lab } from '../src/views/Lab';
import { definitionOf, lastTurnOf, emptyTool } from '../src/views/lab-playground';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const posts: Array<{ url: string; body: any }> = [];
function stub(routes: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST') posts.push({ url: u, body: JSON.parse(String(init.body)) });
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => u.includes(k));
    const value = key ? routes[key] : {};
    if ((init?.headers as Record<string, string> | undefined)?.accept === 'text/event-stream') {
      const bytes = new TextEncoder().encode(`event: done\ndata: ${JSON.stringify(value)}\n\n`);
      return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) };
    }
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => value };
  }));
}
function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter initialEntries={['/lab?mode=new']}><QueryClientProvider client={qc}><Lab /></QueryClientProvider></MemoryRouter>);
}
const base = { agent: 'kritik', system: 'You are an order assistant.', systemFixed: true, tools: [{ name: 'getOrder', description: 'Look an order up', parameters: { type: 'object', properties: { orderId: { type: 'string' } } } }] };
const answered = { text: 'Your order is shipped.', calls: [{ toolName: 'getOrder', args: { orderId: '42' }, source: 'answer', output: { status: 'shipped' } }],
  messages: [{ role: 'assistant', content: [{ type: 'tool-call', toolName: 'getOrder' }] }, { role: 'tool', content: [{ type: 'tool-result', toolName: 'getOrder' }] }, { role: 'assistant', content: 'Your order is shipped.' }],
  inputTokens: 200, outputTokens: 20, costUsd: 0, priced: false };
const routes = {
  '/capabilities': { lab: true },
  '/lab/playground/base': base,
  '/lab/experiments': { items: [] },
  '/lab/scenarios': { items: [] },
  '/lab/form-plan': { agent: 'kritik', components: [], scenarios: 0, trials: 2, forms: 1, runs: 0 },
  '/lab': { agents: ['kritik'], models: ['small/model'] },
};

describe('the playground (pure)', () => {
  it("the page's drafts read back as a definition; a field that is not JSON is named", () => {
    const tool = { ...emptyTool(), name: 'getOrder', answers: [{ args: '{"orderId":"42"}', output: '{"status":"shipped"}' }], otherwise: '{"status":"unknown"}' };
    expect(definitionOf('Be brief.', [tool])).toEqual({ agent: { system: 'Be brief.', tools: [{ name: 'getOrder', description: '', parameters: { type: 'object', properties: {} }, answers: [{ args: { orderId: '42' }, output: { status: 'shipped' } }], otherwise: { output: { status: 'unknown' } } }] } });
    expect(definitionOf('x', [{ ...tool, parameters: '{' }])).toEqual({ bad: 'getOrder: parameters' });
    expect(definitionOf('x', [{ ...tool, answers: [{ args: '{}', output: 'nope' }] }])).toEqual({ bad: 'getOrder({})' });
    expect(definitionOf('x', [{ ...tool, name: ' ' }])).toEqual({ bad: '(tool name)' });
  });
  it('a measure plays the conversation up to its last user message', () => {
    expect(lastTurnOf([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' }]).map((m) => m.content)).toEqual(['a', 'b', 'c']);
    expect(lastTurnOf([])).toEqual([]);
  });
});

describe('the playground', () => {
  it('copied from an agent of the code, talked to, a call nothing answers answered, measured beside A, kept as a scenario', async () => {
    posts.length = 0;
    stub({ ...routes, '/lab/playground/play': answered });
    wrap();
    const pg = await screen.findByTestId('lab-playground');
    fireEvent.change(within(pg).getByRole('combobox', { name: 'Start from:' }), { target: { value: 'kritik' } });
    await waitFor(() => expect((within(pg).getByRole('textbox', { name: 'System prompt' }) as HTMLTextAreaElement).value).toBe('You are an order assistant.'));
    expect((within(pg).getByRole('textbox', { name: 'Agent name' }) as HTMLInputElement).value).toBe('kritik'); // a copy keeps its agent's name
    expect(within(pg).getAllByTestId('pg-tool')).toHaveLength(1);
    // an answer for the call, written on the page
    fireEvent.click(within(pg).getByRole('button', { name: 'Add an answer' }));
    fireEvent.change(within(pg).getByRole('textbox', { name: 'getOrder arguments (JSON)' }), { target: { value: '{"orderId":"42"}' } });
    fireEvent.change(within(pg).getByRole('textbox', { name: 'What getOrder({"orderId":"42"}) returns' }), { target: { value: '{"status":"shipped"}' } });
    fireEvent.change(within(pg).getByRole('textbox', { name: 'User message' }), { target: { value: 'Where is order 42?' } });
    fireEvent.click(within(pg).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(within(pg).getAllByTestId('pg-message')).toHaveLength(4));
    const play = posts.find((p) => p.url.includes('/lab/playground/play'))!;
    expect(play.body).toEqual({
      agent: { system: 'You are an order assistant.', tools: [{ name: 'getOrder', description: 'Look an order up', parameters: { type: 'object', properties: { orderId: { type: 'string' } } }, answers: [{ args: { orderId: '42' }, output: { status: 'shipped' } }] }] },
      model: 'small/model', messages: [{ role: 'user', content: 'Where is order 42?' }],
    });
    expect(within(pg).getByTestId('pg-calls').textContent).toMatch(/getOrder\(\{"orderId":"42"\}\)\s*your answer/);

    // a call nothing answers: the play stops, named, and one click opens its answer
    cleanup(); posts.length = 0;
    stub({ ...routes, '/lab/playground/play': { text: '', calls: [{ toolName: 'getOrder', args: { orderId: '7' }, source: 'none' }], stopped: { toolName: 'getOrder', args: { orderId: '7' } }, messages: [], inputTokens: 1, outputTokens: 1, costUsd: 0, priced: false } });
    wrap();
    const pg2 = await screen.findByTestId('lab-playground');
    fireEvent.change(within(pg2).getByRole('combobox', { name: 'Start from:' }), { target: { value: 'kritik' } });
    await waitFor(() => expect(within(pg2).getAllByTestId('pg-tool')).toHaveLength(1));
    fireEvent.change(within(pg2).getByRole('textbox', { name: 'User message' }), { target: { value: 'Where is order 7?' } });
    fireEvent.click(within(pg2).getByRole('button', { name: 'Send' }));
    expect((await within(pg2).findByTestId('pg-stopped')).textContent).toMatch(/getOrder\(\{"orderId":"7"\}\)/);
    fireEvent.click(within(pg2).getByRole('button', { name: 'Answer this call' }));
    expect((within(pg2).getByRole('textbox', { name: 'getOrder arguments (JSON)' }) as HTMLInputElement).value).toBe('{"orderId":"7"}');
    expect((within(pg2).getByRole('textbox', { name: 'User message' }) as HTMLInputElement).value).toBe('Where is order 7?'); // kept, to send again

    // measured beside A, then kept as a scenario
    const measure = { model: 'small/model', inputTokens: 100, outputTokens: 10, costUsd: 0, priced: false,
      measure: { passed: 5, failed: 0, undetermined: 0, errored: 0, passRate: { value: 1, low: 0.57, high: 1, n: 5 }, paths: [{ calls: [], text: 'ok', count: 5, passed: 5 }], pending: [] },
      compared: { passed: 0, failed: 5, undetermined: 0, errored: 0, passRate: { value: 0, low: 0, high: 0.43, n: 5 }, paths: [{ calls: [], text: 'Which order?', count: 5, passed: 0, failures: ['getOrder was not called'] }], pending: [] },
      difference: { value: 1, low: 0.4, high: 1, n: 5 } };
    cleanup(); posts.length = 0;
    const own = { v: 1, id: 'sc-9', agent: 'destek-v2', title: 'Order 42 is looked up', at: 1, by: 'x', from: { playground: true }, expect: { calls: [{ toolName: 'getOrder' }] }, results: [], answers: [] };
    const ownRuns = { agent: 'destek-v2', model: 'small/model', allPassed: 0, inputTokens: 10, outputTokens: 1, costUsd: 0, priced: false,
      scenarios: [{ id: 'sc-9', title: 'Order 42 is looked up', passed: 0, failed: 3, undetermined: 0, errored: 0, passRate: { value: 0, low: 0, high: 0.56, n: 3 }, failures: ['getOrder was not called'], pending: [] }] };
    stub({ ...routes, '/lab/playground/measure': measure, '/lab/playground/scenarios/run': ownRuns, '/lab/playground/scenario': own, '/lab/saved-scenarios': { items: [own] } });
    wrap();
    const pg3 = await screen.findByTestId('lab-playground');
    fireEvent.change(within(pg3).getByRole('textbox', { name: 'User message' }), { target: { value: 'Where is order 42?' } });
    fireEvent.change(within(pg3).getByRole('textbox', { name: /Must call/ }), { target: { value: 'getOrder' } });
    fireEvent.click(within(pg3).getByRole('button', { name: 'Pin this definition as A' }));
    fireEvent.change(within(pg3).getByRole('textbox', { name: 'System prompt' }), { target: { value: 'Look the order up.' } });
    fireEvent.click(within(pg3).getByRole('button', { name: 'Measure against A' }));
    expect(await screen.findByText(/10 plays with small\/model .* 5 plays with the definition now, 5 with A/)).toBeTruthy();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Measure' })).at(-1)!);
    expect((await within(pg3).findByTestId('pg-compare')).textContent).toMatch(/A: 0\/5 → now: 5\/5.*past chance/);
    const m = posts.find((p) => p.url.includes('/lab/playground/measure'))!;
    expect(m.body).toMatchObject({ agent: { system: 'Look the order up.' }, compareTo: { system: '' }, trials: 5, expect: { calls: [{ toolName: 'getOrder' }] }, messages: [{ role: 'user', content: 'Where is order 42?' }] });
    // a blank agent has no name: nothing is kept until it has one — never under another agent's
    fireEvent.change(within(within(pg3).getByTestId('pg-save')).getByRole('textbox'), { target: { value: 'Order 42 is looked up' } });
    const keep = within(pg3).getByRole('button', { name: 'Keep as scenario' }) as HTMLButtonElement;
    expect(keep.disabled).toBe(true);
    expect(within(pg3).getByTestId('pg-save').textContent).toMatch(/Give the agent a name above first/);
    expect(within(pg3).queryByRole('combobox', { name: /A scenario of agent/ })).toBeNull();
    fireEvent.change(within(pg3).getByRole('textbox', { name: 'Agent name' }), { target: { value: 'destek-v2' } });
    await waitFor(() => expect(keep.disabled).toBe(false));
    fireEvent.click(keep);
    await waitFor(() => expect(posts.some((p) => p.url.includes('/lab/playground/scenario'))).toBe(true));
    expect(posts.find((p) => p.url.endsWith('/lab/playground/scenario'))!.body).toMatchObject({ agent: 'destek-v2', title: 'Order 42 is looked up', definition: { system: 'Look the order up.' }, messages: [{ role: 'user', content: 'Where is order 42?' }] });
    // its own scenarios, played against the definition on the page now
    const ownBox = await within(pg3).findByTestId('pg-own-scenarios');
    expect(within(ownBox).getByTestId('pg-own-row').textContent).toMatch(/Order 42 is looked up/);
    fireEvent.click(within(ownBox).getByRole('button', { name: 'Play them all with this definition' }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Play them all with this definition' })).at(-1)!);
    await waitFor(() => expect(within(ownBox).getByTestId('pg-own-row').textContent).toMatch(/0 of 3 plays right.*getOrder was not called/));
    expect(posts.find((p) => p.url.includes('/lab/playground/scenarios/run'))!.body).toMatchObject({ agent: 'destek-v2', definition: { system: 'Look the order up.' }, trials: 3 });
    expect(posts.find((p) => p.url.includes('/lab/playground/scenarios/run'))!.body.ids).toBeUndefined();
    // ticked, only that one is played, by id
    fireEvent.click(within(ownBox).getByTestId('pg-own-tick'));
    fireEvent.click(within(ownBox).getByRole('button', { name: 'Play the ticked (1)' }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Play the ticked (1)' })).at(-1)!);
    await waitFor(() => expect(posts.filter((p) => p.url.includes('/lab/playground/scenarios/run')).at(-1)!.body.ids).toEqual(['sc-9']));
    // the older form search is still here, below
    expect(within(pg3).getByTestId('pg-forms')).toBeTruthy();
  });
});
