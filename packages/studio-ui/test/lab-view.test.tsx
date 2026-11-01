// @vitest-environment jsdom
// Lab view: the signed shares (pure), the disabled state, a run sent from the Inspector, the plan before
// anything is spent, and an explanation that goes through the confirmation and says first whether the
// recording can be trusted and whether the outcome depends on the parts at all.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Lab, formatSigned, barWidth, formatRate, formCost, overlapping, mostlyFailing, capsuleBody, answerKey, callLabel, withinNoise, playsOf, experimentSummary, draftOf, expectationOf } from '../src/views/Lab';
import { resultsOf } from '../src/views/lab-scenarios';
import { PANEL_ROUTES } from './lab-panel-fixtures';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });

const posts: Array<{ url: string; body: unknown }> = [];
/** A POST asked as a stream gets `progress` events, then `done` with the route's value — or `error`, given one. */
function stubFetch(routes: Record<string, unknown>, stream: { progress?: unknown[]; error?: string } = {}) {
  routes = { ...PANEL_ROUTES, ...routes };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST') posts.push({ url: u, body: JSON.parse(String(init.body)) });
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => u.includes(k));
    const value = key ? routes[key] : {};
    if ((init?.headers as Record<string, string> | undefined)?.accept === 'text/event-stream') {
      const sse = [...(stream.progress ?? []).map((p) => `event: progress\ndata: ${JSON.stringify(p)}\n\n`),
        stream.error ? `event: error\ndata: ${JSON.stringify({ error: stream.error, status: 500 })}\n\n` : `event: done\ndata: ${JSON.stringify(value)}\n\n`].join('');
      const bytes = new TextEncoder().encode(sse);
      return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) };
    }
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => value };
  }));
}
function wrap(node: React.ReactNode, at = '/lab') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter initialEntries={[at]}><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>);
}

const parts = [
  { id: 'system 1', kind: 'system', preview: 'Sipariş asistanısın.' },
  { id: 'turn 1', kind: 'turn', preview: 'createOrder aracını çağır · [createOrder] · [createOrder result]' },
  { id: 'turn 2', kind: 'turn', preview: 'createOrder aracını çağır' },
];
const plan = { runId: 'run-7', agent: 'kritik', parts, trials: 3, replays: 24, tokensPerReplay: 2059, estimatedTokens: 36000, estimatedCostUsd: 0.0026 };
const explanation = {
  runId: 'run-7', agent: 'kritik', model: 'small/model', parts: parts.map((p) => p.id), partsDetail: parts,
  recordedCalls: [{ toolName: 'createOrder' }],
  representative: { value: 1, low: 0.6, high: 1, n: 6, ok: true },
  dependsOnParts: false,
  shares: [{ part: 'turn 1', share: 0.14, noise: 0.04 }, { part: 'system 1', share: 0.03, noise: 0.05 }, { part: 'turn 2', share: -0.22, noise: 0.03 }],
  replays: 24, failed: 1, inputTokens: 37000, outputTokens: 2300, costUsd: 0, priced: false,
};
// The Improve tab shows the explanation and the capsule of the run together: both are asked for.
const baseOfRun = { runId: 'run-7', agent: 'kritik', system: 'Help with orders.', tools: [], earlierMessages: 0, memoryMessages: null, lastMessage: 'Hi.', recordedCalls: [], tokensPerPlay: 1000 };
const routes = {
  '/capabilities': { lab: true },
  '/lab/plan': plan,
  '/lab/capsule': baseOfRun,
  '/lab/explain': explanation,
  '/lab': { agents: ['kritik'], models: ['small/model'] },
};

