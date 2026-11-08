// k3 call-identity harness — ONE OS process of an agent server (createRestApi + chatSurface) on a real store.
// Behaviour-only: it drives the public doors (REST /run, /stream, the chat surface, GET /runs) and counts
// side effects in a file shared by all processes. It reads no internal record, key or field name.
//
// The fake provider names its tool calls like providers that number per response: every response's call
// is `call_0` (IDS=same). IDS=unique gives every call a fresh random id — the control.
//
//   ROLE=crash : sends turn t1 in thread TH; the tool body appends an effect and SIGKILLs this process.
//   ROLE=hang  : sends turn t1; the tool body appends an effect and stays in the body for HANG_MS (alive).
//   ROLE=serve : a (re)started process on the same store.
//                ORDER=msg-first      → sends the NEW message (t2, same thread) at once;
//                ORDER=takeover-first → first waits until the dead run is no longer 'running' in GET /runs
//                                       (the restarted process took it over and stopped it), then sends t2.
//                CONFIRM=1  → in THIS process the tool asks a person first (confirm: true); t2's question is
//                             approved and t2 re-sent (the live-twin case).
//                APPROVE_T2=1 → if t2 is asked anything, a person approves every question and t2 is re-sent.
//                OLD_Q=1      → (run door) re-sends t1 with no approval: what does the old run ask now?
//                OLD_APPROVE=1→ then approves the old run's question(s) and re-sends t1.
//
// Every observation is a `KEY {json}` line the driving test parses.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { createRestApi } from '../../../server/dist/index.js';
import { chatSurface } from '../../dist/index.js';
import { AgentMemory } from '../../../memory/dist/index.js';
import { pendingWork, toJournal } from '@gnldev/durable';

const env = process.env;
const role = env.ROLE!;
const backend = env.BACKEND ?? 'sqlite';
const door = env.DOOR ?? 'run';
const EFFECTS = env.EFFECTS!;
const THREAD = 'TH';

const effectLines = () => (existsSync(EFFECTS) ? readFileSync(EFFECTS, 'utf8').split('\n').filter(Boolean) : []);
const effects = () => effectLines().length;
const out = (k: string, v: unknown) => console.log(`${k} ${JSON.stringify(v)}`);

async function openStorage(): Promise<any> {
  if (backend === 'sqlite') { const { SqliteStorage } = await import('@gnldev/durable/sqlite') as any; return new SqliteStorage(env.DB!); }
  if (backend === 'pg') { const { PostgresStorage } = await import('@gnldev/durable/postgres') as any; return new PostgresStorage({ connectionString: env.DB! }); }
  if (backend === 'mongo') { const { MongoStorage } = await import('@gnldev/durable/mongo') as any; return new MongoStorage({ connectionString: env.DB!, database: env.MONGO_DB! }); }
  throw new Error('backend ' + backend);
}

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const callId = () => (env.IDS === 'unique' ? 'call_' + crypto.randomUUID() : 'call_0');
// Calls `pay` once for the last user message, then answers "paid".
const model: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => { throw new Error('stream only'); },
  doStream: async ({ prompt }: any) => {
    const lastUser = prompt.map((m: any) => m.role).lastIndexOf('user');
    const answered = prompt.slice(lastUser).some((m: any) => m.role === 'tool');
    const parts: any[] = answered
      ? [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'paid' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: 'stop', usage }]
      : [{ type: 'tool-call', toolCallId: callId(), toolName: 'pay', input: JSON.stringify({ amount: 5 }) }, { type: 'finish', finishReason: 'tool-calls', usage }];
    return { stream: new ReadableStream({ start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); for (const p of parts) c.enqueue(p); c.close(); } }) };
  },
};

