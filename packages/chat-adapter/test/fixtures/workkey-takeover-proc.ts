// Child process for workkey-takeover-two-processes.test.ts. It is a whole deployment — the built packages
// (dist), a real store, the authenticated chat route — and it dies the way a process dies (SIGKILL).
//   argv: phase (crash | retry) · store (a SQLite file, or a postgres:// URL) · kill (before | after: the
//         tool body dies before or after its effect lands) · effects file
//   phase 'crash' posts the turn and is killed inside the tool body; phase 'retry' opens the same store,
//   waits for its executor's sweep, posts the SAME turn and prints what the client got.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { createGnl } from '@gnldev/durable';
import { createChatRoute } from '@gnldev/chat-adapter';

const [phase, store, kill, effectsFile] = process.argv.slice(2) as [string, string, string, string];
const storage = store.startsWith('postgres')
  ? new (await import('@gnldev/durable/postgres')).PostgresStorage({ connectionString: store })
  : new (await import('@gnldev/durable/sqlite')).SqliteStorage(store);

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const mkStream = (arr: unknown[]) => new ReadableStream({ start(c) { for (const p of arr) c.enqueue(p); c.close(); } });
// The model asks for the payment once per turn, then answers.
const model: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => { throw new Error('stream only'); },
  doStream: async ({ prompt }: { prompt: Array<{ role: string }> }) => {
    const lastUser = prompt.map((m) => m.role).lastIndexOf('user');
    const answered = prompt.slice(lastUser).some((m) => m.role === 'tool');
    return {
      stream: mkStream(answered
        ? [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'paid' }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]
        : [{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: 'call-1', toolName: 'pay', input: JSON.stringify({ order: 'o-5', amount: 5 }) }, { type: 'finish', finishReason: 'tool-calls', usage }]),
    };
  },
};

const effects = () => (existsSync(effectsFile) ? readFileSync(effectsFile, 'utf8').split('\n').filter(Boolean) : []);
const gnl = createGnl({
  storage, preset: 'assistant', memory: false,
  agents: { pharm: { model, tools: { pay: {
    description: 'pay', inputSchema: z.object({ order: z.string(), amount: z.number() }),
    sideEffect: true, idempotencyKey: (a: { order: string }) => a.order, idempotencyWindow: 'thread',
    // Honest: the external system (the effects file) is asked whether this order was charged.
    recover: async (a: { order: string }) => (effects().some((l) => l.endsWith(` ${a.order}`)) ? { done: true, output: { ok: 1 } } : { done: false }),
    execute: async (a: { order: string }) => {
      if (phase === 'crash' && kill === 'before') process.kill(process.pid, 'SIGKILL');
      appendFileSync(effectsFile, `${process.pid} ${a.order}\n`);
      if (phase === 'crash' && kill === 'after') process.kill(process.pid, 'SIGKILL');
      return { ok: 1 };
    },
  } } } } as any,
} as any);
// The authenticated chat: the route knows the user, so the turn's name is a workKey (a derived `run1_` id).
const app = createChatRoute({ gnl }, { identify: () => ({ kind: 'subject', id: 'ayse', roles: [] }) as any });
const turn = { id: 'conv-1', messages: [{ id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'pay order o-5' }] }] };
const post = async () => {
  const res = await app.request('/agents/pharm/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(turn) });
  return { status: res.status, runId: res.headers.get('X-Gnl-Run-Id'), body: await res.text() };
};

if (phase === 'crash') { console.log('CRASH_PHASE_SURVIVED', JSON.stringify(await post()).slice(0, 600)); process.exit(3); } // never reached: the tool body kills the process
await new Promise((r) => setTimeout(r, Number(process.env.WAIT_MS ?? 3000)));
console.log('EFFECTS_BEFORE_RETRY', effects().length);
const r = await post();
const events = r.body.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).filter((d) => d !== '[DONE]').map((d) => JSON.parse(d));
const text = events.filter((e) => e.type === 'text-delta').map((e) => e.delta).join('');
const errors = events.filter((e) => e.type === 'error').map((e) => e.errorText);
if (process.env.DEBUG_BODY) console.log('BODY', r.body.slice(0, 3000));
console.log('RESULT', JSON.stringify({ status: r.status, derived: r.runId?.startsWith('run1_'), text, errors, types: [...new Set(events.map((e) => e.type))], effects: effects().length }));
await (storage as { close?: () => Promise<void> }).close?.();
process.exit(0);
