// "Which parts does a new agent need?" — before it has a single run of its own.
//
// An agent is described as components: each changes a scenario (adds a prompt section, offers a tool,
// takes one away). Every subset of components is a form of the agent; each form runs the scenario set
// `trials` times (fake tools, expectations a program checks — @gnldev/experiment's suite) and is scored
// by its pass rate and what it cost. Since every form was measured, the table is the answer: the
// cheapest form that passes as well as the best one — or, when no form passes anything, none at all. Each component's share of the pass rate is its
// Shapley value over the forms.
//
// It picks nothing for you and deploys nothing: the result is a list of components to write into the
// agent's code.
import type { LanguageModel } from 'ai';
import type { ModelPricing } from '@gnldev/durable';
import { refuseUnknownNames } from '@gnldev/options';
import { runSuite, coalitions, coalitionKey, shapley, wilson, classifyFailure, pause, reportRetriesTo, ProviderStoppedError, type Interval, type Scenario, type ScenarioTool, type TrialsProgress } from '@gnldev/experiment';
import { BEST_FORM_NAMES } from './option-names.js';

/** A part of an agent: what it changes in a scenario. */
export interface Component {
  apply: (scenario: Scenario) => Scenario;
}

/** A section appended to the system prompt. */
export function promptSection(text: string): Component {
  return { apply: (s) => ({ ...s, system: s.system ? `${s.system}\n\n${text}` : text }) };
}

/** A tool offered in every scenario (a fake: it is run). */
export function withTool(name: string, t: ScenarioTool): Component {
  return { apply: (s) => ({ ...s, tools: { ...s.tools, [name]: t } }) };
}

/** A tool the scenarios offer, taken away. */
export function withoutTool(name: string): Component {
  return { apply: (s) => { const { [name]: _, ...rest } = s.tools; return { ...s, tools: rest }; } };
}

export interface BestFormOptions {
  model: LanguageModel;
  scenarios: readonly Scenario[];
  /** The parts under test, by name (at most 12); applied in this order. */
  components: Record<string, Component>;
  /** The system prompt every form starts from (default: each scenario's own). */
  baseSystem?: string;
  /** Runs of the scenario set per form (default 3). */
  trials?: number;
  /** The pass rate a form must reach to be chosen (default: the best pass rate measured). */
  target?: number;
  pricing?: Record<string, ModelPricing>;
  maxSteps?: number;
  concurrency?: number;
  timeoutMs?: number;
  /** Called after every run of the scenario set: `done` of `total` (forms × trials) and the failures so far. */
  onProgress?: (progress: TrialsProgress) => void;
  /** Aborted: no further run of the scenario set starts and bestForm throws the abort reason. */
  signal?: AbortSignal;
  /**
   * A run of the scenario set the provider refused (429) is run again after a pause of `waitMs` × the
   * refusals in a row (default 15000); more than `maxWaits` in a row (default 4) stops bestForm. A
   * provider 5xx stops it at once — both with a ProviderStoppedError.
   */
  throttle?: { waitMs?: number; maxWaits?: number };
}

export interface Form {
  components: string[];
  passRate: Interval;
  /** Mean cost of one run of the scenario set. */
  costUsd: number;
  priced: boolean;
  /** Mean tokens (input + output) of one run of the scenario set — what "cheapest" is measured in when a model is unpriced. */
  tokens: number;
  /** Scenario runs the model could not be asked for — left out of the pass rate. */
  errored: number;
}

export interface BestFormResult {
  /** Every form, best pass rate first, then cheapest. */
  forms: Form[];
  shares: Record<string, number>;
  /**
   * The cheapest form at or above `target` — by cost when every form is priced, by tokens otherwise.
   * Absent when no form passed a single scenario run: there is nothing to choose between, and naming the
   * cheapest of forms that all fail "best" would read as a recommendation.
   */
  best?: Form;
  target: number;
}

