// A 0.9.0 process in a rolling deploy: one action, with the 0.9.0 code from GNL_090_ROOT, on the SQLite
// file the test shares with the current code. Prints one JSON line: { ok: true, value } or
// { ok: false, error }. Spawned by rolling.test.ts; a child process, so the two versions never share
// a module cache.
//
//   node run-0.9.0.mjs <action> <db file> [arg]
import { loader090 } from '../../generate/load-0.9.0.mjs';
import * as S from '../../generate/shapes.mjs';

const [action, file, arg] = process.argv.slice(2);
const load = loader090(process.env.GNL_090_ROOT);
const durable = await load('durable');
const { SqliteStorage } = await load('durable', 'sqlite-storage.js');
const s = new SqliteStorage(file);
const j = durable.toJournal(s.runs);
const ran = [];

const actions = {
  /** 0.9.0's enqueue, `arg` jobs `old0..`: written with 0.9.0's INSERT, unnumbered. */
  async enqueue() {
    const q = await load('queue');
    for (let i = 0; i < Number(arg); i++) await q.enqueue(s.work, 'plain', { n: `old${i}` }, { id: `old${i}` });
  },
  async emit() {
    const ev = await load('events');
    for (let i = 0; i < Number(arg); i++) await ev.emit(s.work, S.EVENTS.topic, { n: `old${i}` }, { id: `old${i}` });
  },
  /** 0.9.0's worker, drained; returns what it ran. */
  async drain() {
    const q = await load('queue');
    await q.createWorker(s, { plain: async (p) => { ran.push(p.n); } }, { maxAttempts: 2, heartbeat: false }).drain();
    return ran;
  },
  async poll() {
    const ev = await load('events');
    await ev.createConsumer(s.work, S.EVENTS.topic, async (p) => { ran.push(p.n); }, { name: S.EVENTS.consumer }).poll();
    return ran;
  },
  /** 0.9.0's BasicMemory reading a thread the current code appended to. */
  async basicRead() {
    return new durable.BasicMemory(j).getMessages(arg);
  },
  /** A 0.9.0 agent turn on a BasicMemory thread the current code wrote. */
  async basicRun() {
    const { echoModel } = await load('durable', 'mock-model.js');
    const r = await durable.runDurable({ runId: `r090-${arg}`, journal: j, model: echoModel(), prompt: 'turn from 0.9.0', memory: new durable.BasicMemory(j), threadId: arg });
    return r.text;
  },
  async semanticRun() {
    const rag = await load('rag');
    const { echoModel } = await load('durable', 'mock-model.js');
    const r = await durable.runDurable({ runId: `r090s-${arg}`, journal: j, model: echoModel(), prompt: 'turn from 0.9.0', memory: new rag.SemanticMemory({ journal: j, embed: S.fixtureEmbed }), threadId: arg });
    return r.text;
  },
  /** 0.9.0 resuming a run whose step after a void step crashed on the current code; returns what that step received. */
  async voidThenUse() {
    const w = await load('workflow');
    return S.voidThenUseWorkflow(w, ran, { crash: false }).run(1, { runId: arg, journal: j });
  },
};

let out;
try {
  out = { ok: true, value: (await actions[action]()) ?? null };
} catch (e) {
  out = { ok: false, error: `${e?.name ?? 'Error'}: ${e?.message ?? e}` };
}
await s.close();
process.stdout.write(`${JSON.stringify(out)}\n`);
