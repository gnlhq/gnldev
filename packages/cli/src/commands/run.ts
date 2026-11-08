// gnl run <runId> — a single run's timeline: messages/tool-calls/status (reconstructState) + cost.
// -raw shows the underlying journal entries instead (model/tool records, write order).
import type * as Durable from '@gnldev/durable';
import type { JournalEntry, ReconstructedState, RunCost, RunSummary } from '@gnldev/durable';
import type { Command } from './types.js';
import { flag, flagBool, positional } from '../args.js';
import { loadConfig } from '../config.js';
import type { GnlDevConfig } from '../config.js';
import { getJournal } from '../journal-util.js';
import { loadDurable, projectDirOf } from '../runtime.js';
import { bold, colorStatus, dim } from '../ansi.js';

export interface RunTimeline {
  summary: RunSummary;
  cost: RunCost;
  entries: JournalEntry[];
  state: ReconstructedState;
  /**
   * How a run with NO steps ended — present only then. A run that failed before its first model step (the
   * provider refused the first call) has no entries to show, but it is listed by `gnl runs`; this is what
   * its failure said, and the one thing worth opening it for.
   */
  outcome?: { status: string; error?: string; errorName?: string; errorStatus?: number };
}

/** Throws a clear "run not found" error if the runId has no trace in the journal. */
export async function getRunCore(config: GnlDevConfig, d: typeof Durable, runId: string): Promise<RunTimeline> {
  const journal = getJournal(config, d);
  const entries = await journal.readRun(runId);
  if (entries.length === 0) {
    // `runs` lists a run that is recorded without steps, so `run` opens it too — by its outcome.
    if (!(await d.isRunRecorded(journal, runId))) throw new Error(`run not found: '${runId}'`);
    const outcome = await d.readRunOutcome(journal, runId);
    const summary = d.summarizeRun(runId, entries, outcome as never);
    return { summary, cost: await d.getRunCost(journal, runId), entries, state: d.reconstructState(entries), ...(outcome ? { outcome } : {}) };
  }
  const summary = d.summarizeRun(runId, entries);
  const cost = await d.getRunCost(journal, runId);
  const state = d.reconstructState(entries);
  return { summary, cost, entries, state };
}

function fmtTs(ts?: number): string {
  return ts != null ? new Date(ts).toISOString() : '-';
}

function printMessage(m: any): void {
  if (m.role === 'assistant') {
    for (const part of m.content ?? []) {
      if (part.type === 'text' && part.text) console.log(`  ${bold('assistant')}  ${part.text}`);
      else if (part.type === 'tool-call') console.log(`  ${bold('assistant')}  → tool-call ${part.toolName}(${JSON.stringify(part.input)})  [${part.toolCallId}]`);
    }
  } else if (m.role === 'tool') {
    for (const part of m.content ?? []) {
      if (part.type === 'tool-result') console.log(`  ${bold('tool')}       ← ${JSON.stringify(part.output)}  [${part.toolCallId}]`);
    }
  } else {
    console.log(`  ${bold(m.role ?? 'message')}  ${JSON.stringify(m.content ?? m)}`);
  }
}

export const runCommand: Command = {
  name: 'run',
  group: 'inspect',
  summary: "Show a single run's timeline (messages, tool calls, cost)",
  usage: 'gnl run <runId> [--raw] [--json] [--config gnl.config.ts]',
  async run(ctx) {
    const runId = positional(ctx.argv, 0);
    if (!runId) throw new Error('runId required: gnl run <runId>');
    const raw = flagBool(ctx.argv, 'raw');
    const json = flagBool(ctx.argv, 'json');
    const configPath = flag(ctx.argv, 'config') ?? 'gnl.config.ts';

    const config = await loadConfig(configPath);
    const d = await loadDurable(projectDirOf(configPath));

    if (raw) {
      const journal = getJournal(config, d);
      const entries = await journal.readRun(runId);
      if (entries.length === 0 && !(await d.isRunRecorded(journal, runId))) throw new Error(`run not found: '${runId}'`);
      if (json) {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }
      for (const e of entries) {
        console.log(`${dim(fmtTs(e.ts))}  ${bold(e.kind)}  ${e.key}`);
        console.log(`  ${JSON.stringify(e.value)}`);
      }
      return;
    }

    const timeline = await getRunCore(config, d, runId);
    if (json) {
      console.log(JSON.stringify({ ...timeline.summary, cost: timeline.cost, messages: timeline.state.messages, pending: timeline.state.pending, ...(timeline.outcome ? { outcome: timeline.outcome } : {}) }, null, 2));
      return;
    }

    console.log(`${bold(runId)}  ${colorStatus(timeline.summary.status)}`);
    console.log(`  model steps: ${timeline.summary.modelSteps}   tool calls: ${timeline.summary.toolCalls}   cost: $${timeline.cost.costUsd.toFixed(4)} (${timeline.cost.totalTokens} tokens)`);
    if (timeline.summary.threadId) console.log(`  thread: ${timeline.summary.threadId}`);
    if (timeline.outcome?.error) {
      const o = timeline.outcome;
      console.log(`  ${o.status}: ${o.error}${o.errorName || o.errorStatus ? `  (${[o.errorName, o.errorStatus].filter(Boolean).join(', ')})` : ''}`);
    }
    console.log('');
    for (const m of timeline.state.messages) printMessage(m);
    if (timeline.state.pending.length > 0) {
      console.log('');
      console.log(dim(`  pending (awaiting result): ${timeline.state.pending.map((p) => `${p.toolName}[${p.toolCallId}]`).join(', ')}`));
    }
  },
};