// PROT: how the tool is protected.
//   preset     — nothing declared beyond sideEffect; the 'assistant' preset's default protection (the default install)
//   dup        — limits.sideEffectDuplicates { action: 'suspend', scope: 'thread' } declared explicitly
//   key-thread / key-cross — idempotencyKey + idempotencyWindow 'thread' / 'cross-run', no recover()
//   args-thread — idempotency: 'args' + idempotencyWindow 'thread', no recover()
const prot = env.PROT ?? 'preset';
const toolProt: Record<string, unknown> =
  prot === 'key-thread' ? { idempotencyKey: (a: any) => `pay-${a.amount}`, idempotencyWindow: 'thread' }
  : prot === 'key-cross' ? { idempotencyKey: (a: any) => `pay-${a.amount}`, idempotencyWindow: 'cross-run' }
  : prot === 'args-thread' ? { idempotency: 'args', idempotencyWindow: 'thread' }
  : {};

const storage = await openStorage();
const config: any = {
  storage, preset: 'assistant',
  memoryFactory: (st: any) => new AgentMemory({ storage: st }),
  agents: { pharm: { model, system: 'you are a pharmacy assistant', tools: { pay: {
    description: 'pay', inputSchema: z.object({ amount: z.number() }), sideEffect: true,
    ...(env.CONFIRM === '1' ? { confirm: true } : {}),
    ...toolProt,
    execute: async (a: any) => {
      appendFileSync(EFFECTS, `${role} ${process.pid} ${turn} amount=${a.amount}\n`);
      if (role === 'crash') process.kill(process.pid, 'SIGKILL');
      if (role === 'hang') { out('BODY_START', { t: Date.now() }); await new Promise((r) => setTimeout(r, Number(env.HANG_MS ?? 8000))); out('BODY_END', { t: Date.now() }); }
      return { ok: true, amount: a.amount };
    },
  } } } },
};
const api = createRestApi(config, {
  surfaces: [chatSurface()], protectionsBanner: false,
  ...(prot === 'dup' ? { limits: { sideEffectDuplicates: { action: 'suspend', scope: 'thread' } } } : {}),
} as any);

let turn = 't1';
function request(t: string, approvals?: Record<string, boolean>): Request {
  const h = { 'content-type': 'application/json' };
  if (door === 'chat') {
    const body = { id: `conv-${THREAD}`, resourceId: 'ayse', messages: [{ id: `m-${t}`, role: 'user', parts: [{ type: 'text', text: `pay 5 (${t})` }] }], ...(approvals ? { approvals } : {}) };
    return new Request('http://x/agents/pharm/chat', { method: 'POST', headers: h, body: JSON.stringify(body) });
  }
  const body = { workKey: `wk-${t}`, resourceId: 'ayse', threadId: THREAD, messages: [{ role: 'user', content: `pay 5 (${t})` }], ...(approvals ? { approvals } : {}) };
  return new Request(`http://x/agents/pharm/${door}`, { method: 'POST', headers: h, body: JSON.stringify(body) });
}

/** What the client got, in door-independent terms: status, text, the questions (id + reason), an error/blocked frame. */
async function send(label: string, t: string, approvals?: Record<string, boolean>) {
  turn = t;
  const t0 = Date.now();
  const res = await api(request(t, approvals));
  const raw = await res.text();
  let text = ''; let interrupts: Array<{ toolCallId: string; reason: string }> = []; let blocked = ''; let runId: string | null = res.headers.get('x-gnl-run-id');
  try {
    if (door === 'run') {
      const j = JSON.parse(raw);
      text = j.text ?? ''; interrupts = j.interrupts ?? []; runId = j.runId ?? runId;
      if (res.status >= 400) blocked = raw.slice(0, 600);
    } else if (door === 'stream') {
      for (const blk of raw.split('\n\n')) {
        const ev = /^event: (.*)$/m.exec(blk)?.[1]; const d = /^data: (.*)$/m.exec(blk)?.[1]; if (!d) continue;
        let j: any; try { j = JSON.parse(d); } catch { continue; }
        if (ev === 'error') blocked += JSON.stringify(j).slice(0, 600);
        if (ev === 'interrupt') interrupts = j.interrupts ?? interrupts;
        if (ev === 'text-delta') text += j.text ?? '';
        if (j?.runId && !runId) runId = j.runId;
      }
    } else {
      for (const blk of raw.split('\n\n')) {
        const d = /^data: (.*)$/m.exec(blk)?.[1]; if (!d || d === '[DONE]') continue;
        let j: any; try { j = JSON.parse(d); } catch { continue; }
        if (j.type === 'data-gnl-interrupt') interrupts = j.data?.interrupts ?? interrupts;
        if (j.type === 'error') blocked += JSON.stringify(j).slice(0, 600);
        if (j.type === 'tool-output-available' && j.output && typeof j.output === 'object' && (j.output.blocked || j.output.__gnl_blocked)) blocked += JSON.stringify(j.output).slice(0, 600);
        if (j.type === 'text-delta') text += j.delta ?? '';
      }
    }
  } catch (e) { blocked = 'PARSEERR ' + String(e) + ' ' + raw.slice(0, 300); }
  if (res.status >= 400 && !blocked) blocked = raw.slice(0, 600);
  const r = { status: res.status, ms: Date.now() - t0, runId, text, blocked, interrupts: interrupts.map((i: any) => ({ toolCallId: i.toolCallId, reason: String(i.reason ?? '') })), effects: effects() };
  out(label, r);
  return r;
}

