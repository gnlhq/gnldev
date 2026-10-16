// A BACKGROUND TOOL (types.ts `background: true`) — the pieces the registry puts together. Nothing here
// is a new kind of run, a new record family or a new rule: a background call is made of two ordinary
// agent runs, and every promise they keep is the engine's own.
//
//   parent turn ──(model calls the tool)──▶ launcher: start the TASK, answer { status:'started', taskId }
//        │                                    (an idempotent call: replayed or repeated, it starts nothing twice)
//        ▼ the turn goes on and ends
//   task:<parent>:<toolCallId>   a run whose "model" is this file's `taskModel`: it calls the one tool
//        │                       once and stops — so the body runs under the engine's tool record,
//        │                       claim, crash ladder and recover(), on the process's executor, taken
//        │                       over only from a dead process
//        ▼ its tool record is terminal: the task's ENDING (detached.ts `LaunchEnd`) wakes the agent —
//        │ done again by the next sweep if a store error or a drain interrupts it — when the continuation
//        │ holds the thread's turn and the thread has no live run (`takeThreadTurn`)
//   cont:<parent>:<toolCallId>   the agent's own run on the parent's thread, whose question is the
//                                result: written to the thread once (its batch identity), the model
//                                called once (its step record), started once (its id + the executor)
//
// Both derived runs are born to the parent's RECORDED owner through the engine's admission, in the
// parent's journal (its organization), with the parent recorded as theirs: the parent's erasure is
// theirs (erasure-fence.ts `lineage`), and the erasure model finds them from the parent's tool records
// (model.ts `RUN_DEPENDENTS.children`).
import { callOfRunId, runIdFamilyOf } from './run-id-grammar.js';
import { claim, listRunsWhere, asReaderJournal, runKeys, type Journal } from './journal.js';
import { readCallOutcome } from './call-outcome.js';
import { compareAndSet } from './attempt.js';
import { readRunOutcome } from './outcome.js';
import { isOrganizationKey } from './organization.js';
import { runErasedSince, RunErasedError, type ErasureBaseline } from './erasure-fence.js';
import { isDraining } from './process-liveness.js';
import { lastRunEvent, readRunEvents } from './run-events.js';

/** What a task executes — its frozen input (the task run's prompt), so a takeover executes the same call. */
export interface TaskSpec { gnlTask: 1; tool: string; parentRunId: string; toolCallId: string; requestRunId?: string; input: unknown }

export const encodeTaskSpec = (spec: TaskSpec): string => JSON.stringify(spec);

export function decodeTaskSpec(prompt: unknown): TaskSpec | undefined {
  if (typeof prompt !== 'string') return undefined;
  try {
    const v = JSON.parse(prompt) as TaskSpec;
    return v?.gnlTask === 1 && typeof v.tool === 'string' && typeof v.parentRunId === 'string' && typeof v.toolCallId === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

const usage = { inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 0, text: 0, reasoning: undefined } };

/**
 * The task's model: no provider, no tokens — a pure function of its prompt (the spec). Before the
 * tool's result it calls the tool, once, under the parent's toolCallId; after it, it stops. Its steps
 * are journaled like any model's, so a takeover replays them instead of asking again.
 */
export function taskModel(): unknown {
  const turn = (prompt: Array<{ role?: string; content?: unknown }>) => {
    const user = prompt.find((m) => m.role === 'user');
    const text = typeof user?.content === 'string' ? user.content
      : Array.isArray(user?.content) ? (user!.content as Array<{ type?: string; text?: string }>).map((p) => (p.type === 'text' ? p.text ?? '' : '')).join('') : '';
    const spec = decodeTaskSpec(text);
    if (!spec) throw new Error('@gnldev/durable: a background task without its spec');
    const answered = prompt.some((m) => m.role === 'tool');
    return answered
      ? { content: [] as unknown[], finishReason: { unified: 'stop', raw: 'stop' } }
      : { content: [{ type: 'tool-call', toolCallId: spec.toolCallId, toolName: spec.tool, input: JSON.stringify(spec.input ?? {}) }], finishReason: { unified: 'tool-calls', raw: 'tool-calls' } };
  };
  return {
    specificationVersion: 'v4', provider: 'gnl', modelId: 'background-task', supportedUrls: {},
    doGenerate: async ({ prompt }: { prompt: any[] }) => ({ ...turn(prompt), usage, warnings: [] }),
    doStream: async ({ prompt }: { prompt: any[] }) => {
      const t = turn(prompt);
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] });
            for (const part of t.content) c.enqueue(part);
            c.enqueue({ type: 'finish', finishReason: t.finishReason, usage });
            c.close();
          },
        }),
      };
    },
  };
}

/**
 * How a task ended — the one place it is decided. From its tool record; or, when its call has NO record
 * and its run has ended, from what the run's model was given for the call, as every reader of the run
 * reads it (its event log): the call's error (`tool-error` — the store refused its record, say), or the
 * run's own failure. That ending is what the agent is woken to hear, as any agent run's model hears its
 * call's error. Before this the ending threw ("not settled"), the next sweep executed the task again,
 * and so on every sweep for good (measured: 52 executions in 10 s, the agent never woken). A call that
 * may still be running elsewhere (its claim is there) is not decided here: the next execution meets the
 * crash ladder (recover(), a human), which bounds it.
 * `undefined`: not ended (running, or waiting on a human).
 */
export type TaskOutcome = { state: 'completed'; output: unknown } | { state: 'failed'; error: string } | { state: 'denied'; output: unknown };

