// openaiStrict applies to every provider that serves OpenAI's strict structured-output API, not to
// whatever has "openai" in its name. Azure OpenAI is that API under the provider id `azure`
// (`'azure/gpt-4o'` in GNL's string form; `azure.chat` / `azure.responses` from @ai-sdk/azure), and
// the rule skipped it: a tool schema OpenAI's strict mode refuses went to Azure untransformed.
import { describe, it, expect } from 'vitest';
import { openaiStrict } from '../src/index.js';
import { detectModel } from '../src/detect.js';

const applies = (model: unknown) => openaiStrict.shouldApply(detectModel(model as any));

describe('the OpenAI strict family', () => {
  for (const m of ['openai/gpt-4o', 'azure/gpt-4o', { provider: 'openai-compatible.chat', modelId: 'some-model' }, 'groq/llama-3.3-70b', { provider: 'openai.chat', modelId: 'gpt-4o' }, { provider: 'azure.chat', modelId: 'gpt-4o' }, { provider: 'azure.responses', modelId: 'gpt-4.1' }]) {
    it(`applies to ${JSON.stringify(m)}`, () => expect(applies(m)).toBe(true));
  }
  for (const m of ['anthropic/claude-sonnet-4', 'google/gemini-2.5-pro', { provider: 'anthropic.messages', modelId: 'claude' }]) {
    it(`does not apply to ${JSON.stringify(m)}`, () => expect(applies(m)).toBe(false));
  }
});
