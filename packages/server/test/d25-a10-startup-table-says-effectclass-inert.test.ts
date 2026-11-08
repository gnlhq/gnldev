// d25 A10 (saga/KARAR-7, option A), the table a host prints at startup: createRestApi without a preset must not say
// "declarations inert" — only `effectClass` is inert without a profile (see durable's d25-a10 test for the evidence).
import { it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';

afterEach(() => vi.restoreAllMocks());

it('A10 (server): the startup protections table names effectClass, not "declarations", as inert', () => {
  const out: string[] = [];
  for (const m of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  createRestApi({ journal: new InMemoryJournal(), agents: {} });
  const printed = out.join('\n');
  expect(printed, 'the table was printed').toContain('dedup profile');
  expect(printed).not.toMatch(/declarations inert/);
  expect(printed).toMatch(/effectClass[^\n]*inert/);
});