describe('formatting (pure)', () => {
  it('a share with its sign; a bar relative to the largest', () => {
    expect(formatSigned(0.141)).toBe('+0.14');
    expect(formatSigned(-0.216)).toBe('−0.22');
    expect(formatSigned(-0.125)).toBe('−0.13'); // by magnitude: Math.round would give −0.12
    expect(formatSigned(-0.001)).toBe('0.00');
    expect(formatSigned(0)).toBe('0.00');
    expect(formatSigned(null)).toBe('—');
    expect(barWidth(-0.11, 0.22)).toBe(50);
    expect(barWidth(0, 0)).toBe(0);
    expect(formatRate(0.833)).toBe('83%');
    expect(formatRate(null)).toBe('—');
    expect(formCost({ priced: false, costUsd: 0, tokens: 12345.6 }, (n) => `${n} tokens`)).toBe('12,346 tokens');
    expect(formCost({ priced: true, costUsd: 0.0042, tokens: 1 }, (n) => n)).toBe('$0.0042');
    // measured in a browser: best 100% [76–100], others reaching 76% are not told apart from it
    const f = (components: string[], low: number, high: number) => ({ components, passRate: { value: 0, low, high, n: 12 } });
    expect(overlapping(f(['a'], 0.76, 1), [f(['a'], 0.76, 1), f(['b'], 0.65, 0.99), f([], 0.47, 0.91), f(['c'], 0.2, 0.5)])).toBe(2);
    // the warning to stop: half or more of at least four
    expect(mostlyFailing({ done: 3, failed: 3 })).toBe(false);
    expect(mostlyFailing({ done: 4, failed: 2 })).toBe(true);
    expect(mostlyFailing({ done: 10, failed: 4 })).toBe(false);
  });
});

describe('the capsule request (pure)', () => {
  const base = { runId: 'run-7', system: 'Help with orders.', tools: [{ name: 'findOrder', description: 'Find an order' }, { name: 'replace', description: 'Replace an order' }] };
  const rows = base.tools.map((x) => ({ ...x, keep: true, added: false }));
  const plain = { model: 'small/model', trials: 3, system: base.system, tools: rows, history: true };

  it('unchanged, only the run, the model and the trials go — the server keeps the rest as recorded', () => {
    expect(capsuleBody(base, plain, {})).toEqual({ body: { runId: 'run-7', model: 'small/model', trials: 3 } });
  });

  it('what changed goes: the prompt, every kept tool once one changed, history off, the typed answers as JSON', () => {
    const tools = [{ ...rows[0]!, description: 'Find an order first' }, { ...rows[1]!, keep: false }, { name: 'refund', description: 'Refund', keep: true, added: true, parameters: { type: 'object' } }];
    const answers = {
      a: { toolName: 'refund', args: { orderId: '42' }, text: '{"refunded": 250}' },
      b: { toolName: 'refund', args: { orderId: '43' }, text: '  ' },
    };
    expect(capsuleBody(base, { ...plain, system: 'Refund broken items.', tools, history: false }, answers)).toEqual({ body: {
      runId: 'run-7', model: 'small/model', trials: 3, system: 'Refund broken items.', history: false,
      tools: [{ name: 'findOrder', description: 'Find an order first' }, { name: 'refund', description: 'Refund', parameters: { type: 'object' } }],
      answers: [{ toolName: 'refund', args: { orderId: '42' }, output: { refunded: 250 } }],
    } });
    expect(capsuleBody(base, plain, { a: { toolName: 'refund', args: { orderId: '42' }, text: 'refunded' } })).toEqual({ error: 'refund({"orderId":"42"})' });
  });

  it('an answer is kept under its call, whatever the order of the arguments', () => {
    expect(answerKey({ toolName: 'refund', args: { b: 1, a: { d: 2, c: 3 } } })).toBe(answerKey({ toolName: 'refund', args: { a: { c: 3, d: 2 }, b: 1 } }));
    expect(callLabel({ toolName: 'refund', args: { orderId: '42' } })).toBe('refund({"orderId":"42"})');
  });
});

describe('the Lab says only what it measured (pure)', () => {
  const t = (k: string, o?: Record<string, unknown>) => `${k}${o ? JSON.stringify(o) : ''}`;
  it('a share no larger than its own ± is noise, whatever its size — and one inside the measured band is too', () => {
    expect(withinNoise(-0.14, 0.43)).toBe(true);
    expect(withinNoise(0.34, 0.05)).toBe(false);
    expect(withinNoise(0.05, null)).toBe(true);
    expect(withinNoise(0.2, null)).toBe(false);
  });
  it('a change is played beside the run as it was: twice the plays; nothing changed, once', () => {
    expect(playsOf({ runId: 'r', model: 'm', trials: 5 })).toBe(5);
    expect(playsOf({ runId: 'r', model: 'm', trials: 5, system: 'x' })).toBe(10);
    expect(playsOf({ runId: 'r', model: 'm', trials: 5, history: false })).toBe(10);
  });
  it('an expectation written back to the page and read again is the same expectation', () => {
    const e = { calls: [{ toolName: 'refund', args: { orderId: '42' } }, { toolName: 'notify' }], forbidden: ['charge', 'cancel'], answerIncludes: ['sorry', ['30 days', 'thirty days']] };
    expect(expectationOf(draftOf(e))).toEqual({ expect: e });
  });
  it("a tool result that is not JSON is named, not saved", () => {
    expect(resultsOf([{ toolName: 'lookup', args: '{}', output: '{"a":1}' }])).toEqual({ results: [{ toolName: 'lookup', args: {}, output: { a: 1 } }] });
    expect(resultsOf([{ toolName: 'lookup', args: '{}', output: 'not json' }])).toEqual({ bad: 'lookup({})' });
    expect(resultsOf([{ toolName: ' ', args: '{}', output: '1' }])).toEqual({ bad: '(tool name)' });
  });
  it('a kept search where no form passed says so, never names a best', () => {
    expect(experimentSummary({ kind: 'best-form', request: {}, result: { forms: [{ components: [] }], shares: {}, target: 0 } }, t)).toBe('keptFormNone');
  });
});

