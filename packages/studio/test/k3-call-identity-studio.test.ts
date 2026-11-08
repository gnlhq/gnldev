// k3 Studio approvals inbox — one run, two steps, both calls named `call_0` by the provider (it numbers per
// response), both confirm (pay 5, then pay 7). The operator approves the row the inbox lists. Then the inbox
// must list the second question (pay 7) as its own row, and approving that row runs it — the first approval
// must not run pay 7. Ids are read from the inbox, never assumed. Control: distinct ids per step.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, createGnl } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';

const drive = (api: unknown) => api as (r: Request) => Promise<Response>;
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const countTools = (prompt: any[]) => (prompt ?? []).filter((m: any) => m?.role === 'tool').length;

function gnlOf(journal: InMemoryJournal, paid: number[], ids: 'same' | 'unique') {
  return createGnl({
    journal,
    agents: {
      pay: {
        model: {
          specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
          doGenerate: async ({ prompt }: any) => {
            const n = countTools(prompt);
            if (n < 2) return { content: [{ type: 'tool-call', toolCallId: ids === 'same' ? 'call_0' : `call_${n}`, toolName: 'pay', input: JSON.stringify({ amount: n === 0 ? 5 : 7 }) }], finishReason: 'tool-calls', usage, warnings: [] };
            return { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage, warnings: [] };
          },
        },
        tools: { pay: { sideEffect: true, confirm: true as const, execute: async (a: any) => { paid.push(a.amount); return { ok: true }; } } },
      },
    },
  } as never);
}

describe('k3 Studio inbox — two questions of one run with a repeated call id', () => {
  for (const ids of ['same', 'unique'] as const) {
    it(`ids=${ids}: approving the listed row runs pay 5 only; pay 7 is listed as its own row`, async () => {
      const journal = new InMemoryJournal();
      const paid: number[] = [];
      const RUN = `k3-studio-${ids}`;
      await gnlOf(journal, paid, ids).run('pay', { runId: RUN, prompt: 'pay 5 then 7' } as never);
      const api = drive(createStudioApi({ reader: journal, resume: async (runId, approvals) => gnlOf(journal, paid, ids).run('pay', { runId, prompt: 'pay 5 then 7', approvals } as never) as never }));
      const inbox = async () => ((await (await api(new Request('http://s/approvals'))).json()) as { items: Array<{ runId: string; toolCallId: string; args?: any }> }).items.filter((i) => i.runId === RUN);
      const rows1 = await inbox();
      expect(rows1.length, 'precondition: pay 5 is listed').toBe(1);
      const r = await api(new Request(`http://s/runs/${RUN}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvals: { [rows1[0].toolCallId]: true } }) }));
      expect(r.status).toBe(200);
      const rows2 = await inbox();
      console.log(`[STUDIO ${ids}] after approving ${rows1[0].toolCallId}: paid=${JSON.stringify(paid)} rows=${JSON.stringify(rows2.map((x) => [x.toolCallId, x.args]))}`);
      expect(paid, 'pay 7 ran on pay 5\'s approval').toEqual([5]);
      expect(rows2.length, 'pay 7 is listed').toBe(1);
      expect(JSON.stringify(rows2[0].args ?? '')).toContain('7');
      await api(new Request(`http://s/runs/${RUN}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvals: { [rows1[0].toolCallId]: true, [rows2[0].toolCallId]: true } }) }));
      expect(paid).toEqual([5, 7]);
      expect(await inbox()).toEqual([]);
    });
  }
});
