// What was tried, kept: one record per replay, and a report that reads them.
//
// The optimizer changes nothing in an agent. It reports what it found, what was tried and what held,
// and a person decides. So a replay is worth keeping: "lightning-30b diverged in 8% of runs last week,
// 3% this week" is a trend nobody sees if each result is gone when the page closes.
//
// Records live in the journal under `__optimizer__:exp:<agent>:` (an adoptable reserved prefix — see
// ADOPTABLE_RESERVED_PREFIXES in @gnldev/durable), written through whatever journal the caller holds:
// through Studio that is the caller's organization-scoped view, so an organization's history is its
// own. A record holds run ids, calls and numbers — no conversation text.
import type { Journal, JournalReader } from '@gnldev/durable';
import type { AgentDiagnosis } from './diagnose.js';
import type { ReplayAgentResult, ReplayAgentSummary } from './replay-agent.js';
import { refuseUnknownNames } from '@gnldev/options';
import { SAVE_EXPERIMENT_NAMES, LIST_EXPERIMENTS_NAMES, RENDER_REPORT_NAMES } from './option-names.js';

export const EXPERIMENT_PREFIX = '__optimizer__:exp:';

export interface ExperimentRecord {
  v: 1;
  /** Epoch ms. */
  at: number;
  agent: string;
  /** The candidate model, by the name it was offered under. */
  model: string;
  limit: number;
  keepLast?: number;
  summary: ReplayAgentSummary;
  runs: Array<{ runId: string; divergedAt?: number; divergedOn?: string; missed: number; reordered: boolean }>;
  errors: Array<{ runId: string; error: string }>;
}

const keyOf = (agent: string, at: number) =>
  `${EXPERIMENT_PREFIX}${encodeURIComponent(agent)}:${String(at).padStart(15, '0')}-${Math.random().toString(36).slice(2, 8)}`;

/** Keeps a replay's outcome. Returns the record, or undefined when the journal cannot be written. */
export async function saveExperiment(
  journal: Partial<Pick<Journal, 'put'>>,
  e: { agent: string; model: string; limit: number; keepLast?: number; result: ReplayAgentResult; at?: number },
): Promise<ExperimentRecord | undefined> {
  refuseUnknownNames('saveExperiment', e, SAVE_EXPERIMENT_NAMES);
  if (typeof journal.put !== 'function') return undefined;
  const at = e.at ?? Date.now();
  const record: ExperimentRecord = {
    v: 1, at, agent: e.agent, model: e.model, limit: e.limit, ...(e.keepLast !== undefined ? { keepLast: e.keepLast } : {}),
    summary: e.result.summary,
    runs: e.result.runs.map((r) => ({
      runId: r.runId,
      ...(r.divergence ? { divergedAt: r.divergence.at, divergedOn: r.divergence.call.toolName } : {}),
      missed: r.missed.length,
      reordered: r.reordered,
    })),
    errors: e.result.errors,
  };
  await journal.put(keyOf(e.agent, at), record);
  return record;
}

export interface ListExperimentsOptions {
  /** Where they were kept. */
  journal: Partial<Pick<Journal, 'get' | 'listKeys'>> & Partial<JournalReader>;
  agent: string;
  /** At most this many, newest first (default 20). */
  limit?: number;
}

/** An agent's kept replays, newest first. */
export async function listExperiments(opts: ListExperimentsOptions): Promise<ExperimentRecord[]> {
  refuseUnknownNames('listExperiments', opts, LIST_EXPERIMENTS_NAMES);
  const { journal, agent, limit = 20 } = opts;
  if (typeof journal.listKeys !== 'function' || typeof journal.get !== 'function') return [];
  const keys = (await journal.listKeys(`${EXPERIMENT_PREFIX}${encodeURIComponent(agent)}:`)).sort().reverse().slice(0, limit);
  const out: ExperimentRecord[] = [];
  for (const k of keys) {
    const r = await journal.get<ExperimentRecord>(k);
    if (r && r.v === 1) out.push(r);
  }
  return out;
}

const pct = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${Math.round(v * 100)}%`);
const usd = (v: number) => (v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`);

/**
 * A Markdown report for one agent: where its money goes, the findings, the replays kept, and what held
 * up. It recommends; it changes nothing.
 */
