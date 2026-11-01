// @vitest-environment jsdom
// The Lab lists no runs of its own: a run is looked at in the Inspector first and sent to the Lab from
// there. The button is offered only when the host has a lab and the run completed (a run that did not
// finish has no calls to explain).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n';
import { Inspector } from '../src/views/Inspector';

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });

function stubFetch(lab: boolean, status: string, agent: string | null = 'support', threadId?: string) {
  const routes: Record<string, unknown> = {
    '/capabilities': { lab },
    '/lab': { agents: ['support'], models: ['m'] },
    '/runs?limit=50': { items: [{ runId: 'run-1', status, modelSteps: 1, toolCalls: 0, ...(agent ? { agent } : {}), ...(threadId ? { threadId } : {}) }], total: 1 },
    '/runs/run-1/cost': { totalTokens: 10, costUsd: 0.001 },
    '/runs/run-1/scores': { scores: {} },
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((k) => String(url).endsWith(k));
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => (key ? routes[key] : []) };
  }));
}

function LocationProbe() {
  const l = useLocation();
  return <div data-testid="location">{l.pathname + l.search}</div>;
}

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/inspector?run=run-1']}>
      <QueryClientProvider client={qc}><Inspector /><LocationProbe /></QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('a run is sent to the Lab from the Inspector', () => {
  it('a completed run, with a lab: one button opens the Lab on that run — the old regression tab is gone', async () => {
    stubFetch(true, 'completed');
    wrap();
    expect(await screen.findAllByRole('button', { name: /Open in Lab/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Open in Lab/ }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/lab?runId=run-1'));
    expect(screen.queryByRole('tab', { name: /Regression/ })).toBeNull();
  });

  it("a run of a thread is sent with its thread, so the Lab asks nothing to find it", async () => {
    stubFetch(true, 'completed', 'support', 'ayse-chat');
    wrap();
    fireEvent.click(await screen.findByRole('button', { name: /Open in Lab/ }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/lab?runId=run-1&threadId=ayse-chat'));
  });

  it("a run of an agent the Lab was not given — a scheduler run has none — offers no button", async () => {
    for (const agent of [null, 'billing']) {
      stubFetch(true, 'completed', agent);
      wrap();
      await screen.findAllByText(agent ?? 'run-1');
      await new Promise((r) => setTimeout(r, 50)); // the Lab's catalog has answered
      expect(screen.queryByRole('button', { name: /Open in Lab/ })).toBeNull();
      cleanup();
    }
  });

  it('no lab, or a run that did not complete: no button', async () => {
    stubFetch(false, 'completed');
    wrap();
    await screen.findAllByText('support');
    expect(screen.queryByRole('button', { name: /Open in Lab/ })).toBeNull();
    cleanup();
    stubFetch(true, 'failed');
    wrap();
    await screen.findAllByText('support');
    expect(screen.queryByRole('button', { name: /Open in Lab/ })).toBeNull();
  });
});
