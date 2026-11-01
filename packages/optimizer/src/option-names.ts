// The names of every options object @gnldev/optimizer reads, each held to its parameter's type by the
// compiler (@gnldev/options `optionNames`): an option added to a type and not here fails typecheck. A
// name not listed is refused where the bag is read, naming the option it is closest to.
import { optionNames } from '@gnldev/options';

export const DIAGNOSE_NAMES = optionNames<import('./diagnose.js').DiagnoseOptions>()([
  'journal', 'agent', 'limit', 'keepLast', 'minCacheTokens', 'pricing',
]);

export const MASK_NAMES = optionNames<import('./mask.js').MaskOldToolOutputsOptions>()(['keepLast', 'minChars']);

export const CACHE_NAMES = optionNames<import('./cache.js').CacheBreakpointsOptions>()(['ttl', 'cacheKey']);

export const COMPARE_NAMES = optionNames<import('./compare.js').CompareOptions>()(['baseline', 'candidate', 'scenarios', 'pricing', 'maxSteps', 'concurrency', 'timeoutMs']);

export const REPLAY_AGENT_NAMES = optionNames<import('./replay-agent.js').ReplayAgentOptions>()([
  'journal', 'agent', 'model', 'tools', 'system', 'maxSteps', 'prepareStep', 'pricing', 'timeoutMs', 'limit', 'concurrency',
]);

export const STUDIO_OPTIMIZER_NAMES = optionNames<import('./studio.js').StudioOptimizerOptions>()(['config', 'models', 'pricing']);

export const SAVE_EXPERIMENT_NAMES = optionNames<Parameters<typeof import('./history.js').saveExperiment>[1]>()(['agent', 'model', 'limit', 'keepLast', 'result', 'at']);
export const LIST_EXPERIMENTS_NAMES = optionNames<import('./history.js').ListExperimentsOptions>()(['journal', 'agent', 'limit']);
export const RENDER_REPORT_NAMES = optionNames<Parameters<typeof import('./history.js').renderReport>[0]>()(['agent', 'diagnosis', 'experiments', 'generatedAt']);
