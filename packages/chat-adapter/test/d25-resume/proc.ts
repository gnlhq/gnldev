// d25 resume harness — one OS process of an agent server (createRestApi + chatSurface), on a real store.
//
//   phase 'crash': sends one turn through DOOR; the tool body SIGKILLs this process (kill -9 mid-tool).
//   phase 'serve': reopens the same store (a restart), waits WAIT_MS with NO request (does the process
//                  continue the crashed run on its own?), prints what happened, then re-sends the same turn
//                  through DOOR and prints exactly what the client got (status, body / stream frames).
//
// Effects are appended to EFFECTS (a file), so they count across processes. Everything is printed as
// `KEY {json}` lines the driving test parses. Imports the BUILT packages (one module instance each).
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { createGnl, toJournal } from '@gnldev/durable';
import { createRestApi } from '../../../server/dist/index.js';
import { chatSurface } from '../../dist/index.js';
import { aguiSurface } from '../../../agui/dist/index.js';
import { AgentMemory } from '../../../memory/dist/index.js';
import { roleAuth, signSubjectToken } from '@gnldev/auth';
const SECRET = 'd25-resume-end-user-secret-0123456789abcdef-0123456789';

const env = process.env;
const phase = env.PHASE!;
const backend = env.BACKEND ?? 'sqlite';
const door = env.DOOR ?? 'run';
const idMode = env.ID_MODE ?? 'workkey'; // workkey | runid
const preset = env.PRESET ?? 'assistant';
const EFFECTS = env.EFFECTS!;
const SYSTEM = env.SYSTEM_TEXT ?? 'you are a pharmacy assistant';

const effects = () => (existsSync(EFFECTS) ? readFileSync(EFFECTS, 'utf8').split('\n').filter(Boolean).length : 0);
const out = (k: string, v: unknown) => console.log(`${k} ${JSON.stringify(v)}`);

async function openStorage(): Promise<any> {
  if (backend === 'sqlite') { const { SqliteStorage } = await import('@gnldev/durable/sqlite') as any; return new SqliteStorage(env.DB!); }
  if (backend === 'pg') { const { PostgresStorage } = await import('@gnldev/durable/postgres'); return new PostgresStorage({ connectionString: env.DB! }); }
  if (backend === 'mongo') { const { MongoStorage } = await import('@gnldev/durable/mongo'); return new MongoStorage({ connectionString: env.DB!, database: env.MONGO_DB! }); }
  throw new Error('backend ' + backend);
}

// A model that calls `pay` once for the last user message, then answers "paid".
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const model: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => { throw new Error('stream only'); },
  doStream: async ({ prompt }: any) => {
    const lastUser = prompt.map((m: any) => m.role).lastIndexOf('user');
    const answered = prompt.slice(lastUser).some((m: any) => m.role === 'tool');
    const parts: any[] = answered
      ? [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'paid' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: 'stop', usage }]
      : [{ type: 'tool-call', toolCallId: env.RANDID === '1' ? 'call-' + Math.random().toString(36).slice(2, 10) : 'call-pay', toolName: 'pay', input: JSON.stringify({ amount: 5 }) }, { type: 'finish', finishReason: 'tool-calls', usage }];
    return { stream: new ReadableStream({ start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); for (const p of parts) c.enqueue(p); c.close(); } }) };
  },
};

const storage = await openStorage();
const config: any = {
  storage, preset,
  ...(env.MEMORY === '1' ? { memoryFactory: (st: any) => new AgentMemory({ storage: st }) } : {}),
  agents: { pharm: { model, system: SYSTEM, tools: { pay: {
    description: 'pay', inputSchema: z.object({ amount: z.number() }), sideEffect: true, ...(env.CONFIRM === '1' ? { confirm: true } : {}),
    ...(env.NOKEY === '1' ? {} : { idempotencyKey: (a: any) => `pay-${a.amount}`, idempotencyWindow: (env.WINDOW === 'none' ? undefined : env.WINDOW ?? 'thread') as any, recover: async () => ({ done: false }) }),
    execute: async (a: any) => {
      appendFileSync(EFFECTS, `${process.pid} ${phase}\n`);
      if (phase === 'crash') process.kill(process.pid, 'SIGKILL');
      return { ok: true, amount: a.amount };
    },
  } } } },
};
// AUTH=org: an end-user token bound to an organization (23-egitim's setup) — the run lives in that org's scope.
const auth = env.AUTH === 'org' ? roleAuth({ endUsers: { secret: SECRET, orgId: 'okul' } } as any) : undefined;
const early = env.GNL_FIRST === '1' ? createGnl(config) : undefined;
const api = createRestApi(config, { surfaces: [chatSurface(), aguiSurface()], protectionsBanner: false, ...(auth ? { auth } : {}), ...(env.DUP === 'thread' ? { limits: { sideEffectDuplicates: { action: 'suspend', scope: 'thread' } } } : {}) } as any);
const gnl = early ?? createGnl(config); // read-side only (outcome)

