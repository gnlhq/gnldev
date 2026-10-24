// Provider prompt caching, placed where it pays.
//
// Every model step after the first re-sends the run's opening — system prompt, tool definitions, the
// conversation so far. A provider reads a cached prefix at a tenth of the input price (less on some
// newer models), but only if the request says where the prefix ends:
//   · Anthropic caches nothing unless a block carries `cacheControl` (at most 4 per request). A mark on
//     the system message caches tools + system; a mark on the last message caches the conversation so
//     far, so the next step reads everything before its own new turn.
//   · OpenAI caches automatically; a `promptCacheKey` keeps one agent's requests on the machine that has
//     its prefix, and keeps one tenant's cache apart from another's.
//   · Anything else is left as it is.
//
// A model middleware: it changes the request the provider gets, after GNL has journaled the step's
// identity, so the journal and a replay see the same run with or without it. Pure in the request, so a
// resumed step asks the provider the same thing.
//
// A cache WRITE costs more than plain input (Anthropic 1.25x for 5 minutes, 2x for an hour), so a run of
// one step pays for a cache it never reads. diagnoseAgent says whether an agent's runs are long enough
// for it to pay.
import { wrapLanguageModel, type LanguageModel } from 'ai';
import { refuseUnknownNames } from '@gnldev/options';
import { CACHE_NAMES } from './option-names.js';

export interface CacheBreakpointsOptions {
  /** Anthropic cache lifetime: '5m' (default, write 1.25x) or '1h' (write 2x) — for agents slower than 5 minutes between steps. */
  ttl?: '5m' | '1h';
  /** OpenAI `promptCacheKey` — name the agent, and the tenant when tenants must not share a cache. Omitted: no key is sent. */
  cacheKey?: string;
}

const ANTHROPIC_MAX_MARKS = 4;
type Msg = { role: string; content: unknown; providerOptions?: Record<string, Record<string, unknown>> };

const marked = (m: Msg) => m.providerOptions?.anthropic?.cacheControl !== undefined;

/** The request's messages with Anthropic cache marks on the system message and the last message. */
export function placeAnthropicMarks(prompt: readonly Msg[], ttl: '5m' | '1h' = '5m'): Msg[] {
  const control = ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  let budget = ANTHROPIC_MAX_MARKS - prompt.filter(marked).length;
  const want = new Set<number>();
  const lastSystem = prompt.map((m) => m.role).lastIndexOf('system');
  if (lastSystem >= 0) want.add(lastSystem);
  if (prompt.length > 0) want.add(prompt.length - 1);
  return prompt.map((m, i) => {
    if (!want.has(i) || marked(m) || budget <= 0) return m;
    budget--;
    return { ...m, providerOptions: { ...m.providerOptions, anthropic: { ...m.providerOptions?.anthropic, cacheControl: control } } };
  });
}

/** A middleware that asks each provider for its prompt cache. */
export function cacheBreakpoints(opts: CacheBreakpointsOptions = {}) {
  refuseUnknownNames('cacheBreakpoints', opts, CACHE_NAMES);
  return {
    specificationVersion: 'v3' as const,
    transformParams: async ({ params, model }: { params: any; model: { provider: string } }) => {
      const provider = model.provider.split('.')[0];
      if (provider === 'anthropic') return { ...params, prompt: placeAnthropicMarks(params.prompt, opts.ttl) };
      if (provider === 'openai' && opts.cacheKey) {
        return { ...params, providerOptions: { ...params.providerOptions, openai: { promptCacheKey: opts.cacheKey, ...params.providerOptions?.openai } } };
      }
      return params;
    },
  };
}

/** `model`, asking its provider for its prompt cache — pass it as an agent's `model`. */
export function withCacheBreakpoints<M extends LanguageModel>(model: M, opts: CacheBreakpointsOptions = {}): M {
  refuseUnknownNames('withCacheBreakpoints', opts, CACHE_NAMES);
  return wrapLanguageModel({ model: model as any, middleware: cacheBreakpoints(opts) as any }) as unknown as M;
}
