// What the 0.9.0 fixtures were written with, shared by the generator (which runs it against 0.9.0)
// and the tests (which run it against the current code). A test that rebuilds a workflow, a model or
// a document set must rebuild exactly what wrote the fixture, so both sides import it from here.
//
// Nothing in this file imports GNL: each factory takes the module it builds from, so the same shape is
// built from @gnldev/workflow 0.9.0 in the generator and from the workspace build in the tests.

/** Deterministic 3-number embedding: same text, same vector, on every machine. */
export async function fixtureEmbed(text) {
  let a = 0;
  let b = 0;
  let c = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0) ?? 0;
    a += code % 7;
    b += code % 11;
    c += 1;
  }
  return c === 0 ? [0, 0, 1] : [a / c, b / c, 1];
}

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const toolResultsIn = (prompt) => (prompt ?? []).filter((m) => m.role === 'tool').length;

/** A model that always answers `text`. */
export function textModel(text, calls = { n: 0 }) {
  return {
    specificationVersion: 'v2',
    provider: 'fixture',
    modelId: 'text',
    supportedUrls: {},
    doGenerate: async () => {
      calls.n++;
      return { content: [{ type: 'text', text }], finishReason: 'stop', usage, warnings: [] };
    },
    doStream: async () => {
      throw new Error('fixture model does not stream');
    },
  };
}

/**
 * First turn: calls `toolName` with `input`. Once a tool result is in the prompt: throws while
 * `state.crash` is set (the outage that leaves the run unfinished), otherwise answers `doneText`.
 */
export function toolThenTextModel({ toolName, input = {}, doneText = 'done', state = { crash: false } }) {
  return {
    specificationVersion: 'v2',
    provider: 'fixture',
    modelId: 'tool-then-text',
    supportedUrls: {},
    doGenerate: async ({ prompt }) => {
      if (toolResultsIn(prompt) === 0) {
        return {
          content: [{ type: 'tool-call', toolCallId: 'call-1', toolName, input: JSON.stringify(input) }],
          finishReason: 'tool-calls',
          usage,
          warnings: [],
        };
      }
      if (state.crash) throw new Error('downstream outage (fixture)');
      return { content: [{ type: 'text', text: doneText }], finishReason: 'stop', usage, warnings: [] };
    },
    doStream: async () => {
      throw new Error('fixture model does not stream');
    },
  };
}

// ── queue ───────────────────────────────────────────────────────────────────────────────────────────
export const QUEUE = {
  /** Owned jobs of the person who is erased after the upgrade; all finished on 0.9.0. */
  ayseJobs: 40,
  /** System jobs p000..p079; the first `plainDoneOn090` ran on 0.9.0. 0.9.0 persists its row-offset
   *  cursor after a full page (50) of finished jobs, so 40 + 30 leaves `qcursor` = "50" behind. */
  plainJobs: 80,
  plainDoneOn090: 30,
  /** Owned jobs of another person, enqueued after 0.9.0's cursor; none ran on 0.9.0. */
  carolJobs: 3,
};
/** Dead letters: `pay` jobs whose charge landed before an outage. */
export const DEAD = { owner: 'dora', ids: ['dl1', 'dl2'], toolName: 'charge' };

// ── events ──────────────────────────────────────────────────────────────────────────────────────────
export const EVENTS = {
  topic: 'orders',
  consumer: 'c1',
  /** ayse's events, delivered on 0.9.0. */
  ayseEvents: 30,
  /** e000..e039 delivered on 0.9.0 (with ayse's 30, more than one 50-record page, so the consumer
   *  persisted a row-offset cursor); e040..e042 emitted after the consumer's last poll. */
  deliveredOn090: 40,
  pendingAfter: 3,
  /** carol's events, emitted after the last poll. */
  carolPending: 2,
  poisonTopic: 'poison',
  poisonConsumer: 'c2',
  poisonId: 'px',
};

// ── workflow ────────────────────────────────────────────────────────────────────────────────────────
/** notify (returns nothing) → notifySE (returns nothing, sideEffect) → wait 'approve' → final. */
export function voidWorkflow(w, calls) {
  return w
    .workflow()
    .then(w.step('notify', async () => { calls.push('notify'); }))
    .then(w.step('notifySE', async () => { calls.push('notifySE'); }, { sideEffect: true }))
    .then(w.waitForResume('approve'))
    .then(w.step('final', async (v) => { calls.push('final'); return { approved: v }; }));
}
/** A nested workflow as a step: pay = check (sideEffect) → charge (returns nothing, sideEffect); then wait 'ship' → final. */
export function nestedWorkflow(w, calls) {
  const pay = w
    .workflow()
    .then(w.step('check', async (n) => { calls.push('pay:check'); return { amount: n * 10 }; }, { sideEffect: true }))
    .then(w.step('charge', async () => { calls.push('pay:charge'); }, { sideEffect: true }));
  return w
    .workflow()
    .then(w.asStep('pay', pay))
    .then(w.waitForResume('ship'))
    .then(w.step('final', async (v) => { calls.push('final'); return { shipped: v }; }));
}
export const WORKFLOW_RUNS = { void: 'wf-void', nested: 'wf-nested' };
/** maybe (returns nothing) → use (reports what it received; throws while `state.crash`). */
export function voidThenUseWorkflow(w, calls, state = { crash: false }) {
  return w
    .workflow()
    .then(w.step('maybe', async () => { calls.push('maybe'); }))
    .then(w.step('use', async (v) => {
      calls.push('use');
      if (state.crash) throw new Error('process crashed (fixture)');
      return { receivedUndefined: v === undefined, received: v === undefined ? null : v };
    }));
}