export function renderReport(input: { agent: string; diagnosis: AgentDiagnosis; experiments: readonly ExperimentRecord[]; generatedAt?: number }): string {
  refuseUnknownNames('renderReport', input, RENDER_REPORT_NAMES);
  const { agent, diagnosis: d, experiments } = input;
  const at = new Date(input.generatedAt ?? Date.now()).toISOString().slice(0, 16).replace('T', ' ');
  const priced = d.costUsd > 0;
  const L: string[] = [];
  L.push(`# Cost report — ${agent}`, '', `Generated ${at} UTC from the agent's own journal. This report changes nothing; it says what was found, what was tried and what held.`, '');
  L.push('## Where the money goes', '');
  L.push('| | |', '|---|---|');
  L.push(`| Runs read | ${d.runs} (${d.modelSteps} model steps) |`);
  L.push(`| Cost | ${priced ? usd(d.costUsd) : 'unpriced — the model is not in the price table'} |`);
  L.push(`| Input tokens | ${d.inputTokens.toLocaleString('en-US')} (read from cache: ${d.cachedTokens.toLocaleString('en-US')}) |`);
  L.push(`| Opening re-sent on later steps | ${pct(d.repeatedPrefix.share)} of input (median opening ${d.repeatedPrefix.medianOpening} tokens) |`);
  L.push(`| Tool output older than ${d.oldToolOutput.keepLast} steps (estimated) | ${pct(d.oldToolOutput.share)} of input |`);
  for (const [model, m] of Object.entries(d.byModel)) L.push(`| ${model} | ${m.steps} steps${priced ? `, ${usd(m.costUsd)}` : ''} |`);
  L.push('');
  L.push('## Findings', '');
  if (d.findings.length === 0) L.push('Nothing to change on these runs.', '');
  for (const f of d.findings) {
    const saving = f.estimatedSavingUsd !== undefined ? `saves about ${usd(f.estimatedSavingUsd)} on these runs` : `${f.tokens.toLocaleString('en-US')} tokens on these runs`;
    L.push(`- **${f.lever === 'cache' ? 'Prompt cache' : 'Leave old tool output out'}** — ${saving}${f.needsReplay ? ' (try it with a replay before adopting it)' : ''}. ${f.why}`);
  }
  if (d.findings.length) L.push('');
  if (d.notes.length) {
    L.push('Seen, and not a finding:', '');
    for (const n of d.notes) L.push(`- ${n}`);
    L.push('');
  }
  L.push('## Replays tried', '');
  if (experiments.length === 0) {
    L.push('None yet. A replay plays the agent\'s latest runs again with a candidate model, answering every tool call from the recording; no tool runs.', '');
  } else {
    L.push('| When (UTC) | Candidate | Runs | Did different work | Skipped a call | Cost vs recorded |', '|---|---|---|---|---|---|');
    for (const e of experiments) {
      const s = e.summary;
      const cost = s.priced ? pct(s.costRatio) : `${s.candidateTokens.toLocaleString('en-US')} vs ${s.recordedTokens.toLocaleString('en-US')} tokens`;
      L.push(`| ${new Date(e.at).toISOString().slice(0, 16).replace('T', ' ')} | ${e.model}${e.keepLast !== undefined ? ` + old output left out after ${e.keepLast} steps` : ''} | ${s.replayed}${e.errors.length ? ` (+${e.errors.length} not replayed)` : ''} | ${s.diverged} (${pct(s.divergenceRate)}) | ${s.missedCallRuns} | ${cost} |`);
    }
    L.push('');
  }
  L.push('## Recommendation', '');
  const clean = experiments.filter((e) => e.summary.replayed > 0 && e.summary.diverged === 0 && e.summary.missedCallRuns === 0);
  if (clean.length === 0) {
    L.push(experiments.length === 0
      ? 'Run a replay with a cheaper model before changing anything.'
      : 'No candidate has yet done the same work on every replayed run. Keep the current setting, or replay more runs with another candidate.', '');
  } else {
    const best = clean.slice().sort((a, b) => (a.summary.priced && b.summary.priced ? a.summary.costRatio - b.summary.costRatio : a.summary.candidateTokens - b.summary.candidateTokens))[0]!;
    const replayed = clean.filter((e) => e.model === best.model).reduce((n, e) => n + e.summary.replayed, 0);
    L.push(`**${best.model}** did the same work as the recorded runs in every one of ${replayed} replayed run${replayed === 1 ? '' : 's'}${best.summary.priced ? `, at ${pct(best.summary.costRatio)} of the recorded cost` : ''}.`);
    L.push('', 'If you adopt it, change the agent\'s model in your code, so the change is reviewed and tested like any other; runs already started keep the model they began with.', '');
  }
  return L.join('\n');
}
