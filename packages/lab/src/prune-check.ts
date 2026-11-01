// "Would removing this section change what the agent does?" — answered on new messages, beside the
// noise of asking the same thing twice and beside a section known to matter.
//
// A low share in explainRun makes a section a candidate, not a recommendation. Here the agent runs on
// prompts it was not explained on, with its full prompt twice (the noise floor: measured, 0.24 with 5
// runs per prompt and 0.098 with 45), without the section, and — when a control is named — without a
// section that should matter. The outcome of a run is the tools it called, in order. The removal is
// called harmless when it moves behaviour by no more than the noise plus `margin`.
//
// Every tool here RUNS: give it fakes. (explainRun replays and never runs a tool; this cannot, because
// the prompts are new and have no recording.)
import { generateText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { refuseUnknownNames } from '@gnldev/options';
import { runTrials, distribution, tvd, type RunTrialsOptions } from '@gnldev/experiment';
import { PRUNE_CHECK_NAMES } from './option-names.js';

export interface PruneCheckOptions {
  model: LanguageModel;
  /** Run for real on every trial: fakes only. */
  tools: ToolSet;
  /** The system prompt as named sections, in order. */
  systemSections: Record<string, string>;
  /** Text every system prompt starts with. */
  systemBase?: string;
  /** Messages before each prompt. */
  history?: readonly ModelMessage[];
  /** New user messages the check runs on. */
  prompts: readonly string[];
  /** The section to remove. */
  remove: string;
  /** A section that should matter, removed in a separate arm to show the check can tell. */
  control?: string;
  /** Runs per prompt and arm (default 45 — the number that brought the noise floor near 0.1). */
  trials?: number;
  /** How far above the noise a harmless removal may move behaviour (default 0.1). */
  margin?: number;
  maxSteps?: number;
  concurrency?: number;
  /** Called as the runs finish: `done` of `total` (arms × prompts × trials) and the failures so far. */
  onProgress?: RunTrialsOptions['onProgress'];
  /** Aborted: no further run starts and checkPrune throws the abort reason. */
  signal?: AbortSignal;
  /** How a provider's refusals (429) slow the runs down — as runTrials. */
  throttle?: RunTrialsOptions['throttle'];
}

export interface PruneArm {
  /** Mean over prompts of the distance from the full prompt's behaviour. */
  distance: number;
  perPrompt: Array<{ prompt: string; distance: number }>;
}

export interface PruneCheckResult {
  /** The full prompt against itself — what two runs of the same thing differ by. */
  noise: number;
  removed: PruneArm;
  control?: PruneArm;
  /** removed.distance ≤ noise + margin. */
  harmless: boolean;
  /** control.distance > noise + margin: the check told a section that matters apart. */
  controlSeparates?: boolean;
  runs: number;
  failed: number;
  /** What the runs that finished took. */
  inputTokens: number;
  outputTokens: number;
}

export async function checkPrune(opts: PruneCheckOptions): Promise<PruneCheckResult> {
  refuseUnknownNames('checkPrune', opts, PRUNE_CHECK_NAMES);
  for (const s of [opts.remove, ...(opts.control !== undefined ? [opts.control] : [])]) {
    if (!(s in opts.systemSections)) throw new TypeError(`@gnldev/lab: checkPrune: '${s}' is not one of the systemSections`);
  }
  const trials = opts.trials ?? 45;
  const system = (without?: string) => [opts.systemBase, ...Object.entries(opts.systemSections).filter(([k]) => k !== without).map(([, t]) => t)].filter((x) => x !== undefined).join('\n\n');
  const arms: Record<string, string> = { full: system(), again: system(), removed: system(opts.remove), ...(opts.control !== undefined ? { control: system(opts.control) } : {}) };
  const jobs: Array<{ arm: string; prompt: string; run: () => Promise<string> }> = [];
  let inputTokens = 0, outputTokens = 0;
  for (const [arm, sys] of Object.entries(arms)) for (const prompt of opts.prompts) for (let t = 0; t < trials; t++) {
    jobs.push({ arm, prompt, run: async () => {
      const r = await generateText({ model: opts.model, tools: opts.tools, system: sys, stopWhen: stepCountIs(opts.maxSteps ?? 6), messages: [...(opts.history ?? []), { role: 'user', content: prompt }] });
      inputTokens += r.totalUsage.inputTokens ?? 0; outputTokens += r.totalUsage.outputTokens ?? 0;
      return r.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)).join('>') || '(none)';
    } });
  }
  const done = await runTrials(jobs.map((j) => j.run), {
    concurrency: opts.concurrency ?? 4,
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}), ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.throttle ? { throttle: opts.throttle } : {}),
  });
  opts.signal?.throwIfAborted();
  const seqs = (arm: string, prompt: string) => done.outcomes.flatMap((o, i) => (o.ok && jobs[i]!.arm === arm && jobs[i]!.prompt === prompt ? [o.value] : []));
  const against = (arm: string): PruneArm => {
    const perPrompt = opts.prompts.map((prompt) => ({ prompt, distance: tvd(distribution(seqs('full', prompt)), distribution(seqs(arm, prompt))) }));
    return { distance: perPrompt.reduce((a, p) => a + p.distance, 0) / perPrompt.length, perPrompt };
  };
  const noise = against('again').distance;
  const removed = against('removed');
  const margin = opts.margin ?? 0.1;
  const control = opts.control !== undefined ? against('control') : undefined;
  return {
    noise, removed, harmless: removed.distance <= noise + margin,
    ...(control ? { control, controlSeparates: control.distance > noise + margin } : {}),
    runs: jobs.length, failed: done.failed, inputTokens, outputTokens,
  };
}
