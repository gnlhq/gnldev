// The names of every options object @gnldev/client reads, each held to its parameter's type by the
// compiler (@gnldev/options `optionNames`): an option added to a type and not here fails typecheck. A
// name not listed is refused where the bag is read, naming the option it is closest to.
import { optionNames } from '@gnldev/options';

export const TOKEN_FROM_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./index.js').tokenFrom>[1]>>()(['fetch']);
export const GNL_CLIENT_NAMES = optionNames<NonNullable<ConstructorParameters<typeof import('./index.js').GnlClient>[0]>>()(['baseUrl', 'headers', 'fetch', 'getToken', 'refreshSkewSec']);
export const LIST_RUNS_NAMES = optionNames<NonNullable<Parameters<import('./index.js').GnlClient['listRuns']>[0]>>()(['topLevel']);
