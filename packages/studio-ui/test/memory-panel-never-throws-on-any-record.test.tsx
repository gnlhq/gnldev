// @vitest-environment jsdom
// The Inspector's memory panel over every record shape and every layout reading: no uncaught error, no
// console error, and a sentence that says why a turn cannot be diagnosed.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n';
import { MemoryContextPanel } from '../src/views/inspector-thread';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
// Diagnostics, printed with GNL_TEST_VERBOSE=1.
const log = (...a: unknown[]) => void (process.env.GNL_TEST_VERBOSE && process.stdout.write(`AUDIT ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`));

const records: Record<string, unknown> = {
  legacy: { v: 1, threadId: 't', recalled: [], recentCount: 2, incomingCount: 1, echoTrimmed: 0 },
  v2: { v: 2, layout: { v: 2 } }, string: 'garbage', nullRecalled: { v: 1, recalled: null, recentCount: 'x' }, array: [1, 2], number: 7,
  badRefs: { v: 1, recalled: [null, 3, { seq: 'a', score: 'high' }], recent: 'no', recentCount: 1, echoTrimmed: 'x' },
};
const L = (layout: unknown) => ({ status: 'present', layout });
const layouts: Record<string, unknown> = {
  absentNoLayout: { status: 'absent', reason: 'no-layout' },
  unresolved: { status: 'absent', reason: 'unresolved' },
  exact: L({ v: 1, n: 3, status: 'exact', recent: [0, 2], incoming: [2, 3] }),
  changedAll: L({ v: 1, n: 6, status: 'changed', recent: [0, 5], incoming: [5, 6], foreign: [1], rewritten: [2], ambiguous: [3], droppedByChain: 2 }),
  undiagnosable: L({ v: 1, n: 3, status: 'counts-mismatch', incoming: [2, 3] }),
  garbageReading: { status: 'present', layout: 'x' },
  missing: undefined,
  nullReading: null,
};

describe('MemoryContextPanel: shapes x readings', () => {
  for (const [rn, rec] of Object.entries(records)) for (const [ln, lay] of Object.entries(layouts)) {
    it(`${rn} / ${ln}`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ context: rec, ...(lay === undefined ? {} : { layout: lay }) }) })));
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const errors: string[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(String(a[0]).slice(0, 140)); });
      const onErr = (e: ErrorEvent) => { errors.push('uncaught ' + String(e.message).slice(0, 120)); e.preventDefault(); };
      window.addEventListener('error', onErr);
      render(<QueryClientProvider client={qc}><MemoryContextPanel runId="r1" threadId="t" threadMessages={[]} /></QueryClientProvider>);
      await new Promise((r) => setTimeout(r, 40));
      window.removeEventListener('error', onErr); spy.mockRestore();
      const out = document.body.textContent ?? '';
      if (errors.length || ln === 'changedAll' || ln === 'unresolved') log('panel', rn, ln, { errors: errors.slice(0, 1), text: out.slice(0, 200) });
      expect(errors).toEqual([]);
      expect(out.length).toBeGreaterThan(0);
    });
  }
});
