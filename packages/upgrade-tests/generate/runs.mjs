// The run history both sides of the 0.10.0 upgrade write, and the questions both ask of it: the
// generator writes it with 0.10.0 (generate/0.10.0.mjs → fixtures/0.10.0), the tests write it again with
// the current code into a new store and compare every answer of the upgraded store with that one's.
// Everything here is passed the modules it uses (`m.durable`, `m.AgentMemory`, `m.z`), so the same text
// runs against either version.
//
// Runs of every kind 0.10.0 has: completed, suspended on an approval, failed (the model throws), canceled,
// one left running (its process died inside the tool), sub-agents (one suspended inside the child, one
// done), a staff run, a run approved and resumed, a person erased on 0.10.0, and an organization with its
// own runs and threads — the person `alice` in both scopes.

export const SUBJECTS = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'mallory'];
export const THREADS = ['t-alice-1', 't-alice-2', 't-alice-3', 't-bob-1', 't-bob-2', 't-carol-1', 't-carol-2', 't-erin-1', 't-dave-1', 't-frank-1', 't-frank-2', 't-alice-acme', 't-never'];
const STATUSES = ['completed', 'suspended', 'failed', 'running', 'canceled'];
export const ORG = 'acme';

const usage = { inputTokens: { total: 10, noCache: 10 }, outputTokens: { total: 5, text: 5 } };
const fin = (r) => ({ unified: r, raw: r });
const model = (fn) => ({
  specificationVersion: 'v4', provider: 'mock', modelId: 'mock', supportedUrls: {},
  // No doStream: a registry run streams, and @gnldev/durable streams a generate-only model from its answer.
  doGenerate: async (o) => fn(o),
});
const toolsSeen = (p) => (p ?? []).filter((x) => x.role === 'tool').length;
const call = (name, input) => ({ content: [{ type: 'tool-call', toolCallId: 'call_0', toolName: name, input: JSON.stringify(input) }], finishReason: fin('tool-calls'), usage, warnings: [] });
const text = (t) => ({ content: [{ type: 'text', text: t }], finishReason: fin('stop'), usage, warnings: [] });
const callsThenText = (name, input) => model(async ({ prompt }) => (toolsSeen(prompt) ? text('ok') : call(name, input)));

/**
 * The agents, and the effects their tools record (`effects`, in order). `hang`'s tool does not return
 * until `unhang()` — the run it is called in stays `running`, as a run does whose process died inside a
 * tool (the generator exits with it still there; a test lets it go before it closes the store, or its
 * claim's heartbeat keeps writing).
 */
export function agentsOf(m) {
  const d = m.durable;
  const effects = [];
  let hung;
  let unhang;
  const started = new Promise((resolve) => { hung = resolve; });
  const released = new Promise((resolve) => { unhang = resolve; });
  const schema = m.z.object({}).passthrough();
  const pay = d.gnlTool({ description: 'pay', inputSchema: schema, execute: async (a) => { effects.push(`pay:${JSON.stringify(a)}`); return { ok: true }; } }, { sideEffect: true, confirm: true });
  const note = d.gnlTool({ description: 'note', inputSchema: schema, execute: async (a) => { effects.push(`note:${JSON.stringify(a)}`); return { ok: true }; } }, { sideEffect: true });
  const hang = d.gnlTool({ description: 'hang', inputSchema: schema, execute: async () => { hung(); await released; return { ok: true }; } }, { sideEffect: true });
  const agents = {
    plain: { model: model(async () => text('hello')) },
    payer: { model: callsThenText('pay', { amt: 5 }), tools: { pay } },
    noter: { model: callsThenText('note', { n: 1 }), tools: { note } },
    broken: { model: model(async () => { throw new Error('model down'); }) },
    ward: { model: callsThenText('agent_medic', { task: 'dose' }), agents: ['medic'] },
    medic: { model: callsThenText('pay', { amt: 7 }), tools: { pay } },
    lead: { model: callsThenText('agent_scribe', { task: 'write' }), agents: ['scribe'] },
    scribe: { model: callsThenText('note', { n: 2 }), tools: { note } },
    hanger: { model: callsThenText('hang', {}), tools: { hang } },
  };
  return { agents, effects, hangStarted: started, unhang };
}

