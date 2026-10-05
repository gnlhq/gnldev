// A keyless repeat is asked about (the default). A human's "no — the same work again" answers that same
// repeat for the rest of the request: a 30-order file with ORD-020 ten times asked 10 questions, one per
// repeat. An approval does not carry (it runs the one call it answered), and another request asks again.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryStorage, createGnl, gnlTool, STAFF } from '../src/index.js';
import { createMockModel, toolCallResult, finalTextResult } from './mock.js';

const calls = (n: number) => createMockModel(async ({ prompt }: any) => {
  const d = prompt.filter((m: any) => m.role === 'assistant').length;
  return d < n ? toolCallResult('ship', `c${d}`, { sku: 'TV', to: 'Elm 5' }) : finalTextResult('ok');
});
async function answerEvery(answer: boolean, n: number, storage = new InMemoryStorage(), runId = 'r') {
  let ships = 0; let questions = 0;
  const ship = gnlTool({ description: 'ship', inputSchema: z.object({}).passthrough(), execute: async () => { ships++; return { ok: true }; } }, { sideEffect: true });
  const approvals: Record<string, boolean> = {};
  for (let round = 0; round < 10; round++) {
    const r: any = await createGnl({ storage, agents: { a: { model: calls(n), tools: { ship } } } } as any).run('a', { runId, prompt: 'go', caller: STAFF, approvals } as any);
    if (!r.interrupts?.length) break;
    questions += r.interrupts.length;
    for (const i of r.interrupts) approvals[i.toolCallId] = answer;
  }
  return { ships, questions, storage };
}

describe('a refused repeat is asked once per request', () => {
  it('refused: one question for four identical calls, one shipment', async () => {
    expect(await answerEvery(false, 4).then(({ ships, questions }) => ({ ships, questions }))).toEqual({ ships: 1, questions: 1 });
  });
  it('approved: every repeat is asked, every approved one runs', async () => {
    expect(await answerEvery(true, 4).then(({ ships, questions }) => ({ ships, questions }))).toEqual({ ships: 4, questions: 3 });
  });
  it('another request asks again', async () => {
    const first = await answerEvery(false, 2);
    expect((await answerEvery(false, 2, first.storage, 'r-next')).questions).toBe(1);
  });
});
