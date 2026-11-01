// The names of every options object @gnldev/experiment reads, each held to its parameter's type by the
// compiler (@gnldev/options `optionNames`): an option added to a type and not here fails typecheck. A
// name not listed is refused where the bag is read, naming the option it is closest to.
import { optionNames } from '@gnldev/options';

export const REPLAY_NAMES = optionNames<import('./replay.js').CounterfactualOptions>()([
  'journal', 'runId', 'model', 'tools', 'system', 'maxSteps', 'prepareStep', 'pricing', 'timeoutMs', 'answers', 'overrides',
]);

export const SUITE_NAMES = optionNames<import('./suite.js').RunSuiteOptions>()(['model', 'scenarios', 'pricing', 'maxSteps', 'concurrency', 'timeoutMs']);

export const TRIALS_NAMES = optionNames<import('./trials.js').RunTrialsOptions>()(['concurrency', 'onProgress', 'signal', 'throttle', 'stopOnServerError']);
export const RETRYING_FETCH_NAMES = optionNames<import('./trials.js').RetryingFetchOptions>()(['retries', 'delayMs', 'fetch', 'onRetry']);
export const MASK_CONVERSATION_NAMES = optionNames<import('./mask.js').MaskConversationOptions>()(['dropInput', 'hideToolResults', 'replaceInput', 'insertInput']);
