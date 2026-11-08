// child process for U6: phase 'crash' kills itself inside a tool body; phase 'retry' reopens the same store and re-sends the same turn.
import { stepCountIs } from 'ai';
import { z } from 'zod';
import { createGnl } from '../../src/registry.js';
import { SqliteStorage } from '../../src/sqlite-storage.js';
import { AgentMemory } from '../../../memory/src/index.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from '../mock.js';

const phase = process.argv[2]!; const file = process.argv[3]!; const useMemory = process.argv[4] !== 'nomem';
const storage = new SqliteStorage(file) as any;
let effects = 0;
const model = createMockModel(async ({ prompt }: any) => {
  const lastUser = prompt.map((m: any) => m.role).lastIndexOf('user');
  return countToolResults(prompt.slice(lastUser)) === 0 ? toolCallResult('pay', 'call-' + (JSON.stringify(prompt).includes('pay 5') ? 5 : 1), { amount: JSON.stringify(prompt.slice(lastUser)).includes('pay 5') ? 5 : 1 }) : finalTextResult('paid');
});
const gnl = createGnl({
  storage, preset: (process.env.PRESET ?? 'assistant') as any,
  ...(useMemory ? { memory: new AgentMemory({ storage }) as any } : {}),
  agents: { pharm: { model, tools: { pay: {
    description: 'pay', inputSchema: z.object({ amount: z.number() }), sideEffect: true, recover: async () => ({ done: false }), idempotencyKey: (a: any) => `amt${a.amount}`, idempotencyWindow: 'thread',
    execute: async (a: any) => { effects++; if (phase === 'crash' && a.amount === 5) process.kill(process.pid, 'SIGKILL'); return { ok: 1 }; },
  } } } as any },
} as any);

const turn0 = { workKey: 'turn-0', resourceId: 'ayse', threadId: 'T', messages: [{ role: 'user', content: 'pay 1' }] } as any;
const hist = [{ role: 'user', content: 'pay 1' }, { role: 'assistant', content: 'paid' }];
const idMode = process.env.ID_MODE === 'runid';
const turn = { ...(idMode ? { runId: 'run-turn-1' } : { workKey: 'turn-1' }), resourceId: 'ayse', threadId: 'T', messages: process.argv[5] === 'hist' ? [...hist, { role: 'user', content: 'pay 5' }] : [{ role: 'user', content: 'pay 5' }] } as any;
if (phase === 'crash' && process.argv[5] === 'hist') { const s0 = await gnl.stream('pharm', turn0); for await (const _ of s0.fullStream as any) {} }
const waitMs = Number(process.env.WAIT_MS ?? 0); if (waitMs) { await gnl.stream('pharm', { workKey: 'warmup', resourceId: 'bob', threadId: 'W', messages: [{ role: 'user', content: 'pay 1' }] } as any).then(async (x: any) => { for await (const _ of x.fullStream) {} }); await new Promise((r) => setTimeout(r, waitMs)); console.log('EFFECTS_AFTER_WAIT', effects); }
const t0 = Date.now();
if (phase === 'retry') console.log('RETRY_START');
const s = await gnl.stream('pharm', turn);
let text = ''; const parts: string[] = [];
for await (const p of s.fullStream as any) { parts.push(p.type); if (p.type === 'text-delta') text += p.text ?? p.delta ?? ''; if (p.type === 'tool-result') console.log('TOOLRESULT', JSON.stringify(p).slice(0, 400)); if (p.type === 'error') console.log('ERRPART', JSON.stringify(p).slice(0, 200)); }
console.log('RESULT', JSON.stringify({ phase, text, parts: [...new Set(parts)], effects, ms: Date.now() - t0 }));
process.exit(0);