let turnId = env.TURN ?? 't1';
const thread = env.THREAD ?? `th-${turnId}`;
let approvals: Record<string, boolean> | undefined;
function request(): Request {
  const ident = idMode === 'runid' ? { runId: `run-${turnId}` } : { workKey: `wk-${turnId}` };
  const h: Record<string, string> = { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${signSubjectToken({ sub: 'ayse' }, SECRET, { ttlSec: 900 })}` } : {}) };
  if (door === 'chat') {
    // The chat door derives the turn's id from (conversation, last message); a subject makes it a workKey.
    const body = { id: `conv-${turnId}`, resourceId: 'ayse', ...(idMode === 'runid' ? { runId: `run-${turnId}` } : {}), messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'pay 5' }] }], ...(approvals ? { approvals } : {}) };
    return new Request('http://x/agents/pharm/chat', { method: 'POST', headers: h, body: JSON.stringify(body) });
  }
  const body = { ...ident, resourceId: 'ayse', threadId: thread, messages: [{ role: 'user', content: 'pay 5' }], ...(approvals ? { approvals } : {}) };
  return new Request(`http://x/agents/pharm/${door}`, { method: 'POST', headers: h, body: JSON.stringify(body) });
}

async function send(label: string) {
  const t0 = Date.now();
  const res = await api(request());
  // The body is read as it arrives: `chunks` says WHEN each piece reached the client (a client that waits
  // in silence and one that is told something while it waits look the same in `body` alone).
  const chunks: Array<{ ms: number; text: string }> = [];
  const dec = new TextDecoder();
  if (res.body) { const rd = res.body.getReader(); for (;;) { const { done, value } = await rd.read(); if (done) break; chunks.push({ ms: Date.now() - t0, text: dec.decode(value, { stream: true }) }); } }
  const text = chunks.map((c) => c.text).join('');
  out(label, { status: res.status, ms: Date.now() - t0, idem: res.headers.get('x-gnl-idempotency-status'), body: text.length > 1500 ? text.slice(0, 700) + ' … ' + text.slice(-700) : text, full: text, chunks });
}

async function execRecords() {
  const j: any = toJournal(storage.runs ?? storage);
  const keys: string[] = await j.listKeys('__exec__');
  const recs = await Promise.all(keys.map((k) => j.get(k)));
  return recs.map((r: any) => ({ runId: r?.runId, status: r?.status, reason: r?.reason }));
}

if (phase === 'crash') {
  if (env.CONFIRM === '1') { await send('ASKED'); approvals = { 'call-pay': true }; }
  await send('CRASH_RESPONSE'); // never reached when the tool kills us
  out('CRASH_NOT_KILLED', { effects: effects() });
  process.exit(3);
}

// phase 'serve' — a restarted process.
out('BOOT', { effects: effects(), exec: await execRecords() });
const wait = Number(env.WAIT_MS ?? 0);
if (wait) {
  const t0 = Date.now(); const e0 = effects(); let seen = false;
  while (Date.now() - t0 < wait) {
    await new Promise((r) => setTimeout(r, 250));
    if (!seen && effects() > e0) { seen = true; out('CONTINUED_ON_ITS_OWN', { afterMs: Date.now() - t0 }); }
  }
  out('AFTER_WAIT', { effects: effects(), exec: await execRecords() });
}
if (env.CANCEL === '1') {
  const list: any = await (await api(new Request('http://x/runs'))).json();
  const id = (Array.isArray(list) ? list : list.items ?? [])[0]?.runId;
  const r = await api(new Request(`http://x/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }));
  out('CANCEL', { id, status: r.status, body: (await r.text()).slice(0, 300) });
}
process.on('exit', (c) => console.log(`EXIT ${c}`));
if (env.REDRIVE_TURN) turnId = env.REDRIVE_TURN;
if (env.REDRIVE !== '0') {
  await send('REDRIVE');
  await new Promise((r) => setTimeout(r, Number(env.SETTLE_MS ?? 500)));
  out('AFTER_REDRIVE', { effects: effects(), exec: await execRecords() });
}
if (env.REDRIVE2 === '1') {
  await send('REDRIVE2');
  out('AFTER_REDRIVE2', { effects: effects(), exec: await execRecords() });
}
void gnl;
process.exit(0);
