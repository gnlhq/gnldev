// @vitest-environment jsdom
// The capsule and the Inspector's memory panel read where a run's input came from by the run's own
// layout: the working memory shown apart from the prompt, a memory run without a layout said to be
// undiagnosable (and memory not offered to leave out), what a right answer does typed, sent and counted,
// and the panel's three numbers — what memory gave, what reached the model, what a processor changed.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Lab, capsuleBody, expectationOf } from '../src/views/Lab';
import { MemoryContextPanel, layoutSummary } from '../src/views/inspector-thread';
import '../src/i18n';
import { PANEL_ROUTES } from './lab-panel-fixtures';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });

const posts: Array<{ url: string; body: unknown }> = [];
/** GETs answer from `routes` by the longest matching path; a POST answers `played` as a stream. */
function stubFetch(routes: Record<string, unknown>, played?: unknown) {
  routes = { ...PANEL_ROUTES, ...routes };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST') {
      posts.push({ url: u, body: JSON.parse(String(init.body)) });
      const bytes = new TextEncoder().encode(`event: done\ndata: ${JSON.stringify(played)}\n\n`);
      return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) };
    }
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => u.includes(k));
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => (key ? routes[key] : {}) };
  }));
}
function wrap(node: React.ReactNode, at = '/lab') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter initialEntries={[at]}><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>);
}
// The Improve tab shows the run's explanation plan beside its capsule: it is asked for too.
const explainPlan = { runId: 'run-7', agent: 'kritik', parts: [], trials: 3, replays: 24, tokensPerReplay: 1000, estimatedTokens: 20000 };
const routes = { '/capabilities': { lab: true }, '/lab/experiments': { items: [] }, '/lab/plan': explainPlan, '/lab': { agents: ['kritik'], models: ['small/model'] } };
const baseOf = (extra: Record<string, unknown>) => ({
  runId: 'run-7', agent: 'kritik', system: 'Help with orders.', tools: [{ name: 'findOrder', description: 'Find an order', parameters: { type: 'object' } }],
  earlierMessages: 2, lastMessage: 'My lamp came broken.', recordedCalls: [{ toolName: 'findOrder', args: { orderId: '42' } }], tokensPerPlay: 1200, ...extra,
});

describe('what a right answer does, as typed (pure)', () => {
  it('calls with or without arguments, forbidden tools, answer texts with alternatives; nothing typed is no expectation', () => {
    expect(expectationOf({ calls: '', forbidden: ' ', answer: '\n' })).toEqual({});
    expect(expectationOf({ calls: 'findOrder {"orderId":"42"}\nrefund', forbidden: 'cancel, delete', answer: 'refunded\n30 days | 30-day' })).toEqual({ expect: {
      calls: [{ toolName: 'findOrder', args: { orderId: '42' } }, { toolName: 'refund' }],
      forbidden: ['cancel', 'delete'],
      answerIncludes: ['refunded', ['30 days', '30-day']],
    } });
    expect(expectationOf({ calls: 'refund {orderId: 42}', forbidden: '', answer: '' })).toEqual({ badLine: 'refund {orderId: 42}' });
    expect(expectationOf({ calls: 'refund [1]', forbidden: '', answer: '' })).toEqual({ badLine: 'refund [1]' });
    const b = baseOf({});
    expect(capsuleBody(b as never, { model: 'm', trials: 1, system: b.system, tools: b.tools.map((t) => ({ ...t, keep: true, added: false })), history: true, expect: { forbidden: ['x'] } }, {}))
      .toEqual({ body: { runId: 'run-7', model: 'm', trials: 1, expect: { forbidden: ['x'] } } });
  });
});

