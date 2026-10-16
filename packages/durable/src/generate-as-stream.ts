// A MODEL THAT CAN ONLY GENERATE, STREAMED.
//
// A registry run executes on the stream path (detached.ts, design decision D5). A provider streams; a
// hand-written model (a test double, an in-house adapter) may implement only `doGenerate`. Such a model is
// streamed from its generate result — the answer arrives in one piece instead of word by word, and nothing
// else changes. A model that has a `doStream` is used as it is.

/** `model` itself when it can stream; else the same model whose `doStream` streams its `doGenerate` answer. */
export function streamable<M>(model: M): M {
  const m = model as unknown as { doStream?: unknown; doGenerate?: (o: unknown) => Promise<any> };
  if (typeof m.doStream === 'function' || typeof m.doGenerate !== 'function') return model;
  return Object.assign(Object.create(Object.getPrototypeOf(model)), model, {
    doStream: async (options: unknown) => ({ stream: partsOf(await m.doGenerate!(options)) }),
  }) as M;
}

/** A generate result as the stream parts a provider sends for it (in the result's own specification shapes). */
function partsOf(r: any): ReadableStream<any> {
  const parts: any[] = [{ type: 'stream-start', warnings: r.warnings ?? [] }];
  let n = 0;
  for (const c of r.content ?? []) {
    if (c.type === 'text') { const id = `t${n++}`; parts.push({ type: 'text-start', id }, { type: 'text-delta', id, delta: c.text }, { type: 'text-end', id }); }
    else if (c.type === 'reasoning') { const id = `r${n++}`; parts.push({ type: 'reasoning-start', id }, { type: 'reasoning-delta', id, delta: c.text }, { type: 'reasoning-end', id }); }
    else parts.push(c);
  }
  parts.push({ type: 'finish', finishReason: r.finishReason, usage: r.usage, ...(r.providerMetadata ? { providerMetadata: r.providerMetadata } : {}) });
  return new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } });
}
