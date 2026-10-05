// The names of every options object @gnldev/events reads, each held to its parameter's type by the
// compiler (@gnldev/options `optionNames`): an option added to a type and not here fails typecheck. A
// name not listed is refused where the bag is read, naming the option it is closest to.
import { optionNames } from '@gnldev/options';

export const EMIT_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./index.js').emit>[3]>>()(['id', 'maxDepth', 'resourceId', 'orgId']);
export const CREATE_CONSUMER_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./index.js').createConsumer>[3]>>()(['name', 'pollMs', 'backoff', 'maxPollMs', 'maxAttempts', 'retryDelayMs', 'leaseMs', 'maxHoldMs']);