export async function taskOutcome(journal: Journal, taskRunId: string, toolCallId: string): Promise<TaskOutcome | undefined> {
  // The call's records, read by their one reader (call-outcome.ts): its record and its late reports.
  const { record: rec, effect } = await readCallOutcome(journal, runKeys.tool(taskRunId, toolCallId));
  if (rec?.status === 'succeeded') return { state: 'completed', output: rec.output };
  // Not executed: refused by a person, or answered by a "reconsider" nudge instead.
  if (rec?.status === 'denied' || rec?.status === 'reflected') return { state: 'denied', output: rec.output };
  // A failure beside a late report: an attempt that lost the call ran it — the effect happened, with
  // that result. (A claim beside one is not decided here: its attempt settles its own record.)
  if (rec?.status === 'failed') return effect.state === 'happened' ? { state: 'completed', output: effect.output } : { state: 'failed', error: rec.error };
  if (rec === undefined) {
    const last = await lastRunEvent(journal, taskRunId);
    const ending = last?.kind === 'status' ? (last.data as { state?: string; error?: { message?: string } }) : undefined;
    if (ending?.state !== 'completed' && ending?.state !== 'failed') return undefined;
    const callError = (await readRunEvents(journal, taskRunId, 0))
      .filter((e) => e.kind === 'tool-error' && (e.data as { toolCallId?: string }).toolCallId === toolCallId)
      .map((e) => (e.data as { error?: { message?: string } }).error?.message)
      .pop();
    return { state: 'failed', error: callError ?? ending.error?.message ?? 'the task ended before its call ran' };
  }
  return undefined;
}

/** The continuation's question: the task's result, the same text every time it is read. */
export function continuationPrompt(taskRunId: string, toolName: string, outcome: TaskOutcome): string {
  const body = outcome.state === 'failed' ? { error: outcome.error } : { output: outcome.output };
  return `Background task ${taskRunId} (${toolName}) ${outcome.state}: ${JSON.stringify(body)}`;
}


/** Who holds a thread's turn for a continuation (`runKeys.threadTurn`): the continuation, and the run that made it. */
interface ThreadTurn { runId: string; parentRunId: string; at: number }

/**
 * ONE WRITER AT A TIME ON A THREAD, for the writer a background tool adds: a continuation is born only
 * while it HOLDS the thread's turn and no other run of the thread executes (a turn the user started
 * meanwhile, or the parent turn still answering) — else it would answer from a history without that
 * turn, and its question and answer would land inside it.
 *
 * The turn is one record of the thread (`xthr:<thread>:turn`, deleted with the thread), taken by a
 * compare-and-set: two wakes that look at a quiet thread together cannot both be born — the second one
 * finds the first holding the turn (measured: without it, two tasks ending on one tick answered at once).
 * The holder keeps it until its run is over or waits on a human; nothing releases it by hand, so a holder
 * whose process dies keeps it while its run is continued elsewhere. A holder that was erased frees it.
 *
 * Waits; stops when the waiting task (or its parent) is erased, and when the process drains (the task is
 * released, and ended — and waits again — elsewhere).
 *
 * The user's own turns keep their rule (concurrent turns land in send order, answers in completion
 * order): gating every turn behind a background answer would make the person wait for it.
 */
export async function takeThreadTurn(
  journal: Journal,
  threadId: string,
  me: { runId: string; parentRunId: string; waiting: string; baseline: ErasureBaseline },
  executing: (runIds: string[]) => Promise<boolean>,
  opts: { pollMs: number; signal?: AbortSignal },
): Promise<void> {
  const key = runKeys.threadTurn(threadId);
  for (;; await new Promise((r) => setTimeout(r, opts.pollMs))) {
    if (await runErasedSince(journal, me.waiting, me.baseline)) throw new RunErasedError(me.waiting);
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted');
    if (isDraining()) throw new Error(`@gnldev/durable: '${me.waiting}' released by a draining process before it woke its agent`);
    const held = await journal.get<ThreadTurn>(key);
    if (held?.runId !== me.runId) {
      if (held && !(await turnIsFree(journal, held, executing))) continue;
      const mine: ThreadTurn = { runId: me.runId, parentRunId: me.parentRunId, at: Date.now() };
      if (!(held ? await compareAndSet(journal, key, held, mine) : await claim(journal, key, mine))) continue;
    }
    const runs = ((await listRunsWhere(asReaderJournal(journal), { threadId })) ?? [])
      .map((r) => r.runId)
      .filter((id) => id !== me.runId && runIdFamilyOf(id) !== 'task' && !isOrganizationKey(id));
    if (!(await executing(runs))) return;
  }
}

/** A turn's holder is done with it: its run is over or waits on a human (not executing, and started), or it was erased. */
async function turnIsFree(journal: Journal, held: ThreadTurn, executing: (runIds: string[]) => Promise<boolean>): Promise<boolean> {
  if (await runErasedSince(journal, held.runId, { lineage: [held.parentRunId] })) return true;
  if (await executing([held.runId])) return false;
  // Not executing and never started: decided, not yet born — the window the turn exists for.
  return (await readRunOutcome(journal, held.runId)) !== undefined;
}

/** The toolCallId a derived run was made for, read from its id with its parent known (`cont:<parent>:<toolCallId>`). */
export function toolCallIdOf(derivedRunId: string, prefix: 'task' | 'cont', parentRunId: string): string | undefined {
  return callOfRunId(derivedRunId, prefix, parentRunId);
}