describe('the capsule reads the layout', () => {
  it('a memory run without a layout: it says so, and memory is not offered to leave out', async () => {
    stubFetch({ ...routes, '/lab/capsule': baseOf({ memoryMessages: null, layout: { status: 'absent', reason: 'no-layout', detail: 'the run carries no memory layout' }, parts: [] }) });
    wrap(<Lab />, '/lab?runId=run-7');
    const note = await screen.findByTestId('capsule-no-layout');
    expect(note.textContent).toMatch(/no memory layout.*recorded before memory layouts were kept/);
    expect(screen.queryByRole('checkbox', { name: /memory put in/ })).toBeNull();
  });

  it('the working memory apart from the prompt; an expectation typed goes with the play and its count comes back', async () => {
    posts.length = 0;
    const played = { runId: 'run-7', agent: 'kritik', model: 'small/model', trials: 2, failed: 0, inputTokens: 1, outputTokens: 1, costUsd: 0, priced: false,
      recorded: { calls: [{ toolName: 'findOrder', args: { orderId: '42' } }], text: 'ok' },
      paths: [{ calls: [{ toolName: 'findOrder', args: { orderId: '42' }, source: 'recorded' }], text: 'ok', count: 2, sameAsRecorded: true, passed: 1, failures: ['answer lacks "refund"'] }],
      sameAsRecorded: { value: 1, low: 0.3, high: 1, n: 2 }, pending: [], expected: { passRate: { value: 0.5, low: 0.1, high: 0.9, n: 2 }, undetermined: 0 }, notes: [] };
    stubFetch({ ...routes, '/lab/capsule': baseOf({ memoryMessages: 2, workingMemory: { status: 'exact', text: '# Working Memory\nname: Ayse' }, layout: { status: 'present', layout: 'exact', memoryMessages: 2, notes: [] }, parts: [] }) }, played);
    wrap(<Lab />, '/lab?runId=run-7');
    expect((await screen.findByTestId('capsule-working-memory')).textContent).toContain('name: Ayse');
    expect(((await screen.findByRole('textbox', { name: 'System prompt' })) as HTMLTextAreaElement).value).toBe('Help with orders.');
    expect(screen.getByRole('checkbox', { name: /2 messages and the working memory/ })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: /Must call/ }), { target: { value: 'findOrder {"orderId":"42"}' } });
    fireEvent.change(screen.getByRole('textbox', { name: /answer must contain/ }), { target: { value: 'refund' } });
    fireEvent.click(screen.getByRole('button', { name: 'Play in the capsule' }));
    const buttons = await screen.findAllByRole('button', { name: 'Play in the capsule' });
    fireEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(screen.getByTestId('capsule-expected')).toBeTruthy());
    expect(posts[0]!.body).toMatchObject({ expect: { calls: [{ toolName: 'findOrder', args: { orderId: '42' } }], answerIncludes: ['refund'] } });
    expect(screen.getByTestId('capsule-expected').textContent).toBe('1 of 2 plays did what a right answer does');
    expect(screen.getByTestId('capsule-path').textContent).toContain('answer lacks "refund"');
  });
});

describe("the memory panel's numbers come from the layout", () => {
  it('what memory gave, what reached the model, what a processor removed and added', () => {
    const present = { status: 'present', layout: { v: 1, n: 7, status: 'changed', recent: [1, 5], incoming: [5, 7], foreign: [0], droppedByChain: 2 } };
    expect(layoutSummary(present)).toEqual({ kind: 'present', gave: 6, sent: 4, dropped: 2, foreign: 1, rewritten: 0, ambiguous: 0 });
    expect(layoutSummary({ status: 'present', layout: { v: 1, n: 3, status: 'boundary-lost' } })).toEqual({ kind: 'undiagnosable', status: 'boundary-lost' });
    expect(layoutSummary(undefined)).toEqual({ kind: 'absent', reason: 'no-layout' });
    expect(layoutSummary('garbage')).toEqual({ kind: 'absent', reason: 'no-layout' });
    expect(layoutSummary({ status: 'absent', reason: 'input-mismatch' })).toEqual({ kind: 'absent', reason: 'input-mismatch' });
  });

  it('rendered: the layout line, and the counts beneath it', async () => {
    const context = { v: 1, threadId: 't', recalled: [], recentCount: 4, incomingCount: 2, echoTrimmed: 0 };
    const layout = { status: 'present', layout: { v: 1, n: 7, status: 'changed', recent: [1, 5], incoming: [5, 7], foreign: [0], droppedByChain: 2 } };
    stubFetch({ '/memory-context': { context, layout } });
    wrap(<MemoryContextPanel runId="r1" threadId="t" threadMessages={[]} />);
    const line = await screen.findByText(/memory gave 6 · 4 sent to the model/);
    expect(line.textContent).toContain('2 removed by an input processor');
    expect(line.textContent).toContain("1 added by an input processor (not memory's)");
    expect(screen.getByText('4 messages from the recent window')).toBeTruthy();
    expect(screen.queryByTestId('mem-no-layout')).toBeNull();
  });
});
