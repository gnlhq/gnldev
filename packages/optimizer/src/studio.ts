// The object Studio's optimizer tab calls (`createStudioApp({ optimizer: studioOptimizer(...) })`).
//
// Studio hands every call the reader of the request it serves — scoped to the caller's organization —
// so diagnosis and replay read exactly the runs that caller may see. This side holds what Studio must
// not: the agents' tool definitions (from the same config createGnl is given) and the candidate models.
// Shaped to Studio's `StudioOptimizer` by structure, so neither package depends on the other.
import type { LanguageModel, ToolSet } from 'ai';
import type { JournalReader, ModelPricing } from '@gnldev/durable';
import { refuseUnknownNames } from '@gnldev/options';
import { STUDIO_OPTIMIZER_NAMES } from './option-names.js';
import { diagnoseAgent, type AgentDiagnosis } from './diagnose.js';
import { replayAgent, type ReplayAgentResult } from './replay-agent.js';
import { maskOldToolOutputs } from './mask.js';
import { saveExperiment, listExperiments, renderReport, type ExperimentRecord } from './history.js';

export interface StudioOptimizerOptions {
  /** The config createGnl is given — its agents are offered, and their tools answer a replay. */
  config: { agents?: Record<string, { tools?: unknown }> };
  /** The candidate models a replay may use, by the name Studio shows. */
  models: Record<string, LanguageModel>;
  /** Prices. The journal's `__pricing__` over the defaults when omitted. */
  pricing?: Record<string, ModelPricing>;
}

export interface StudioOptimizerApi {
  catalog(): { agents: string[]; models: string[] };
  diagnose(journal: JournalReader, agent: string): Promise<AgentDiagnosis>;
  /** Replays, and keeps the outcome in the journal it was handed (when that journal can be written). */
  replay(journal: JournalReader, request: { agent: string; model: string; limit?: number; keepLast?: number }): Promise<ReplayAgentResult>;
  /** The agent's kept replays, newest first. */
  history(journal: JournalReader, agent: string): Promise<ExperimentRecord[]>;
  /** A Markdown report: diagnosis, findings, kept replays, recommendation. Changes nothing. */
  report(journal: JournalReader, agent: string): Promise<{ markdown: string }>;
}

/** Builds the object Studio's optimizer tab calls. */
export function studioOptimizer(opts: StudioOptimizerOptions): StudioOptimizerApi {
  refuseUnknownNames('studioOptimizer', opts, STUDIO_OPTIMIZER_NAMES);
  const { config, models, pricing } = opts;
  const toolsOf = (agent: string): ToolSet | undefined => {
    const tools = config.agents?.[agent]?.tools;
    if (tools === undefined) return undefined;
    if (typeof tools !== 'object' || tools === null) {
      throw new TypeError(`@gnldev/optimizer: agent '${agent}' builds its tools per request; a replay needs them as an object`);
    }
    return tools as ToolSet;
  };
  return {
    catalog: () => ({ agents: Object.keys(config.agents ?? {}), models: Object.keys(models) }),
    diagnose: (journal, agent) => diagnoseAgent({ journal: journal as never, agent, ...(pricing ? { pricing } : {}) }),
    replay: async (journal, req) => {
      const model = models[req.model];
      if (!model) throw new TypeError(`@gnldev/optimizer: no candidate model named '${req.model}'`);
      const tools = toolsOf(req.agent);
      const limit = req.limit ?? 20;
      const result = await replayAgent({
        journal: journal as never, agent: req.agent, model, limit,
        ...(tools ? { tools } : {}),
        ...(req.keepLast !== undefined ? { prepareStep: maskOldToolOutputs({ keepLast: req.keepLast }).prepareStep as never } : {}),
        ...(pricing ? { pricing } : {}),
      });
      await saveExperiment(journal as never, { agent: req.agent, model: req.model, limit, ...(req.keepLast !== undefined ? { keepLast: req.keepLast } : {}), result });
      return result;
    },
    history: (journal, agent) => listExperiments({ journal: journal as never, agent }),
    report: async (journal, agent) => {
      const [diagnosis, experiments] = await Promise.all([
        diagnoseAgent({ journal: journal as never, agent, ...(pricing ? { pricing } : {}) }),
        listExperiments({ journal: journal as never, agent }),
      ]);
      return { markdown: renderReport({ agent, diagnosis, experiments }) };
    },
  };
}
