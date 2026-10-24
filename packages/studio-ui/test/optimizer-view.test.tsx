// @vitest-environment jsdom
// Optimizer view: the money formatting (pure), the disabled state, a diagnosis with its findings and
// notes, and a replay that goes through the confirmation and shows what the candidate would have done.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Optimizer, formatUsd, formatShare } from '../src/views/Optimizer';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });

const posts: Array<{ url: string; body: unknown }> = [];
function stubFetch(routes: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST') posts.push({ url: u, body: JSON.parse(String(init.body)) });
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => u.includes(k));
    const entry = key ? routes[key] : {};
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => entry };
  }));
}
function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>);
}

const diagnosis = {
  agent: 'support', runs: 10, modelSteps: 20, costUsd: 0, inputTokens: 18336, outputTokens: 900, cachedTokens: 0, cacheWriteTokens: 0,
  byModel: { 'nvidia/x': { steps: 20, costUsd: 0 } },
  repeatedPrefix: { tokens: 8703, uncachedTokens: 8703, cacheableUncachedTokens: 0, share: 0.4746, medianOpening: 774 },
  oldToolOutput: { estimatedTokens: 1200, share: 0.065, keepLast: 2 },
  findings: [{ lever: 'mask-old-tool-output', tokens: 1200, needsReplay: true, why: 'About 7% of input (estimated) was tool output more than 2 steps old.' }],
  notes: ['47% of input re-sent each run\'s opening, but the openings (median 774 tokens) are shorter than a provider caches (1024).'],
};
const replay = {
  agent: 'support', errors: [{ runId: 'r9', error: 'no answer within 120000 ms' }],
  runs: [
    { runId: 'r1', missed: [], reordered: false, recorded: { costUsd: 0.04, inputTokens: 3000, outputTokens: 100 }, candidate: { costUsd: 0.004, inputTokens: 3000, outputTokens: 100 } },
    { runId: 'r2', divergence: { at: 1, call: { toolName: 'refund' } }, missed: [], reordered: false, recorded: { costUsd: 0.04, inputTokens: 3000, outputTokens: 100 }, candidate: { costUsd: 0.002, inputTokens: 1500, outputTokens: 50 } },
  ],
  summary: { replayed: 2, diverged: 1, divergenceRate: 0.5, missedCallRuns: 0, reorderedRuns: 0, recordedCostUsd: 0.08, candidateCostUsd: 0.006, costRatio: 0.075, recordedTokens: 6200, candidateTokens: 4650, priced: true },
};

const history = { items: [{ at: Date.UTC(2026, 9, 24, 12, 5), agent: 'support', model: 'small/model', limit: 10, keepLast: 2, errors: [],
  summary: { replayed: 10, diverged: 0, divergenceRate: 0, missedCallRuns: 0, costRatio: 0.1, recordedTokens: 1, candidateTokens: 1, priced: true } }] };

describe('formatting (pure)', () => {
  it('money and shares, with "—" where there is no number (NaN arrives as null)', () => {
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(12.5)).toBe('$12.50');
    expect(formatUsd(null)).toBe('—');
    expect(formatShare(0.4746)).toBe('47%');
    expect(formatShare(null)).toBe('—');
  });
});

describe('the Optimizer view', () => {
  it('without the host option it says so instead of showing an empty tab', async () => {
    stubFetch({ '/capabilities': { optimizer: false } });
    wrap(<Optimizer />);
    expect(await screen.findByText('Optimizer is not enabled')).toBeTruthy();
  });

  it('a diagnosis: the cards, an unpriced finding in tokens, and the note on openings too short to cache', async () => {
    stubFetch({ '/capabilities': { optimizer: true }, '/optimizer/diagnosis': diagnosis, '/optimizer': { agents: ['support'], models: ['small/model'] } });
    wrap(<Optimizer />);
    expect(await screen.findByText('47%')).toBeTruthy();
    expect(screen.getByText('unpriced')).toBeTruthy();
    expect(screen.getByText('1,200 tokens on these runs')).toBeTruthy();
    expect(screen.getByText('Try it with a replay first')).toBeTruthy();
    expect(screen.getByText(/median 774 tokens/)).toBeTruthy();
  });

  it('kept replays are listed, and the report downloads as a Markdown file named for the agent', async () => {
    const blobs: Blob[] = [];
    const names: string[] = [];
    // jsdom has neither; a browser has both.
    Object.assign(URL, { createObjectURL: (b: Blob) => { blobs.push(b); return 'blob:x'; }, revokeObjectURL: () => {} });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
    stubFetch({ '/capabilities': { optimizer: true }, '/optimizer/diagnosis': diagnosis, '/optimizer/history': history, '/optimizer/report': { markdown: '# Cost report — support' }, '/optimizer': { agents: ['support'], models: ['small/model'] } });
    wrap(<Optimizer />);
    expect(await screen.findByText('2026-10-24 12:05')).toBeTruthy();
    expect(screen.getByText(/small\/model \+ old output left out after 2 steps/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download report' }));
    await waitFor(() => expect(names).toEqual(['optimizer-report-support.md']));
    const text = await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsText(blobs[0]!); });
    expect(text).toBe('# Cost report — support');
    expect(blobs[0]!.type).toBe('text/markdown');
    click.mockRestore();
  });

  it('a replay goes through the confirmation, sends what was picked, and shows the divergence and the cost', async () => {
    posts.length = 0;
    stubFetch({ '/capabilities': { optimizer: true }, '/optimizer/diagnosis': diagnosis, '/optimizer/replay': replay, '/optimizer': { agents: ['support'], models: ['small/model'] } });
    wrap(<Optimizer />);
    await screen.findByText('47%');
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    expect(posts).toEqual([]); // nothing is spent before the confirmation
    const dialogButtons = await screen.findAllByRole('button', { name: 'Replay' });
    fireEvent.click(dialogButtons[dialogButtons.length - 1]!);
    await waitFor(() => expect(screen.getByTestId('replay-result')).toBeTruthy());
    expect(posts).toEqual([{ url: expect.stringContaining('/optimizer/replay'), body: { agent: 'support', model: 'small/model', limit: 10 } }]);
    expect(screen.getByText('1 (50%)')).toBeTruthy();
    expect(screen.getByText(/diverged at call 2 \(refund\)/)).toBeTruthy();
    expect(screen.getByText(/\$0\.0800 → candidate \$0\.0060/)).toBeTruthy();
    expect(screen.getByText(/r9: no answer within 120000 ms/)).toBeTruthy();
  });
});