export async function bestForm(opts: BestFormOptions): Promise<BestFormResult> {
  refuseUnknownNames('bestForm', opts, BEST_FORM_NAMES);
  const names = Object.keys(opts.components);
  const trials = opts.trials ?? 3;
  const forms: Form[] = [];
  const subsets = coalitions(names);
  const total = subsets.length * trials;
  let done = 0, failed = 0, refusals = 0, concurrency = Math.max(1, opts.concurrency ?? 4);
  let lastError: string | undefined;
  const waitMs = opts.throttle?.waitMs ?? 15_000, maxWaits = opts.throttle?.maxWaits ?? 4;
  for (const on of subsets) {
    const scenarios = opts.scenarios.map((s) => names.filter((n) => on.has(n)).reduce((acc, n) => opts.components[n]!.apply(acc), opts.baseSystem !== undefined ? { ...s, system: opts.baseSystem } : s));
    let pass = 0, ran = 0, errored = 0, cost = 0, tokens = 0, priced = true;
    for (let t = 0; t < trials; t++) {
      opts.signal?.throwIfAborted();
      const report = (extra: Pick<TrialsProgress, 'throttled' | 'retrying'> = {}, running = 0) =>
        opts.onProgress?.({ done, total, failed, concurrency, running, ...(lastError !== undefined ? { lastError } : {}), ...extra });
      if (done === 0 && t === 0) report({}, 1); // it has started: say so before the first run ends
      const r = await reportRetriesTo((retrying) => report({ retrying }, 1), () => runSuite({ model: opts.model, scenarios, concurrency, ...(opts.pricing ? { pricing: opts.pricing } : {}), ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}), ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) }));
      // What the provider said decides first: a refusal is run again slower, a server error stops.
      const refused = r.results.find((x) => x.error !== undefined && classifyFailure(x.error) === 'throttled');
      const broken = r.results.find((x) => x.error !== undefined && classifyFailure(x.error) === 'server');
      if (broken) throw new ProviderStoppedError('server', broken.error!, done, total);
      if (refused) {
        if (++refusals > maxWaits) throw new ProviderStoppedError('throttled', refused.error!, done, total);
        concurrency = 1;
        report({ throttled: { waitMs: waitMs * refusals, attempt: refusals, maxWaits, error: refused.error! } });
        await pause(waitMs * refusals, opts.signal);
        t--;
        continue;
      }
      refusals = 0;
      for (const x of r.results) {
        if (x.error !== undefined) { errored++; failed++; lastError = x.error; continue; }
        ran++; if (x.pass) pass++;
        priced &&= x.priced;
        tokens += x.inputTokens + x.outputTokens;
      }
      cost += r.costUsd;
      done++;
      report();
    }
    forms.push({ components: names.filter((n) => on.has(n)), passRate: wilson(pass, ran), costUsd: cost / trials, priced, tokens: tokens / trials, errored });
  }
  const values = Object.fromEntries(forms.map((f) => [coalitionKey(f.components), f.passRate.value]));
  if (Object.values(values).some((v) => Number.isNaN(v))) throw new Error('@gnldev/lab: bestForm: a form had no scenario the model could be asked for — no share can be computed');
  // An unpriced model costs 0 in every form, which would make the first form found the "cheapest".
  const price = forms.every((f) => f.priced) ? (f: Form) => f.costUsd : (f: Form) => f.tokens;
  forms.sort((a, b) => b.passRate.value - a.passRate.value || price(a) - price(b));
  const target = opts.target ?? forms[0]!.passRate.value;
  // Nothing passed: no best — unless a target was asked for, which no form reached (below).
  if (forms[0]!.passRate.value === 0 && !(opts.target! > 0)) return { forms, shares: shapley(names, values), target };
  const reaching = forms.filter((f) => f.passRate.value >= target);
  if (reaching.length === 0) throw new RangeError(`@gnldev/lab: bestForm: no form reached the target pass rate ${target}; the best was ${forms[0]!.passRate.value}`);
  const best = reaching.reduce((a, b) => (price(b) < price(a) ? b : a));
  return { forms, shares: shapley(names, values), best, target };
}
