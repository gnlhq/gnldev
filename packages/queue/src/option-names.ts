// The names of every options object @gnldev/queue reads, each held to its parameter's type by the
// compiler (@gnldev/options `optionNames`): an option added to a type and not here fails typecheck. A
// name not listed is refused where the bag is read, naming the option it is closest to.
import { optionNames } from '@gnldev/options';

export const ENQUEUE_OPTIONS_NAMES = optionNames<NonNullable<Parameters<typeof import('./index.js').enqueue>[3]>>()(['id', 'maxDepth', 'caller', 'runAt', 'resourceId', 'orgId']);
export const RETRY_JOB_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./index.js').retryJob>[2]>>()(['maxDepth', 'newRun']);
export const CREATE_WORKER_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./index.js').createWorker>[2]>>()(['owner', 'ttlMs', 'pollMs', 'maxAttempts', 'backoff', 'maxPollMs', 'heartbeat', 'maxRenewFailures', 'onError', 'retryDelayMs', 'concurrency', 'typeConcurrency']);
export const MOVE_JOB_TO_NAMES = optionNames<NonNullable<Parameters<typeof import('./index.js').moveJob>[2]>>()(['caller', 'runAt', 'resourceId', 'orgId']);