/** One gnl over `storage` (the root scope) and one over its organization. */
export function gnlsOf(m, storage) {
  const d = m.durable;
  const { agents, effects, hangStarted, unhang } = agentsOf(m);
  const memoryFactory = (s) => new m.AgentMemory({ storage: s });
  const root = d.createGnl({ storage, agents, memoryFactory });
  const org = () => d.createGnl(d.scopeConfigToOrg({ storage, agents, memoryFactory }, ORG).config);
  const run = async (g, agent, runId, who, threadId, extra = {}) => {
    try {
      const r = await g.run(agent, { runId, prompt: `go ${runId}`, caller: who ? d.user(who) : d.STAFF, ...(threadId ? { threadId } : {}), ...extra });
      return r.interrupts?.length ? 'suspended' : 'ok';
    } catch (e) {
      return `error:${e?.name}`;
    }
  };
  return { root, org, run, effects, hangStarted, unhang };
}

/**
 * Writes the history into `storage`; returns what each call answered and the effects in order.
 * `hooks.stop` is set to a function that lets the run left `running` finish (and waits for it).
 */
export async function writeRuns(m, storage, hooks = {}) {
  const d = m.durable;
  const { root, org, run, effects, hangStarted, unhang } = gnlsOf(m, storage);
  const out = {};
  out['r-done-alice'] = await run(root, 'plain', 'r-done-alice', 'alice', 't-alice-1');
  out['r-done-alice-b'] = await run(root, 'noter', 'r-done-alice-b', 'alice', 't-alice-1');
  out['r-susp-alice'] = await run(root, 'payer', 'r-susp-alice', 'alice', 't-alice-2');
  out['r-fail-bob'] = await run(root, 'broken', 'r-fail-bob', 'bob', 't-bob-1');
  out['r-cancel-bob'] = await run(root, 'payer', 'r-cancel-bob', 'bob', 't-bob-1');
  await d.cancelAgentRun(d.toJournal(storage.runs), 'r-cancel-bob', { reason: 'upgrade fixture' });
  out['r-sub-carol'] = await run(root, 'ward', 'r-sub-carol', 'carol', 't-carol-1');
  out['r-subdone-carol'] = await run(root, 'lead', 'r-subdone-carol', 'carol', 't-carol-2');
  out['r-staff'] = await run(root, 'noter', 'r-staff', null, null);
  out['r-erin-1'] = await run(root, 'plain', 'r-erin-1', 'erin', 't-erin-1');
  out['r-erin-2'] = await run(root, 'payer', 'r-erin-2', 'erin', 't-erin-1');
  out['r-approved-alice'] = await run(root, 'payer', 'r-approved-alice', 'alice', 't-alice-3');
  out['r-approved-alice:resume'] = await run(root, 'payer', 'r-approved-alice', 'alice', 't-alice-3', { approvals: { call_0: true } });
  out['erase-erin'] = await d.eraseSubject(storage, 'erin').then((r) => Object.keys(r).sort(), (e) => `error:${e?.message}`);
  // The last root run: its tool does not return, so it stays `running` (not awaited here).
  const hanging = run(root, 'hanger', 'r-hang-bob', 'bob', 't-bob-2');
  hooks.stop = async () => { unhang(); await hanging; };
  await hangStarted;

  await d.toJournal(storage.runs).put(d.ORG_RECORD_PRE + ORG, { id: ORG, createdAt: 1 });
  const acme = org();
  out['o-done-dave'] = await run(acme, 'plain', 'o-done-dave', 'dave', 't-dave-1');
  out['o-susp-dave'] = await run(acme, 'payer', 'o-susp-dave', 'dave', 't-dave-1');
  out['o-fail-frank'] = await run(acme, 'broken', 'o-fail-frank', 'frank', 't-frank-1');
  out['o-sub-frank'] = await run(acme, 'ward', 'o-sub-frank', 'frank', 't-frank-2');
  out['o-done-alice'] = await run(acme, 'plain', 'o-done-alice', 'alice', 't-alice-acme');
  out.effects = [...effects];
  return out;
}