describe('a run the Lab will not take', () => {
  it("says why in the reader's words: a run with no agent, a run of an agent the Lab was not given", async () => {
    for (const [agent, text] of [[null, /has no agent — a scheduler or workflow run/], ['billing', /belongs to the agent 'billing', which this Lab was not given/]] as const) {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const u = String(url);
        // the explanation's plan, the capsule's base, and the words' and removal's plans are all refused for such a run
        if (['/lab/plan', '/lab/capsule', '/lab/words-plan', '/lab/prune-plan'].some((k) => u.includes(k))) return { ok: false, status: 422, statusText: 'Unprocessable', headers: { get: () => 'application/json' }, json: async () => ({ error: "@gnldev/lab: run 'r' is not a run of an agent the lab offers", code: 'agent-not-offered', agent }), clone() { return this; } };
        const body = u.endsWith('/lab') ? { agents: ['kritik'], models: ['m'] } : u.includes('/capabilities') ? { lab: true } : { items: [] };
        return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body };
      }));
      wrap(<Lab />, '/lab?runId=r');
      const refused = await screen.findAllByTestId('lab-refused');
      expect(refused.length).toBeGreaterThan(0);
      for (const r of refused) expect(r.textContent).toMatch(text);
      cleanup();
    }
  });
});

describe('the Lab view', () => {
  it('the tab says it is experimental, and why, where it is used', async () => {
    stubFetch({ '/capabilities': { lab: true }, '/lab': { agents: ['kritik'], models: ['m'] } });
    wrap(<Lab />);
    const badge = await screen.findByTestId('lab-experimental');
    expect(badge.textContent).toBe('Experimental');
    expect(badge.getAttribute('title')).toMatch(/7 cases so far \(4 named right\).*API may change/);
  });

  it('without the host option it says so instead of showing an empty tab', async () => {
    stubFetch({ '/capabilities': { lab: false } });
    wrap(<Lab />);
    expect(await screen.findByText('Lab is not enabled')).toBeTruthy();
  });

  it("with nothing sent from the Inspector it points there, and asks the lab for nothing", async () => {
    stubFetch(routes);
    const stubbed = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    wrap(<Lab />);
    expect((await screen.findByTestId('lab-pick-run')).textContent).toMatch(/Open a run or a thread in the Inspector and press “Open in Lab”/);
    expect(screen.getByRole('button', { name: 'Go to the Inspector' })).toBeTruthy();
    expect(stubbed.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/lab/'))).toEqual([]);
  });

  it("a run sent from the Inspector shows the parts proposed from its record and what explaining it takes", async () => {
    stubFetch(routes);
    wrap(<Lab />, '/lab?runId=run-7');
    expect(await screen.findByTestId('lab-plan')).toBeTruthy();
    expect(screen.getByText(/3 parts · 24 replays · ≈36,000 tokens in all · ≈ \$0\.0026/)).toBeTruthy();
    expect(screen.getByText('Sipariş asistanısın.')).toBeTruthy();
  });

  it('an explanation goes through the confirmation; the result says the outcome does not depend on the parts, then the signs', async () => {
    posts.length = 0;
    stubFetch(routes);
    wrap(<Lab />, '/lab?runId=run-7');
    await screen.findByTestId('lab-plan');
    fireEvent.click(screen.getByRole('button', { name: 'Explain' }));
    expect(posts).toEqual([]); // nothing is spent before the confirmation
    expect(await screen.findByText(/24 plays with small\/model · ≈36,000 tokens · ≈ \$0\.0026\. The conversation is sent to that model's provider\. No tool runs and no record changes\./)).toBeTruthy();
    const buttons = await screen.findAllByRole('button', { name: 'Explain' });
    fireEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(screen.getByTestId('lab-result')).toBeTruthy());
    expect(posts).toEqual([{ url: expect.stringContaining('/lab/explain'), body: { runId: 'run-7', model: 'small/model', trials: 3 } }]);
    expect(screen.getByRole('status').textContent).toMatch(/same with every part and with none/);
    expect(screen.queryByRole('alert')).toBeNull(); // the recording is representative
    const shares = screen.getAllByTestId('lab-share').map((li) => li.textContent);
    expect(shares[0]).toMatch(/turn 1.*\+0\.14/);
    expect(shares[2]).toMatch(/turn 2.*−0\.22/);
    expect(shares[1]).toMatch(/within noise/);
    expect(screen.getByText(/24 replays \(1 could not run, left out\)/)).toBeTruthy();
  });

  it("a failing explanation says the provider's reason, not a bare 500", async () => {
    stubFetch(routes, { progress: [{ done: 4, total: 192, failed: 4, lastError: '429 Too Many Requests' }], error: '@gnldev/lab: explainRun: every replay of {a} failed; the first: 429 Too Many Requests' });
    const errors: string[] = [];
    const { toast } = await import('../src/ui');
    vi.spyOn(toast, 'error').mockImplementation(((m: string) => { errors.push(m); return 0; }) as never);
    wrap(<Lab />, '/lab?runId=run-7');
    await screen.findByTestId('lab-plan');
    fireEvent.click(screen.getByRole('button', { name: 'Explain' }));
    const buttons = await screen.findAllByRole('button', { name: 'Explain' });
    fireEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatch(/^Could not explain: .*429 Too Many Requests/);
    expect((await screen.findByTestId('lab-error')).textContent).toBe(errors[0]); // stays after the toast goes
    expect(screen.queryByTestId('lab-result')).toBeNull();
  });

  it('while it runs: how far it got, what fails and why, and a stop button that stops it', async () => {
    stubFetch(routes);
    const inner = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<unknown>;
    let aborted = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return inner(url, init);
      const progress = { done: 6, total: 192, failed: 4, lastError: '429 Too Many Requests', concurrency: 1, running: 1, throttled: { waitMs: 30000, attempt: 2, maxWaits: 4, error: 'Too Many Requests' } };
      const retry = { ...progress, throttled: undefined, retrying: { reason: 'http 429', attempt: 3, waitMs: 4500 } };
      const after = { ...progress, throttled: undefined }; // the same job, still running: the retry notice stays
      return { ok: true, status: 200, body: new ReadableStream({ start(c) {
        for (const p of [progress, retry, after]) c.enqueue(new TextEncoder().encode(`event: progress\ndata: ${JSON.stringify(p)}\n\n`));
        init.signal?.addEventListener('abort', () => { aborted = true; c.error(new DOMException('aborted', 'AbortError')); });
      } }) };
    }));
    const infos: string[] = [];
    const { toast } = await import('../src/ui');
    vi.spyOn(toast, 'info').mockImplementation(((m: string) => { infos.push(m); return 0; }) as never);
    wrap(<Lab />, '/lab?runId=run-7');
    await screen.findByTestId('lab-plan');
    fireEvent.click(screen.getByRole('button', { name: 'Explain' }));
    const buttons = await screen.findAllByRole('button', { name: 'Explain' });
    fireEvent.click(buttons[buttons.length - 1]!);
    expect((await screen.findByText(/6 of 192 replays done · 1 running · \d:\d\d/)).textContent).toMatch(/^6 of 192/);
    expect((await screen.findByTestId('lab-retrying')).textContent).toBe('The provider did not answer (http 429): the request is sent again in 4.5 s (attempt 3).');
    expect(screen.getByText('4 could not run — last reason: 429 Too Many Requests')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/provider may be limiting requests/);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(infos).toEqual(['Stopped after 6 of 192.']));
    expect(aborted).toBe(true);
    expect(screen.queryByTestId('lab-progress')).toBeNull();
  });

  it('while the provider refuses (429) it says how long it waits and when it will stop', async () => {
    stubFetch(routes);
    const inner = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<unknown>;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return inner(url, init);
      const p = { done: 2, total: 64, failed: 0, concurrency: 1, running: 0, throttled: { waitMs: 30000, attempt: 2, maxWaits: 4, error: 'Too Many Requests' } };
      return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`event: progress\ndata: ${JSON.stringify(p)}\n\n`)); } }) };
    }));
    wrap(<Lab />, '/lab?runId=run-7');
    await screen.findByTestId('lab-plan');
    fireEvent.click(screen.getByRole('button', { name: 'Explain' }));
    const buttons = await screen.findAllByRole('button', { name: 'Explain' });
    fireEvent.click(buttons[buttons.length - 1]!);
    expect((await screen.findByTestId('lab-throttled')).textContent).toBe('The provider is limiting requests (429): waiting 30 s, then one request at a time. Wait 2 of 4 — after that it stops.');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  });

  it('a recording the model does not repeat is flagged before any share', async () => {
    stubFetch({ ...routes, '/lab/explain': { ...explanation, dependsOnParts: true, representative: { value: 0.33, low: 0.06, high: 0.79, n: 3, ok: false } } });
    wrap(<Lab />, '/lab?runId=run-7');
    await screen.findByTestId('lab-plan');
    fireEvent.click(screen.getByRole('button', { name: 'Explain' }));
    const buttons = await screen.findAllByRole('button', { name: 'Explain' });
    fireEvent.click(buttons[buttons.length - 1]!);
    expect((await screen.findByRole('alert')).textContent).toMatch(/not what the model usually does: .* 33% of 3 trials/);
  });

  it("a new agent: its prompt's sections, the plan, and after the confirmation the best form, the shares and every form", async () => {
    posts.length = 0;
    const comps = [{ id: 'section 1', kind: 'system', preview: 'Look the order up before you act.' }, { id: 'section 2', kind: 'system', preview: 'Be brief and warm.' }];
    const form = (components: string[], value: number, tokens: number) => ({ components, passRate: { value, low: value - 0.2, high: Math.min(1, value + 0.1), n: 12 }, costUsd: 0, priced: false, tokens, errored: 0 });
    const best = form(['section 1'], 1, 9000);
    stubFetch({
      ...routes,
      '/lab/scenarios': { items: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, category: 'support', prompt: `Scenario ${i}` })) },
      '/lab/form-plan': { agent: 'kritik', components: comps, scenarios: 6, trials: 2, forms: 4, runs: 48 },
      '/lab/best-form': { agent: 'kritik', model: 'small/model', target: 1, scenarios: ['s0', 's1', 's2', 's3', 's4', 's5'], componentsDetail: comps,
        shares: { 'section 1': 0.75, 'section 2': -0.05 }, best, forms: [best, form(['section 1', 'section 2'], 1, 9900), form([], 0.33, 7000), form(['section 2'], 0.25, 7900)] },
    });
    wrap(<Lab />, '/lab?mode=new');
    expect(await screen.findByText(/2 sections · 4 forms · 6 scenarios · 48 scenario runs/)).toBeTruthy();
    expect(screen.getByText('Scenarios: 6 of 8 (every form runs each one)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try every form' }));
    expect(posts).toEqual([]);
    expect(await screen.findByText(/48 plays with small\/model · tokens not known beforehand · price not estimated beforehand\. .* The scenarios' tools are fakes/)).toBeTruthy();
    const buttons = await screen.findAllByRole('button', { name: 'Try every form' });
    fireEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(screen.getByTestId('form-result')).toBeTruthy());
    expect(posts).toEqual([{ url: expect.stringContaining('/lab/best-form'), body: { agent: 'kritik', model: 'small/model', trials: 2, scenarios: ['s0', 's1', 's2', 's3', 's4', 's5'] } }]);
    expect(screen.getByTestId('best-form').textContent).toMatch(/Best form: section 1.*passes 100%.*9,000 tokens/);
    expect(screen.getAllByTestId('form-share').map((x) => x.textContent)[1]).toMatch(/section 2.*−0\.05/);
    expect(screen.getByText('(no section)')).toBeTruthy();
    expect(screen.getByTestId('forms-overlap').textContent).toMatch(/^1 of the other 3 forms has a 95% interval that reaches the best one's/);
  });

  it('a new agent whose forms all pass nothing: no best form is named, and the forms are still all there', async () => {
    const comps = [{ id: 'section 1', kind: 'system', preview: 'Look the order up before you act.' }];
    const zero = (components: string[]) => ({ components, passRate: { value: 0, low: 0, high: 0.24, n: 12 }, costUsd: 0, priced: false, tokens: 9000, errored: 0 });
    stubFetch({
      ...routes,
      '/lab/scenarios': { items: [{ id: 's0', category: 'support', prompt: 'Scenario 0' }] },
      '/lab/form-plan': { agent: 'kritik', components: comps, scenarios: 1, trials: 2, forms: 2, runs: 4 },
      '/lab/best-form': { agent: 'kritik', model: 'small/model', target: 0, scenarios: ['s0'], componentsDetail: comps, shares: { 'section 1': 0 }, forms: [zero([]), zero(['section 1'])] },
    });
    wrap(<Lab />, '/lab?mode=new');
    await screen.findByText(/1 sections · 2 forms/);
    fireEvent.click(screen.getByRole('button', { name: 'Try every form' }));
    const buttons = await screen.findAllByRole('button', { name: 'Try every form' });
    fireEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(screen.getByTestId('form-result')).toBeTruthy());
    expect(screen.getByTestId('no-best-form').textContent).toMatch(/No form passed a single scenario — there is no best form/);
    expect(screen.queryByTestId('best-form')).toBeNull();
    expect(screen.queryByTestId('forms-overlap')).toBeNull();
    expect(screen.getByText('(no section)')).toBeTruthy();
  });

  it('three tabs: Improve, New agent, Scenarios', async () => {
    stubFetch({ ...routes, '/lab/scenarios': { items: [{ id: 's0', category: 'support', prompt: 'Scenario 0' }] } });
    wrap(<Lab />);
    expect(await screen.findByTestId('lab-pick-run')).toBeTruthy();
    expect(screen.getAllByRole('tab').map((x) => x.textContent)).toEqual(['Improve', 'New agent', 'Scenarios']);
    fireEvent.click(screen.getByRole('tab', { name: 'Scenarios' }));
    expect(await screen.findByTestId('scenario-row')).toBeTruthy();
    expect(screen.getByTestId('scenarios-from-code').textContent).toMatch(/defined in the app's code/);
    fireEvent.click(screen.getByRole('tab', { name: 'New agent' }));
    expect(await screen.findByText("Which parts of this agent's prompt does it need?")).toBeTruthy();
    expect(screen.queryByTestId('lab-pick-run')).toBeNull();
  });

  it("the capsule: the run's prompt and tools to change; a call the run never made asks for its result, and the answer goes with the next play", async () => {
    posts.length = 0;
    const capsuleBase = { runId: 'run-7', agent: 'kritik', system: 'Help with orders.', tools: [{ name: 'findOrder', description: 'Find an order', parameters: { type: 'object' } }],
      earlierMessages: 2, memoryMessages: 1, lastMessage: 'My lamp came broken.', recordedCalls: [{ toolName: 'findOrder', args: { orderId: '42' } }], tokensPerPlay: 1200 };
    const stopped = { runId: 'run-7', agent: 'kritik', model: 'small/model', trials: 3, failed: 0, inputTokens: 900, outputTokens: 90, costUsd: 0, priced: false,
      recorded: { calls: [{ toolName: 'findOrder', args: { orderId: '42' } }, { toolName: 'replace', args: { orderId: '42' } }], text: 'A new lamp is on its way.' },
      paths: [{ calls: [{ toolName: 'findOrder', args: { orderId: '42' }, source: 'recorded' }, { toolName: 'refund', args: { orderId: '42' }, source: 'none' }], text: '', count: 3, sameAsRecorded: false }],
      sameAsRecorded: { value: 0, low: 0, high: 0.56, n: 3 }, pending: [{ toolName: 'refund', args: { orderId: '42' } }],
      // the run as it was, played as many times beside the change
      unchanged: { trials: 3, failed: 0, sameAsRecorded: { value: 1, low: 0.44, high: 1, n: 3 },
        paths: [{ calls: [{ toolName: 'findOrder', args: { orderId: '42' }, source: 'recorded' }, { toolName: 'replace', args: { orderId: '42' }, source: 'recorded' }], text: 'A new lamp is on its way.', count: 3, sameAsRecorded: true }] },
      difference: { of: 'sameAsRecorded', interval: { value: -1, low: -1, high: -0.31, n: 3 } } };
    stubFetch({ ...routes, '/lab/capsule': capsuleBase });
    // the POST answers with the play; the GET with the base — one stub, told apart by the method
    const inner = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<any>;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return inner(url, init);
      posts.push({ url: String(url), body: JSON.parse(String(init.body)) });
      const bytes = new TextEncoder().encode(`event: done\ndata: ${JSON.stringify(stopped)}\n\n`);
      return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) };
    }));
    wrap(<Lab />, '/lab?runId=run-7&mode=capsule');
    const prompt = await screen.findByRole('textbox', { name: 'System prompt' });
    expect((prompt as HTMLTextAreaElement).value).toBe('Help with orders.');
    expect(screen.getByText('findOrder({"orderId":"42"})')).toBeTruthy();
    fireEvent.change(prompt, { target: { value: 'Help with orders. If it came broken, refund it.' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Keep the 1 messages memory put in/ }));
    expect(screen.getByText('changed')).toBeTruthy();
    const confirmPlay = async () => {
      const buttons = await screen.findAllByRole('button', { name: 'Play in the capsule' });
      fireEvent.click(buttons[buttons.length - 1]!);
    };
    fireEvent.click(screen.getByRole('button', { name: 'Play in the capsule' }));
    expect(posts).toEqual([]); // nothing is spent before the confirmation
    // a change is played beside the run as it was: twice the plays, said before anything is spent
    expect(await screen.findByText(/6 plays with small\/model · ≈7,200 tokens · .* No tool runs and no record changes\. 3 plays with the change, 3 plays as it was/)).toBeTruthy();
    await confirmPlay();
    await waitFor(() => expect(screen.getByTestId('capsule-result')).toBeTruthy());
    expect(posts[0]!.body).toEqual({ runId: 'run-7', model: 'small/model', trials: 3, system: 'Help with orders. If it came broken, refund it.', memory: false });
    expect(screen.getByTestId('capsule-same').textContent).toBe('0 of 3 plays made the recorded calls again');
    const compare = screen.getByTestId('capsule-compare');
    expect(compare.textContent).toMatch(/Recorded calls again: unchanged 3\/3 → changed 0\/3/);
    expect(compare.textContent).toMatch(/Difference −100 points \(95%: −100 to −31\)/);
    expect(screen.getByTestId('capsule-compare-verdict').textContent).toMatch(/moved the calls/);
    expect(screen.getByTestId('capsule-result').textContent).toMatch(/6 plays \(0 could not run\).*the plan said ≈7,200 tokens/);
    expect(screen.getByTestId('capsule-path').textContent).toMatch(/refund\(\{"orderId":"42"\}\)\s*no answer — stopped/);
    fireEvent.change(within(screen.getByTestId('capsule-pending')).getByRole('textbox'), { target: { value: '{"refunded": 250}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Play again with these answers' }));
    await confirmPlay();
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.body).toMatchObject({ answers: [{ toolName: 'refund', args: { orderId: '42' }, output: { refunded: 250 } }] });
  });

  it('a turn is kept as a scenario once a right answer is written; the Scenarios tab plays the kept ones', async () => {
    posts.length = 0;
    const kept = { v: 1, id: 'sc-1', agent: 'kritik', title: 'Broken lamp', at: Date.UTC(2026, 10, 1), by: 'operator:deniz', owner: 'ayse', from: { runId: 'run-7' }, expect: { calls: [{ toolName: 'refund' }] }, results: [], answers: [] };
    const runs = { agent: 'kritik', model: 'small/model', allPassed: 0, inputTokens: 300, outputTokens: 30, costUsd: 0, priced: false,
      scenarios: [{ id: 'sc-1', title: 'Broken lamp', passed: 1, failed: 2, undetermined: 0, errored: 0, passRate: { value: 0.33, low: 0.06, high: 0.79, n: 3 }, failures: ['refund was not called'], pending: [] }] };
    stubFetch({ ...routes, '/lab/saved-scenarios/run': runs, '/lab/saved-scenarios': { items: [kept] }, '/lab/scenarios': { items: [] } });
    const inner = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<any>;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && String(url).endsWith('/lab/saved-scenarios')) { posts.push({ url: String(url), body: JSON.parse(String(init.body)) }); return { ok: true, status: 201, headers: { get: () => 'application/json' }, json: async () => kept }; }
      return inner(url, init);
    }));
    wrap(<Lab />, '/lab?runId=run-7');
    const box = await screen.findByTestId('save-scenario');
    const save = within(box).getByRole('button', { name: 'Keep as scenario' }) as HTMLButtonElement;
    fireEvent.change(within(box).getByRole('textbox'), { target: { value: 'Broken lamp' } });
    expect(save.disabled).toBe(true); // no right answer written yet
    fireEvent.change(screen.getByRole('textbox', { name: /Must call/ }), { target: { value: 'refund' } });
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(posts.some((p) => p.url.endsWith('/lab/saved-scenarios'))).toBe(true));
    expect(posts.find((p) => p.url.endsWith('/lab/saved-scenarios'))!.body).toEqual({ runId: 'run-7', title: 'Broken lamp', expect: { calls: [{ toolName: 'refund' }] } });
    cleanup();
    stubFetch({ ...routes, '/lab/saved-scenarios/run': runs, '/lab/saved-scenarios': { items: [kept] }, '/lab/scenarios': { items: [] } });
    wrap(<Lab />, '/lab?mode=scenarios');
    const row = await screen.findByTestId('saved-row');
    expect(row.textContent).toMatch(/Broken lamp.*a person's/);
    fireEvent.click(screen.getByRole('button', { name: 'Play them all' }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Play them all' })).at(-1)!);
    await waitFor(() => expect(screen.getByTestId('saved-result').textContent).toMatch(/1 of 3 plays right.*refund was not called/));
    expect(screen.getByTestId('saved-summary').textContent).toMatch(/0 of 1 scenarios right in every play/);
  });

  it("a kept scenario's tool results are edited on the page and sent whole", async () => {
    const kept = { v: 1, id: 'sc-1', agent: 'kritik', title: 'Broken lamp', at: 1, by: 'x', owner: 'ayse', from: { runId: 'run-7' },
      expect: { calls: [{ toolName: 'refund' }] }, results: [{ toolName: 'findOrder', args: { orderId: '42' }, output: { status: 'delivered' } }], answers: [] };
    stubFetch({ ...routes, '/lab/saved-scenarios': { items: [kept] }, '/lab/scenarios': { items: [] } });
    const inner = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<any>;
    const patches: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') { patches.push({ url: String(url), body: JSON.parse(String(init.body)) }); return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => kept }; }
      return inner(url, init);
    }));
    wrap(<Lab />, '/lab?mode=scenarios');
    await screen.findByTestId('saved-row');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = await screen.findByTestId('scenario-editor');
    fireEvent.change(within(editor).getByRole('textbox', { name: 'What findOrder({"orderId":"42"}) returns' }), { target: { value: '{"status":"lost"}' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Add an answer' }));
    fireEvent.change(within(editor).getByRole('textbox', { name: 'tool name' }), { target: { value: 'refund' } });
    fireEvent.change(within(editor).getByRole('textbox', { name: 'What refund({}) returns' }), { target: { value: '{"refunded":true}' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ url: expect.stringContaining('/lab/saved-scenarios/kritik/sc-1'), body: {
      title: 'Broken lamp', expect: { calls: [{ toolName: 'refund' }] },
      results: [{ toolName: 'findOrder', args: { orderId: '42' }, output: { status: 'lost' } }],
      answers: [{ toolName: 'refund', args: {}, output: { refunded: true } }],
    } });
  });

  it("an admin sees the organization's kept experiments on the run, and opens one to its result", async () => {
    const kept = {
      v: 1, id: 'explain:run-7:1', at: Date.UTC(2026, 9, 31, 9, 0), actor: 'operator:ayse', kind: 'explain', target: 'run-7',
      request: { runId: 'run-7', model: 'small/model', trials: 3 }, result: explanation,
    };
    stubFetch({ ...routes, '/lab/experiments': { items: [kept] } });
    wrap(<Lab />, '/lab?runId=run-7');
    const list = await screen.findByTestId('kept-experiments');
    expect(within(list).getByText(/Kept experiments \(1\)/)).toBeTruthy();
    const row = within(list).getByText('largest share: turn 1 +0.14');
    expect(within(list).getByText('operator:ayse')).toBeTruthy();
    fireEvent.click(row);
    expect(within(list).getAllByTestId('lab-share')).toHaveLength(3);
  });
});

