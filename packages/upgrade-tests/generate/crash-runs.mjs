// The run history both sides of the 0.16.0 upgrade write, outside the queue: the generator writes it with
// 0.16.0 (generate/0.16.0-runs.mjs → fixtures/0.16.0/runs.db, postgres-runs.sql), the tests build the same
// agents with the current code, open the store 0.16.0 left, and continue its runs.
// Everything here is passed the modules it uses (`m.durable`, `m.z`), so the same text runs against either
// version.
//
// Four runs, each where a process can stop:
//
//   r-done          completed: a tool that ran and returned, an answer, a thread with its messages;
//   r-mid-recover   stopped in the middle of its second step: `note` finished, `charge` had started and
//                   wrote no result (the process died inside it). `charge` declares a `recover()` hook;
//   r-mid-human     the same, but `wire` declares none: the crash ladder ends at a person;
//   r-pending       asked for an approval (`pay` needs one) and waits for it.
//
// What a tool's body does is recorded in `env.effects`, in order; `env.gateway` stands for the system the
// tool reaches (a payment provider): what `recover()` asks. When `env.hang` is set, `charge` and `wire`
// start and never return, which is how the generator leaves their runs `running`.

const usage = { inputTokens: { total: 10, noCache: 10 }, outputTokens: { total: 5, text: 5 } };
const fin = (r) => ({ unified: r, raw: r });
const model = (fn) => ({
  specificationVersion: 'v4', provider: 'mock', modelId: 'mock', supportedUrls: {},
  // No doStream: @gnldev/durable streams a generate-only model from its answer.
  doGenerate: async (o) => fn(o),
});
const toolsSeen = (p) => (p ?? []).filter((x) => x.role === 'tool').length;
const call = (name, input) => ({ content: [{ type: 'tool-call', toolCallId: `call_${name}`, toolName: name, input: JSON.stringify(input) }], finishReason: fin('tool-calls'), usage, warnings: [] });
const text = (t) => ({ content: [{ type: 'text', text: t }], finishReason: fin('stop'), usage, warnings: [] });
/** Calls each tool in turn (one per step), then answers. */
const steps = (...calls) => model(async ({ prompt }) => { const n = toolsSeen(prompt); return n < calls.length ? call(calls[n][0], calls[n][1]) : text('ok'); });

export const RUNS = { done: 'r-done', midRecover: 'r-mid-recover', midHuman: 'r-mid-human', pending: 'r-pending' };
export const THREAD = { done: 't-alice-1', pending: 't-alice-3' };

/** `env`: `{ effects: string[], gateway: Map<idempotencyKey, output>, hang?: (toolName) => void }`. */
export function agentsOf(m, env) {
  const d = m.durable;
  const schema = m.z.object({}).passthrough();
  const never = new Promise(() => {});
  const body = (name, output) => async (a, o) => {
    env.effects.push(`${name}:${JSON.stringify(a)}`);
    if (env.hang) { env.hang(name); await never; }
    const key = o?.idempotencyKey;
    if (key) env.gateway.set(key, output);
    return output;
  };
  const note = d.gnlTool({ description: 'note', inputSchema: schema, execute: async (a) => { env.effects.push(`note:${JSON.stringify(a)}`); return { ok: true }; } }, { sideEffect: true });
  const charge = d.gnlTool({ description: 'charge', inputSchema: schema, execute: body('charge', { charged: true }) }, {
    sideEffect: true,
    // The provider is asked with the key the call carried: done (with what it answered) or not.
    recover: async (_input, o) => {
      env.effects.push(`recover:${o.idempotencyKey}`);
      return env.gateway.has(o.idempotencyKey) ? { done: true, output: env.gateway.get(o.idempotencyKey) } : { done: false };
    },
  });
  const wire = d.gnlTool({ description: 'wire', inputSchema: schema, execute: body('wire', { wired: true }) }, { sideEffect: true });
  const pay = d.gnlTool({ description: 'pay', inputSchema: schema, execute: async (a) => { env.effects.push(`pay:${JSON.stringify(a)}`); return { ok: true }; } }, { sideEffect: true, confirm: true });
  return {
    noter: { model: steps(['note', { n: 1 }]), tools: { note } },
    twostep: { model: steps(['note', { n: 2 }], ['charge', { amt: 9 }]), tools: { note, charge } },
    twohuman: { model: steps(['note', { n: 3 }], ['wire', { to: 'acme' }]), tools: { note, wire } },
    payer: { model: steps(['pay', { amt: 5 }]), tools: { pay } },
  };
}

/**
 * One gnl over `storage`: its agents, a memory on the same journal, and `run`, which answers a name instead of
 * throwing. `sweep: false` leaves the process's sweeper (detached.ts: every process takes over the runs of one
 * that is gone) off, so a test continues each run itself and nothing else moves.
 */
export function gnlOf(m, storage, env, { sweep = true } = {}) {
  const d = m.durable;
  const memory = new d.BasicMemory(d.toJournal(storage.runs));
  const g = d.createGnl({ storage, agents: agentsOf(m, env), memory, ...(sweep ? {} : { detached: { sweepMs: 0 } }) });
  const run = async (agent, runId, who, threadId, extra = {}) => {
    try {
      const r = await g.run(agent, { runId, prompt: `go ${runId}`, caller: d.user(who), ...(threadId ? { threadId } : {}), ...extra });
      return r.interrupts?.length ? 'suspended' : `ok:${r.text ?? ''}`;
    } catch (e) {
      return `error:${e?.name}`;
    }
  };
  return { g, memory, run };
}

/**
 * Writes the history into `storage`; returns what each call answered and the effects in order. The two
 * runs that stop in a tool are not awaited: the caller exits the process with them there.
 */
export async function writeCrashRuns(m, storage) {
  const env = { effects: [], gateway: new Map() };
  const hanging = new Set();
  let reached;
  const both = new Promise((resolve) => { reached = resolve; });
  env.hang = (name) => { hanging.add(name); if (hanging.size === 2) reached(); };
  const { run, memory } = gnlOf(m, storage, env);
  const out = {};
  out[RUNS.done] = await run('noter', RUNS.done, 'alice', THREAD.done);
  out[RUNS.pending] = await run('payer', RUNS.pending, 'alice', THREAD.pending);
  // Neither returns: their runs stay `running`, a tool claimed and no result written.
  void run('twostep', RUNS.midRecover, 'alice', 't-alice-2').then(() => undefined, () => undefined);
  void run('twohuman', RUNS.midHuman, 'bob', 't-bob-1').then(() => undefined, () => undefined);
  await both;
  out.effects = [...env.effects];
  out.threadMessages = (await memory.getMessages(THREAD.done)).length;
  return out;
}
