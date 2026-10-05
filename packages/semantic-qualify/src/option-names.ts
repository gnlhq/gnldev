// The names of every options object @gnldev/semantic-qualify reads, each held to its parameter's type by the
// compiler (@gnldev/options `optionNames`): an option added to a type and not here fails typecheck. A
// name not listed is refused where the bag is read, naming the option it is closest to.
import { optionNames } from '@gnldev/options';

export const QUALIFY_JUDGE_NAMES = optionNames<NonNullable<Parameters<typeof import('./index.js').qualifyJudge>[0]>>()(['complete', 'judgeModelId', 'fixtures', 'concurrency', 'limit', 'onProgress', 'now']);