/** The old run's open questions / calls in doubt, through the documented operator API (`gnl pending`). */
async function pendingIdsOf(runId: string | null): Promise<string[]> {
  const p: any = await pendingWork(toJournal(storage.runs ?? storage) as any);
  return [...p.awaitingApproval, ...p.inDoubt].filter((w: any) => !runId || w.runId === runId).map((w: any) => w.toolCallId).filter(Boolean);
}

if (role === 'crash' || role === 'hang') {
  const r = await send('T1', 't1');
  out('T1_DONE', { effects: effects(), r });
  process.exit(role === 'crash' ? 3 : 0);
}

// ---- role serve ----
out('BOOT', { effects: effects() });
if (env.ORDER === 'takeover-first') {
  // The restarted process takes the dead run over by itself (SQLite ≈ 1–2 s after boot, Postgres/MongoDB ≈ 6 s:
  // the liveness grace; measured in konu3/zaman.md). No public door says "taken over" (GET /runs keeps it
  // 'running'), so the new message waits well past that: TAKEOVER_WAIT_MS.
  await new Promise((r) => setTimeout(r, Number(env.TAKEOVER_WAIT_MS ?? (backend === 'sqlite' ? 5000 : 12000))));
  out('TAKEOVER_WAITED', { effects: effects() });
}

let t2 = await send('T2', 't2');
if (env.CONFIRM === '1' && t2.interrupts.length) {
  out('APPROVING_T2', { ids: t2.interrupts.map((i) => i.toolCallId), effects: effects() });
  t2 = await send('T2_APPROVED', 't2', Object.fromEntries(t2.interrupts.map((i) => [i.toolCallId, true])));
}
if (env.APPROVE_T2 === '1' && t2.interrupts.length) {
  t2 = await send('T2_APPROVED', 't2', Object.fromEntries(t2.interrupts.map((i) => [i.toolCallId, true])));
}
await new Promise((r) => setTimeout(r, Number(env.SETTLE_MS ?? 500)));
out('AFTER_T2', { effects: effects() });

if (env.OLD_Q === '1') {
  const q = await send('OLD_Q', 't1');
  // A person answers the old run's question: by the ids it asked with, or (a 409 crash-ladder refusal names
  // no interrupt) by the calls the operator API lists as in doubt / awaiting approval for that run.
  const ids = q.interrupts.length ? q.interrupts.map((i) => i.toolCallId) : await pendingIdsOf(q.runId);
  out('OLD_IDS', { ids });
  if (env.OLD_APPROVE === '1' && ids.length) {
    await send('OLD_APPROVED', 't1', Object.fromEntries(ids.map((id) => [id, true])));
    await new Promise((r) => setTimeout(r, Number(env.SETTLE_MS ?? 500)));
  }
}
out('FINAL', { effects: effects(), lines: effectLines() });
process.exit(0);
