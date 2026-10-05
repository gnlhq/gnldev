// Every options object @gnldev/processors reads refuses a name it does not take (@gnldev/options),
// naming the option it is closest to: a misspelled `deny` on toolFilter or `types` on the PII redactor
// would otherwise run the processor with nothing to filter or redact.
import { describe, it, expect } from 'vitest';
import { piiRedactor, piiTextRedactor, moderationProcessor, toolFilter, tokenLimit, promptInjectionDetector, outputLimit, tokenLimiter, toolSearch } from '../src/index.js';

describe('@gnldev/processors: a misspelled option is refused', () => {
  it.each([
    ['piiRedactor', () => piiRedactor({ type: ['email'] } as any), /piiRedactor: `type` .* did you mean `types`\?/],
    ['piiTextRedactor', () => piiTextRedactor({ maks: '*' } as any), /piiTextRedactor: `maks` .* did you mean `mask`\?/],
    ['moderationProcessor', () => moderationProcessor({ blockList: ['x'] } as any), /moderationProcessor: `blockList` .* did you mean `blocklist`\?/],
    ['toolFilter', () => toolFilter({ denny: ['x'] } as any), /toolFilter: `denny` .* did you mean `deny`\?/],
    ['tokenLimit', () => tokenLimit({ maxToken: 5 } as any), /tokenLimit: `maxToken` .* did you mean `maxTokens`\?/],
    ['promptInjectionDetector', () => promptInjectionDetector({ pattern: [] } as any), /promptInjectionDetector: `pattern` .* did you mean `patterns`\?/],
    ['outputLimit', () => outputLimit({ maxChar: 5 } as any), /outputLimit: `maxChar` .* did you mean `maxChars`\?/],
    ['toolSearch', () => toolSearch({ embed: async (t: string[]) => t.map(() => [1]), topk: 3 } as any), /toolSearch: `topk` .* did you mean `topK`\?/],
    ['tokenLimiter', () => tokenLimiter({ maxInputToken: 5 } as any), /tokenLimiter: `maxInputToken` .* did you mean `maxInputTokens`\?/],
  ])('%s', (_n, build, message) => {
    expect(build).toThrow(message);
  });
});
