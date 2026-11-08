// @vitest-environment jsdom
// THE INBOX LETS THE OPERATOR ANSWER A USER'S QUESTION (d25 approval policy, step 2; KARAR-1 "ADIM 2 / POLİTİKA").
//
// Today (Approvals.tsx, "Visibility stays with the admin, the decision with the owner") a row stamped with
// an end user's actor greys out Approve/Deny. Step 2 reverses it: an approve question is answered by an
// authorised person — Studio is where the operator answers — and a confirm question may be answered by an
// authorised person too. So on a user's row the buttons are live; the owner badge stays (who it is for).
// Same fixture pattern as approvals-owner-badge.test.tsx.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n';
import { Approvals } from '../src/views/Approvals';
import en from '../src/i18n/locales/en/approvals.json';

afterEach(() => { cleanup(); localStorage.clear(); });

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });

function stubFetch(routes: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const key = Object.keys(routes).find((k) => u.endsWith(k));
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => (key ? routes[key] : []) };
  }));
}
function show(items: unknown[]) {
  stubFetch({ '/approvals': { items }, '/capabilities': { approvals: true } });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter><QueryClientProvider client={qc}><Approvals /></QueryClientProvider></MemoryRouter>);
}
const btn = (name: string) => screen.getByRole('button', { name: new RegExp(name) }) as HTMLButtonElement;

describe('Approvals: the operator may answer a user\'s question', () => {
  it('a row stamped with the end user\'s actor keeps its owner badge, and Approve/Deny are live (no "belongs to" lock)', async () => {
    show([{ runId: 'sus-1', toolCallId: 'call-1', toolName: 'chargeCard', owner: 'u-ayse', ownerActor: 'ayse' }]);
    await waitFor(() => expect(screen.getByText('chargeCard')).toBeTruthy());
    expect(screen.getByText('user work · u-ayse'), 'the row no longer says whose work it is').toBeTruthy();
    expect(btn(en.approve).disabled, 'Approve is still locked on a user\'s row').toBe(false);
    expect(btn(en.deny).disabled, 'Deny is still locked on a user\'s row').toBe(false);
    const lockSentence = en.ownerLockedTitle.replace('{{owner}}', 'u-ayse');
    expect(screen.queryByText(lockSentence), 'the row still tells the operator the answer is not theirs').toBeNull();
  });

  it('regression: an org row (no owner) stays answerable', async () => {
    show([{ runId: 'sus-2', toolCallId: 'call-2', toolName: 'chargeCard' }]);
    await waitFor(() => expect(screen.getByText('chargeCard')).toBeTruthy());
    expect(btn(en.approve).disabled).toBe(false);
  });
});
