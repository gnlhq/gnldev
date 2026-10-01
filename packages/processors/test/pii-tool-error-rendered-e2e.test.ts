// End-to-end with the REAL piiRedactor: what a thrown tool error and a tool call's arguments become
// in every place they are shown.
//
// Invariant: the processor sees exactly the text every consumer renders for a thrown value, once, at
// the source; the journal, the thread, the model's next prompt and the stream carry that masked text.
// The AI SDK renders a tool error as `String(error)` (`name: message`) for an Error and as JSON for a
// thrown object — so masking `.message` alone is not enough.
//
// Measured before this file: an address in the error's `name`, or in a field of a thrown plain
// object, reached the thread and the next prompt (and the journal held "[object Object]" for
// objects). A tool call's arguments (`lookup({ email })`) reached thread memory and
// `response.messages` raw, because `redactMessages` masks only text parts.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, BasicMemory, runDurable, streamDurable } from '@gnldev/durable';
import { toolCallingModel } from '@gnldev/durable/mock';
import { piiRedactor } from '../src/pii.js';

const EMAIL = 'ayse@acme.com';

async function journalText(j: any): Promise<string> {
  let out = '';
  for (const k of j.keys()) out += `${k}=${JSON.stringify(await j.get(k)) ?? ''}\n`;
  return out;
}

async function run(thrown: () => unknown) {
  const journal = new InMemoryJournal();
  const memory = new BasicMemory(journal);
  const prompts: unknown[] = [];
  const m = toolCallingModel({ toolName: 'lookup', input: { id: 'u1' }, doneText: 'done' });
  const model = { ...m, doGenerate: async (o: any) => { prompts.push(o.prompt); return m.doGenerate(o); } };
  const r: any = await runDurable({
    runId: 'r1', journal, memory, threadId: 't1', prompt: 'look up u1', model,
    tools: { lookup: { execute: async () => { throw thrown(); } } },
    processors: [piiRedactor({ redactToolResults: true })],
  } as any);
  const record = await journal.get<any>('r1:tool:call-1');
  return {
    text: r.text,
    record,
    leaks: {
      journal: (await journalText(journal)).includes(EMAIL),
      thread: JSON.stringify(await memory.getMessages('t1')).includes(EMAIL),
      prompt: JSON.stringify(prompts[1] ?? null).includes(EMAIL),
    },
    errorText: JSON.stringify(prompts[1] ?? null).match(/"error-text","value":"((?:[^"\\]|\\.)*)"/)?.[1],
  };
}

const clean = { journal: false, thread: false, prompt: false };

