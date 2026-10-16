// pendingWork — what a store still has in hand — reaches every organization, and a decision about a
// call in doubt is written only over the record it was made on.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, toJournal, stampFormat, withOrg, pendingWork, declareInDoubtDone, recoverInDoubt } from '../src/index.js';
import { ORG_RECORD_PRE } from '../src/organization.js';
import type { Journal } from '../src/journal.js';

async function seed(j: Journal, runId: string): Promise<void> {
  await j.put(`${runId}:input`, stampFormat({ at: 1, prompt: 'go', agent: 'shop' }));
  await j.put(`${runId}:outcome`, { status: 'running', at: 1 });
  await j.put(`${runId}:model:0`, { content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'charge', input: JSON.stringify({ id: 'A' }) }] });
  await j.put(`${runId}:tool:call-1`, stampFormat({ status: 'running', startedAt: 1, attempts: 1, claimTtlMs: 1_000, idempotencyKey: `k-${runId}`, toolName: 'charge' }));
}

describe('pendingWork', () => {
  it("lists an organization's call in doubt with its scope, key and arguments", async () => {
    const root = toJournal(new InMemoryStorage().runs);
    await root.put(`${ORG_RECORD_PRE}acme`, { at: 1 });
    await seed(withOrg(root, 'acme'), 'r1');
    const p = await pendingWork(root);
    expect(p.blocking).toBe(true);
    expect(p.inDoubt).toHaveLength(1);
    expect(p.inDoubt[0]).toMatchObject({ scope: 'acme', runId: 'r1', toolCallId: 'call-1', toolName: 'charge', idempotencyKey: 'k-r1', input: { id: 'A' }, status: 'running' });
  });

  it('a declaration is recorded with who made it; a record that moved since the listing is not overwritten', async () => {
    const j = toJournal(new InMemoryStorage().runs);
    await seed(j, 'r2');
    const [call] = (await pendingWork(j)).inDoubt;
    // Another process took the call over meanwhile.
    await j.put('r2:tool:call-1', stampFormat({ status: 'running', startedAt: 99, attempts: 2, claimTtlMs: 1_000, idempotencyKey: 'k-r2', toolName: 'charge' }));
    expect(await declareInDoubtDone(j, call!, { by: 'ops' })).toBe(false);
    expect(await recoverInDoubt(j, call!, { recover: async () => ({ done: true, output: 1 }) })).toBe('moved');
    const [again] = (await pendingWork(j)).inDoubt;
    expect(await declareInDoubtDone(j, again!, { by: 'ops', note: 'seen in the gateway' })).toBe(true);
    const rec = await j.get<any>('r2:tool:call-1');
    expect(rec).toMatchObject({ status: 'succeeded', idempotencyKey: 'k-r2', declaredBy: { by: 'ops', note: 'seen in the gateway' } });
    expect((await pendingWork(j)).inDoubt).toEqual([]);
  });
});