// ── scheduler ───────────────────────────────────────────────────────────────────────────────────────
/** 2026-01-01T00:00:00Z: a non-leap year, the scheduler's own clock (it takes `now` as an argument). */
export const SCHED_T0 = Date.UTC(2026, 0, 1);
export const SCHEDULES = [
  { id: 'ok', every: 1000, name: 'w-ok' },
  { id: 'bad', cron: '0 25 * * *', name: 'w-bad' },
  { id: 'zero', every: 0, name: 'w-zero' },
  { id: 'ma0', every: 1000, maxAttempts: 0, name: 'w-ma0' },
  { id: 'two', at: SCHED_T0 + 500, every: 1000, name: 'w-two' },
  { id: 'leap', cron: '0 0 29 2 *', name: 'w-leap' },
];

// ── memory ──────────────────────────────────────────────────────────────────────────────────────────
/** Every string the erased person (u1) wrote carries this marker, so a test can scan the whole file for leftovers. */
export const U1_MARK = 'SECRET-U1';
export const MEMORY = {
  rootThread: 't-root',
  orgId: 'acme',
  orgThread: 't-acme',
  /** Root threads 0.9.0 let a caller name with the organization prefix. */
  orgPrefixedRootThreads: ['org:123', 'org:legacy:notes'],
  /**
   * acme's own threads that a 0.9.0 ROOT request named by their physical id (`org:acme:<t>`). The gate
   * refused it, and BACKFILLED a root owner record from the store's resourceId on the way
   * (`thread:org:acme:<t>:owner = { resourceId: 'u1', backfilled: true }`). `orgRunThread` also has
   * acme's own record (a run of acme's wrote it); `orgMemThread` was written by a memory alone.
   */
  orgRunThread: 't-run',
  orgMemThread: 't-cont',
  /** The root caller of that request. */
  intruder: 'intruder',
  otherUserThread: 't-u2',
  wmThread: 't-wm',
  omThread: 't-om',
  basicThread: 'th-basic',
  basicOldThread: 'b-old',
  semanticThread: 'th-sem',
  semanticOldThread: 's-old',
  /** 2025-01-01: old enough for any retention window measured from the fixture's day. */
  oldTs: Date.UTC(2025, 0, 1),
};

// ── rag ─────────────────────────────────────────────────────────────────────────────────────────────
const paragraphs = (tag, n) => Array.from({ length: n }, (_, i) => `${tag} paragraph ${i} carries enough words to fill a chunk.`).join('\n\n');
export const RAG_CHUNK = { size: 120, overlap: 0 };
/** Chunked with `chunkDocuments`, in this order. `x#1` comes after `x` and overwrote x's chunk 1 on 0.9.0. */
export const RAG_DOCS = [
  { id: 'multi', text: paragraphs('multi', 6) },
  { id: 'single', text: 'one short chunk', metadata: { source: 'confluence', team: 'a' } },
  { id: 'a#b', text: paragraphs('hash', 4) },
  { id: '50%off', text: paragraphs('pct', 4) },
  { id: 'solo#x', text: 'one chunk, hash in id' },
  { id: 'solo%', text: 'one chunk, percent in id' },
  { id: 'q%23x', text: 'one chunk, an id that looks escaped' },
  { id: 'café-ü', text: paragraphs('unicode', 3) },
  { id: 'labelled', text: paragraphs('labelled', 3), metadata: { source: 'wiki', chunk: 'user-chunk-label' } },
  { id: 'x', text: paragraphs('x', 4) },
  { id: 'x#1', text: 'the separate document called x#1' },
];
/** Indexed WITHOUT chunking: a record the user labelled `source: 'handbook'` (not a document called handbook). */
export const RAG_RAW = [{ id: 'h1', text: 'handbook page', metadata: { source: 'handbook' } }];

// ── evals ───────────────────────────────────────────────────────────────────────────────────────────
export const EVAL = { runId: 'run-e', prompt: 'What is the capital of France?', judgeText: 'SCORE: 0.9' };

// ── pii ─────────────────────────────────────────────────────────────────────────────────────────────
export const PII = {
  runId: 'run-pii',
  resourceId: 'ayse',
  email: 'ayse@example.com',
  toolName: 'lookup',
  toolResult: { email: 'ayse@example.com', createdAt: 1727712000000 },
};