describe('a thrown tool error: the hooks see the rendered text', () => {
  it('an address in the error NAME, message clean', async () => {
    const r = await run(() => { const e = new Error('no such account'); e.name = `NotFound<${EMAIL}>`; return e; });
    expect(r.leaks).toEqual(clean);
    expect(r.record.error).toBe('NotFound<[REDACTED_EMAIL]>: no such account');
    // The model sees exactly what the journal holds.
    expect(r.errorText).toBe(r.record.error);
  });

  it('an address in both the name and the message', async () => {
    class LookupError extends Error { constructor(m: string) { super(m); this.name = `NotFound<${EMAIL}>`; } }
    const r = await run(() => new LookupError(`no account for ${EMAIL}`));
    expect(r.leaks).toEqual(clean);
    expect(r.errorText).toBe(r.record.error);
  });

  it('a thrown plain object — the journal holds its JSON, masked, not "[object Object]"', async () => {
    const r = await run(() => ({ code: 'E_NOTFOUND', detail: `no account for ${EMAIL}` }));
    expect(r.leaks).toEqual(clean);
    expect(r.record.error).toBe('{"code":"E_NOTFOUND","detail":"no account for [REDACTED_EMAIL]"}');
    expect(JSON.parse(`"${r.errorText}"`)).toBe(r.record.error);
  });

  it('a thrown object with a clean message and the address in another field', async () => {
    const r = await run(() => ({ message: 'lookup failed', email: EMAIL }));
    expect(r.leaks).toEqual(clean);
  });

  it('a plain Error (control): the class name stays in the text, the address does not', async () => {
    const r = await run(() => new TypeError(`no account for ${EMAIL}`));
    expect(r.leaks).toEqual(clean);
    expect(r.record.error).toBe('TypeError: no account for [REDACTED_EMAIL]');
    expect(r.errorText).toBe(r.record.error);
  });

  it('the stream: the tool-error part renders as the masked text', async () => {
    const journal = new InMemoryJournal();
    const usage = { inputTokens: { total: 1, noCache: 1 }, outputTokens: { total: 1, text: 1 } };
    const s = (parts: any[]) => ({ stream: new ReadableStream({ start(c) { for (const x of parts) c.enqueue(x); c.close(); } }) });
    const model = {
      specificationVersion: 'v4', provider: 'mock', modelId: 'st', supportedUrls: {},
      doGenerate: async () => { throw new Error('n/a'); },
      doStream: async ({ prompt }: any) => prompt.some((m: any) => m.role === 'tool')
        ? s([{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'done' }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }])
        : s([{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: '{"id":"u1"}' }, { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage }]),
    };
    const res: any = await streamDurable({
      runId: 's1', journal, prompt: 'x', model,
      tools: { lookup: { execute: async () => { const e = new Error('no such account'); e.name = `NotFound<${EMAIL}>`; throw e; } } },
      processors: [piiRedactor({ redactToolResults: true })],
    } as any);
    const parts: any[] = [];
    for await (const p of res.fullStream) parts.push(p);
    const err = parts.find((p) => p.type === 'tool-error');
    expect(String(err.error)).toBe('NotFound<[REDACTED_EMAIL]>: no such account');
    expect(String(err.error.stack)).not.toContain(EMAIL);
  });
});

describe('tool-call arguments are masked in the messages piiRedactor sees', () => {
  it('thread memory and response.messages carry the masked arguments; the tool ran with the raw ones', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    let ranWith: unknown;
    const r: any = await runDurable({
      runId: 'a1', journal, memory, threadId: 't1', prompt: 'look up the user',
      model: toolCallingModel({ toolName: 'lookup', input: { email: EMAIL, ts: 1727712000000 }, doneText: 'done' }),
      tools: { lookup: { execute: async (args: unknown) => { ranWith = args; return { ok: true }; } } },
      processors: [piiRedactor()],
    } as any);
    expect(ranWith).toEqual({ email: EMAIL, ts: 1727712000000 });
    const thread = JSON.stringify(await memory.getMessages('t1'));
    expect(thread).not.toContain(EMAIL);
    expect(thread).toContain('[REDACTED_EMAIL]');
    // Numbers stay numbers — the walk masks strings, it does not re-read a timestamp as a phone.
    expect(thread).toContain('1727712000000');
    expect(JSON.stringify(r.response.messages)).not.toContain(EMAIL);
  });

  it('history passed in: a tool-call part in the input messages is masked before the model sees it', async () => {
    const proc = piiRedactor();
    const ctx = { journal: new InMemoryJournal(), runId: 'h' } as any;
    const out: any = proc.processInput!({
      messages: [
        { role: 'user', content: 'find her' },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'lookup', input: { who: [EMAIL] } }] },
      ],
    } as any, ctx);
    expect(JSON.stringify(out.messages)).not.toContain(EMAIL);
    expect(out.messages[1].content[0].input).toEqual({ who: ['[REDACTED_EMAIL]'] });
  });

  it('arguments the walk cannot finish are replaced by a marker, never kept', () => {
    const proc = piiRedactor();
    const hostile = { get email(): string { throw new Error(EMAIL); } };
    const out: any = proc.processOutput!({
      text: 'x',
      messages: [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'lookup', input: hostile }] }],
    } as any, { journal: new InMemoryJournal(), runId: 'h' } as any);
    expect(out.messages[0].content[0].input).toMatch(/^\[REDACTED_TOOL_CALL_INPUT/);
  });
});
