// The names of every options object @gnldev/processors reads, each held to its parameter's type by the
// compiler (@gnldev/options `optionNames`): an option added to a type and not here fails typecheck. A
// name not listed is refused where the bag is read, naming the option it is closest to.
import { optionNames } from '@gnldev/options';

export const PII_REDACTOR_NAMES = optionNames<NonNullable<Parameters<typeof import('./pii.js').piiRedactor>[0]>>()(['types', 'mask', 'on', 'redactToolResults', 'extraPatterns', 'validate']);
export const PII_TEXT_REDACTOR_NAMES = optionNames<NonNullable<Parameters<typeof import('./pii.js').piiTextRedactor>[0]>>()(['types', 'mask', 'extraPatterns', 'validate']);
export const MODERATION_PROCESSOR_NAMES = optionNames<NonNullable<Parameters<typeof import('./moderation.js').moderationProcessor>[0]>>()(['blocklist', 'on']);
export const TOOL_FILTER_NAMES = optionNames<NonNullable<Parameters<typeof import('./tool-filter.js').toolFilter>[0]>>()(['allow', 'deny']);
export const TOKEN_LIMIT_NAMES = optionNames<NonNullable<Parameters<typeof import('./safety.js').tokenLimit>[0]>>()(['maxTokens']);
export const PROMPT_INJECTION_DETECTOR_NAMES = optionNames<NonNullable<Parameters<typeof import('./safety.js').promptInjectionDetector>[0]>>()(['patterns']);
export const OUTPUT_LIMIT_NAMES = optionNames<NonNullable<Parameters<typeof import('./safety.js').outputLimit>[0]>>()(['maxChars']);
export const TOKEN_LIMITER_NAMES = optionNames<NonNullable<Parameters<typeof import('./token-limiter.js').tokenLimiter>[0]>>()(['maxInputTokens', 'countTokens', 'strategy', 'keepSystem']);
export const TOOL_SEARCH_NAMES = optionNames<NonNullable<Parameters<typeof import('./tool-search.js').toolSearch>[0]>>()(['embed', 'topK', 'always', 'minScore']);
