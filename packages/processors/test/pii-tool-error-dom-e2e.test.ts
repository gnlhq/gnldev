// End-to-end with the REAL piiRedactor: a tool that throws a DOMException (fetch's AbortError /
// TimeoutError) under `redactToolResults`.
//
// Invariant: masking never changes whether a run completes — it only changes the text. The run that
// completes unmasked completes masked, and the masked text is all that reaches the journal, the
// thread, and the model's next prompt.
//
// Measured before this file: the masked copy of a DOMException could not be read (`.name` and
// `String(err)` threw ERR_INVALID_THIS from the prototype's brand-checked getters), so the AI SDK's
// `error.toString()` threw and the whole run threw a TypeError — where 0.9.0 completed.
import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { InMemoryJournal, BasicMemory, runDurable } from '@gnldev/durable';
import { toolCallingModel } from '@gnldev/durable/mock';
import { piiRedactor } from '../src/pii.js';

const EMAIL = 'ayse@acme.com';

function capturing(model: any) {
  const prompts: unknown[] = [];
  return { prompts, model: { ...model, doGenerate: async (o: any) => { prompts.push(o.prompt); return model.doGenerate(o); } } };
}

describe('piiRedactor redactToolResults + a tool that throws a DOMException', () => {
  for (const [label, mk] of [
    ['DOMException TimeoutError', () => new DOMException(`request for ${EMAIL} timed out`, 'TimeoutError')],
    ['DOMException AbortError', () => new DOMException(`request for ${EMAIL} aborted`, 'AbortError')],
    ['cross-realm Error (node:vm)', () => vm.runInNewContext(`new Error('request for ${EMAIL} timed out')`)],
    ['plain Error (control)', () => new Error(`request for ${EMAIL} timed out`)],
  ] as const) {
    it(`${label}: the run completes; journal, thread and next prompt are masked`, async () => {
      const journal = new InMemoryJournal();
      const memory = new BasicMemory(journal);
      const { model, prompts } = capturing(toolCallingModel({ toolName: 'fetchUser', input: { id: 'u1' }, doneText: 'done' }));
      const r: any = await runDurable({
        runId: 'd1', journal, memory, threadId: 't1', prompt: 'look up u1', model,
        tools: { fetchUser: { execute: async () => { throw mk(); } } },
        processors: [piiRedactor({ redactToolResults: true })],
      } as any);
      expect(r.text).toBe('done');
      const dump: string[] = [];
      for (const k of (journal as any).keys()) dump.push(k + '=' + JSON.stringify(await journal.get(k)));
      expect(dump.join('\n')).not.toContain(EMAIL);
      expect(dump.join('\n')).toContain('[REDACTED_EMAIL]');
      expect(JSON.stringify(await memory.getMessages('t1'))).not.toContain(EMAIL);
      expect(prompts.length).toBe(2);
      expect(JSON.stringify(prompts[1])).not.toContain(EMAIL);
      expect(JSON.stringify(prompts[1])).toContain('[REDACTED_EMAIL]');
    });
  }
});
