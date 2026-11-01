// @vitest-environment jsdom
// The Inspector's memory panel against `:memctx` records it did not write — one from before layouts, one
// with a layout, an unknown version, a string, a null where a list belongs. None may crash the panel.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n';
import { MemoryContextPanel } from '../src/views/inspector-thread';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
// Diagnostics, printed with GNL_TEST_VERBOSE=1.
const log = (...a: unknown[]) => void (process.env.GNL_TEST_VERBOSE && process.stdout.write(`AUDIT ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`));

const shapes: Record<string, unknown> = {
  legacy: { v: 1, threadId: 't', recalled: [], recentCount: 2, incomingCount: 1, echoTrimmed: 0 },
  withLayout: { v: 1, threadId: 't', recalled: [], recentCount: 2, incomingCount: 1, echoTrimmed: 0, layout: { v: 1, n: 3, status: 'exact', recent: [0, 2], incoming: [2, 3] } },
  v2: { v: 2, layout: { v: 2 } },
  string: 'not json at all',
  nullRecalled: { v: 1, recalled: null, recentCount: 1, incomingCount: 1, echoTrimmed: 0 },
};

describe('MemoryContextPanel over foreign :memctx shapes', () => {
  for (const [name, ctx] of Object.entries(shapes)) {
    it(`${name}: renders without throwing`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ context: ctx }) })));
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const errors: unknown[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(String(a[0]).slice(0, 160)); });
      let threw: unknown;
      try {
        render(<QueryClientProvider client={qc}><MemoryContextPanel runId="r1" threadId="t" threadMessages={[]} /></QueryClientProvider>);
        await new Promise((r) => setTimeout(r, 50));
      } catch (e) { threw = e; }
      const textOut = document.body.textContent ?? '';
      log('panel', name, { threw: threw ? String(threw).slice(0, 160) : null, errors: errors.slice(0, 2), text: textOut.slice(0, 160), saysNoLayout: /layout|düzen|diagnos/i.test(textOut) });
      spy.mockRestore();
      expect(threw).toBeUndefined();
    });
  }
});
