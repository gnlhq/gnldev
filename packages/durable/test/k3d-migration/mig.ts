// S16 — upgrade in the middle of a run. ONE process of a tiny agent; which code it runs is ROOT (a worktree
// with a built dist): the base tree for process 1, the candidate for process 2, the same store file/DB.
//   ROLE=pend    : the tool asks a person (confirm); the run suspends; the process exits cleanly.
//   ROLE=answer  : same runId again, answered with APPROVE_KEY (a provider id, or what the question named).
//   ROLE=crash   : the tool's body does its effect and the process is SIGKILLed inside it.
//   ROLE=resume  : same runId again (APPROVE_KEY set: answered, as the blocked error tells the operator).
// Every observation is a `KEY {json}` line; effects are counted in a file shared by the processes.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { stepCountIs } from 'ai';
import { z } from 'zod';

const env = process.env;
const ROOT = env.ROOT!;
const dur: any = await import(`${ROOT}/packages/durable/dist/index.js`);
const effects = () => (existsSync(env.EFFECTS!) ? readFileSync(env.EFFECTS!, 'utf8').split('\n').filter(Boolean).length : 0);
const out = (k: string, v: unknown) => console.log(`${k} ${JSON.stringify(v)}`);
console.warn = () => {};

async function journal(): Promise<any> {
  if (env.BACKEND === 'pg') { const { PostgresStorage } = await import(`${ROOT}/packages/durable/dist/postgres-storage.js`); return dur.toJournal(new PostgresStorage({ connectionString: env.DB! })); }
  const { SqliteStorage } = await import(`${ROOT}/packages/durable/dist/sqlite-storage.js`);
  return dur.toJournal(new SqliteStorage(env.DB!));
}

const usage = { inputTokens: { total: 1, noCache: 1 }, outputTokens: { total: 1, text: 1 } };
const model: any = {
  specificationVersion: 'v4', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async ({ prompt }: any) => {
    const done = prompt.some((m: any) => m.role === 'tool');
    return done
      ? { content: [{ type: 'text', text: 'paid' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }
      : { content: [{ type: 'tool-call', toolCallId: 'call_0', toolName: 'pay', input: JSON.stringify({ amount: 5 }) }], finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage, warnings: [] };
  },
  doStream: async () => { throw new Error('generate only'); },
};
const crash = env.ROLE === 'crash';
const tools = {
  pay: {
    description: 'pay', inputSchema: z.object({ amount: z.number() }), sideEffect: true,
    ...(crash || env.ROLE === 'resume' ? {} : { confirm: true }),
    execute: async (a: any) => {
      appendFileSync(env.EFFECTS!, `${env.ROLE} ${process.pid} amount=${a.amount}\n`);
      if (crash) process.kill(process.pid, 'SIGKILL');
      return { ok: true, amount: a.amount };
    },
  },
};

const j = await journal();
const run = async (approvals?: Record<string, boolean>) => {
  try {
    const r: any = await dur.runDurable({ runId: 'k3d-mig', journal: j, model, tools, stopWhen: stepCountIs(4), prompt: 'pay 5', ...(approvals ? { approvals } : {}) });
    return { text: r.text, interrupts: (r.interrupts ?? []).map((i: any) => ({ id: i.toolCallId, reason: String(i.reason).slice(0, 100) })) };
  } catch (e: any) { return { error: String(e?.message ?? e).slice(0, 220), name: e?.name }; }
};

if (env.ROLE === 'pend' || env.ROLE === 'crash') { out('P1', await run()); out('P1_EFFECTS', { effects: effects() }); }
if (env.ROLE === 'answer' || env.ROLE === 'resume') {
  const first = await run(); out('R1', first); out('R1_EFFECTS', { effects: effects() });
  const key = env.APPROVE_KEY;
  if (key) { const second = await run({ [key]: true }); out('R2', second); out('R2_EFFECTS', { effects: effects() }); }
}
if (j.close) await j.close?.();
process.exit(0);
