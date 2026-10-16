// `gnl pending` reads a call through the call's one reader (call-outcome.ts `readCallOutcome`): a call
// whose record says it stopped mid-body (or failed after its body), but whose late report says the body
// finished, HAPPENED — the run continues from the report. Listed as in doubt, an operator was asked to
// decide an effect the store already knows, and the upgrade was blocked for it.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, toJournal, stampFormat, pendingWork } from '../src/index.js';
import { keepLateReport } from '../src/call-outcome.js';
import type { Journal } from '../src/journal.js';

async function seed(j: Journal, runId: string, status: 'running' | 'failed'): Promise<void> {
  await j.put(`${runId}:input`, stampFormat({ at: 1, prompt: 'go', agent: 'shop' }));
  await j.put(`${runId}:outcome`, { status: 'running', at: 1 });
  await j.put(`${runId}:model:0`, { content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'charge', input: '{}' }] });
  await j.put(`${runId}:tool:call-1`, stampFormat({ status, startedAt: 1, attempts: 1, claimTtlMs: 1_000, idempotencyKey: `k-${runId}`, toolName: 'charge', sideEffect: true }));
}

describe('a call with a late report', () => {
  for (const status of ['running', 'failed'] as const) {
    it(`is not in doubt (record ${status}); without the report it is`, async () => {
      const j = toJournal(new InMemoryStorage().runs);
      await seed(j, 'r1', status);
      await seed(j, 'r2', status);
      expect(await keepLateReport(j, 'r1:tool:call-1', { runId: 'r1' }, { attempt: 1, output: { charged: true } })).toBe('kept');
      const p = await pendingWork(j);
      expect(p.inDoubt.map((c) => c.runId)).toEqual(['r2']);
    });
  }
});
