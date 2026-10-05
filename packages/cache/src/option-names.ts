// The names of every options object @gnldev/cache reads, each held to its parameter's type by the
// compiler (@gnldev/options `optionNames`): an option added to a type and not here fails typecheck. A
// name not listed is refused where the bag is read, naming the option it is closest to.
import { optionNames } from '@gnldev/options';

export const CREATE_CACHE_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./index.js').createCache>[2]>>()(['onError']);
export const CACHE_SET_NAMES = optionNames<import('./index.js').CacheSetOptions>()(['ttlMs']);
