// THE APPROVAL RECORD NAMES WHO ANSWERED — Studio (d25 approval integrity, step 1; KARAR-1 "KULLANICI KARARI — ADIM 1").
//
// Studio is where an operator answers ("WHO answered" is its surface, server.ts). Its batch branch of
// POST /runs/:id/resume writes the decision itself through the engine's resolveApprovals with
// `actor: verifiedActorOf(c)`; the record keeps `actor`, and step 1 adds `answeredBy` (the verified
// operator, `operator:<id>` like every identity comparison) and `answeredAs: 'staff'`.
//
// End to end: a real batch whose item stops at its confirm question (the model-less mini-runner,
// @gnldev/durable createBatch), the operator approves it in Studio, the next batch run() executes it once.
//
// Not covered here: Studio's NON-batch resume goes through the host's `resume` bridge (StudioResume), whose
// shape for carrying the answerer to the engine is the code agent's design — reported as a decision point.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { InMemoryJournal, createBatch, STAFF } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createStudioApi } from '../src/server.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

const drive = (api: unknown) => api as (r: Request) => Promise<Response>;

function setup() {
  const journal = new InMemoryJournal();
  const state = { n: 0 };
  const batch = createBatch(journal, {
    tool: { description: 'pay', sideEffect: true, confirm: true, execute: async () => { state.n++; return { paid: true }; } } as never,
    toolName: 'pay', itemKey: (i: unknown) => (i as { ref: string }).ref, caller: STAFF,
  });
  const api = drive(createStudioApi({ reader: journal, auth: roleAuth({ admin: { token: 'OPS-VELI', user: 'veli' } })! } as never));
  return { journal, state, batch, api };
}

describe('Studio batch approve: the record names the operator', () => {
  it('the operator approves a batch item\'s confirm question → answeredBy operator:veli, answeredAs staff; the next run() executes it once', async () => {
    const { journal, state, batch, api } = setup();
    const list = [{ ref: 'F-1', amount: 10 }];
    const { token } = await batch.preflight('b1', list);
    const r1 = await batch.run('b1', list, { planToken: token });
    expect(r1.summary.suspended, 'precondition: the confirm question is asked').toBe(1);
    expect(state.n).toBe(0);

    const runId = r1.items[0]!.runId;
    const res = await api(new Request(`http://s/runs/${encodeURIComponent(runId)}/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer OPS-VELI' },
      body: JSON.stringify({ approvals: { 'item:F-1': true } }),
    }));
    expect(res.status, await res.clone().text()).toBe(200);
    const rec = await journal.get<Record<string, unknown>>(`${runId}:approval:item:F-1`);
    expect(rec?.decision).toBe(true);
    expect(rec?.answeredBy, 'Studio\'s approval must name the operator who clicked').toBe('operator:veli');
    expect(rec?.answeredAs).toBe('staff');

    await batch.run('b1', list, { planToken: token });
    expect(state.n, 'regression: the approved item runs once on the next run()').toBe(1);
  });
});
