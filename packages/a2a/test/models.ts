// Mock language models for the A2A door's tests (AI SDK LanguageModel v2 shape, doGenerate only).
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/** Answers `text` and stops. `calls.n` counts model calls, so a replay is visible as no new call. */
export function textModel(text: string, calls: { n: number } = { n: 0 }): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => { calls.n++; return { content: [{ type: 'text', text }], finishReason: 'stop', usage, warnings: [] }; },
  };
}

/** Calls `charge` on the first step, answers 'Charged.' once a tool result is in the prompt. */
export function chargeModel(): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async ({ prompt }: any) => ((prompt ?? []).filter((m: any) => m.role === 'tool').length === 0
      ? { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'charge', input: JSON.stringify({ amount: 5000 }) }], finishReason: 'tool-calls', usage, warnings: [] }
      : { content: [{ type: 'text', text: 'Charged.' }], finishReason: 'stop', usage, warnings: [] }),
  };
}