/** After the upgrade: what a user does next — approve, approve twice, re-run finished runs, an intruder, a new run. */
export async function continueRuns(m, storage) {
  const d = m.durable;
  const { root, org, run, effects } = gnlsOf(m, storage);
  const acme = org();
  const out = {};
  out['approve r-susp-alice'] = await run(root, 'payer', 'r-susp-alice', 'alice', 't-alice-2', { approvals: { call_0: true } });
  out['approve r-susp-alice again'] = await run(root, 'payer', 'r-susp-alice', 'alice', 't-alice-2', { approvals: { call_0: true } });
  out['approve o-susp-dave'] = await run(acme, 'payer', 'o-susp-dave', 'dave', 't-dave-1', { approvals: { call_0: true } });
  out['rerun r-done-alice-b'] = await run(root, 'noter', 'r-done-alice-b', 'alice', 't-alice-1');
  out['rerun r-subdone-carol'] = await run(root, 'lead', 'r-subdone-carol', 'carol', 't-carol-2');
  out['resume r-cancel-bob'] = await run(root, 'payer', 'r-cancel-bob', 'bob', 't-bob-1', { approvals: { call_0: true } });
  out['mallory on t-alice-1'] = await run(root, 'plain', 'r-mallory', 'mallory', 't-alice-1');
  out['new run alice'] = await run(root, 'plain', 'r-new-alice', 'alice', 't-alice-new');
  out['bob on erased t-erin-1'] = await run(root, 'plain', 'r-bob-erin', 'bob', 't-erin-1');
  out.effects = [...effects];
  return out;
}

const safe = async (f) => {
  try {
    return await f();
  } catch (e) {
    return `ERR ${e?.name}: ${String(e?.message).slice(0, 90)}`;
  }
};

async function all(runs, q = {}) {
  const out = [];
  let cursor;
  do {
    const p = await runs.listRuns({ limit: 3, ...q, ...(cursor ? { cursor } : {}) });
    out.push(...p.items);
    cursor = p.nextCursor;
  } while (cursor);
  return out;
}
const ids = (xs) => xs.map((r) => r.runId).sort();
const sorted = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sorted(o[k])])) : o);

async function scope(m, storage, st, orgId) {
  const d = m.durable;
  const runs = st.runs;
  const journal = d.toJournal(runs);
  const memory = new m.AgentMemory({ storage: st });
  const res = {};
  const list = await safe(() => all(runs));
  res.runs = Array.isArray(list)
    ? Object.fromEntries(list.map((r) => [r.runId, { status: r.status, resourceId: r.resourceId ?? null, threadId: r.threadId ?? null, agent: r.agent ?? null, parentRunId: r.parentRunId ?? null }]))
    : list;
  res.byStatus = {};
  for (const s of STATUSES) res.byStatus[s] = await safe(async () => ids(await all(runs, { status: s })));
  res.open = await safe(async () => ids(await all(runs, { statuses: STATUSES.filter((s) => s !== 'completed') })));
  res.desc = await safe(async () => (await all(runs, { order: 'desc' })).length);
  res.topLevel = await safe(async () => ids(await all(runs, { topLevel: true })));
  res.count = await safe(() => runs.countRunsByStatus?.());
  res.countRuns = await safe(() => runs.countRuns?.());
  res.myRuns = {};
  res.subjectRuns = {};
  for (const s of SUBJECTS) {
    res.myRuns[s] = await safe(async () => ids(await all(runs, { resourceId: s })));
    res.subjectRuns[s] = await safe(async () => (await d.subjectRuns(storage, s, orgId ? { orgId } : {})).map((r) => `${r.runId}${r.inFlight ? '*' : ''}`).sort());
  }
  res.threadRuns = {};
  res.owner = {};
  for (const t of THREADS) {
    res.threadRuns[t] = await safe(async () => ids(await all(runs, { threadId: t })));
    res.owner[t] = await safe(async () => JSON.stringify(await d.threadOwnerOf(journal, memory, t)));
  }
  res.usage = await safe(async () => { const u = await d.getOrgUsage(journal, undefined, undefined, true); return { runs: u.runs, tokens: u.tokens }; });
  return sorted(res);
}

/**
 * Every answer the current code gives about the history, in the root scope and the organization's —
 * the run list and each status filter, counts, a person's runs, a thread's runs and owner, usage. The
 * thread gate is asked last, per thread and caller: it writes the owner record a first contact makes,
 * so it comes after every read.
 */
export async function probeRuns(m, storage) {
  const d = m.durable;
  const out = { root: await scope(m, storage, storage), [ORG]: await scope(m, storage, d.withOrgStorage(storage, ORG), ORG) };
  for (const [name, st, orgId] of [['root', storage, undefined], [ORG, d.withOrgStorage(storage, ORG), ORG]]) {
    const journal = d.toJournal(st.runs);
    const memory = new m.AgentMemory({ storage: st });
    const gate = {};
    for (const t of THREADS) {
      for (const s of ['alice', 'bob', 'dave', 'mallory']) {
        gate[`${t}|${s}`] = await safe(async () => { await d.admitThreadRun(journal, memory, t, d.user(s, orgId)); return 'admit'; });
      }
    }
    out[name].gate = gate;
  }
  return out;
}
