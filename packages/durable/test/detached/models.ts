// Scripted streaming models for the detached-run scenarios: text in timed deltas, tool calls by turn.
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toolTurns(prompt: any[]): number {
  let n = 0;
  for (const m of prompt ?? []) if (m.role === 'tool') n++;
  return n;
}

/** Streams `words` one delta every `gapMs`; with `tool`, calls it first and answers after its result. */
export function streamingModel(opts: { words: string[]; gapMs: number; tool?: { name: string; input: unknown } }): any {
  return {
    specificationVersion: 'v3', provider: 'scripted', modelId: 'stream', supportedUrls: {},
    doGenerate: async () => { throw new Error('stream only'); },
    doStream: async ({ prompt, abortSignal }: any) => {
      const wantsTool = opts.tool && toolTurns(prompt) === 0;
      return {
        stream: new ReadableStream({
          async start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] });
            if (wantsTool) {
              c.enqueue({ type: 'tool-call', toolCallId: 'call-1', toolName: opts.tool!.name, input: JSON.stringify(opts.tool!.input) });
              c.enqueue({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage });
              c.close();
              return;
            }
            c.enqueue({ type: 'text-start', id: 't' });
            for (const w of opts.words) {
              await sleep(opts.gapMs);
              // A real provider stops when its caller aborts; so does this one.
              if (abortSignal?.aborted) { c.error(abortSignal.reason ?? new Error('aborted')); return; }
              c.enqueue({ type: 'text-delta', id: 't', delta: w });
            }
            c.enqueue({ type: 'text-end', id: 't' });
            c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
            c.close();
          },
        }),
      };
    },
  };
}

/** The text a reader holds after applying `step-retry` (discard that step) to the events it saw. */
export function textOf(events: Array<{ kind: string; data: any; step: number }>): string {
  const byStep = new Map<number, string>();
  for (const e of events) {
    if (e.kind === 'step-retry') byStep.delete(e.data.step);
    if (e.kind === 'text') byStep.set(e.step, (byStep.get(e.step) ?? '') + e.data.text);
  }
  return [...byStep.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t).join('');
}
