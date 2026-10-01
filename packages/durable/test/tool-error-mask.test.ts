// A tool's thrown error is masked ONCE, where it is thrown.
//
// Invariant: when a `processToolError` hook changed the text, every copy of the error that leaves
// durable-tool carries the processed text — the journal record AND the error the AI SDK receives
// (which becomes the model's next prompt, the thread's tool message and the stream's `tool-error`
// event). The original is kept in-process only, as `cause`.
//
// Measured before this file: the journal record was redacted, but the error was "rethrown untouched",
// so the raw text reached the model, the thread log and GET /threads/:id/messages.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/index.js';
import { durableTools, toolErrorText } from '../src/durable-tool.js';

const EMAIL = 'ayse@acme.com';
const mask = { name: 'mask', processToolError: ({ error }: { error: string }) => ({ error: error.replaceAll(EMAIL, '[REDACTED_EMAIL]') }) };
const opts = { toolCallId: 'c1', messages: [] } as any;

class NotFoundError extends Error {
  code = 'E_NOT_FOUND';
  constructor(message: string) { super(message); this.name = 'NotFoundError'; }
}

async function thrownBy(execute: () => Promise<unknown>, processors: unknown[] = [mask]) {
  const journal = new InMemoryJournal();
  const tools = durableTools({ lookupUser: { execute } } as any, { journal, runId: 'r', toolResultProcessors: processors } as any);
  let thrown: any;
  try { await (tools as any).lookupUser.execute({ id: 'u1' }, opts); } catch (e) { thrown = e; }
  return { thrown, record: await journal.get<any>('r:tool:c1') };
}

describe('a thrown tool error is masked at its source', () => {
  it('the error that leaves the tool carries the processed text; the original is its cause', async () => {
    const original = new NotFoundError(`no account for ${EMAIL}`);
    const { thrown, record } = await thrownBy(async () => { throw original; });
    // The text is what the AI SDK renders for an Error — `String(error)`, so the name is in it.
    expect(record.error).toBe('NotFoundError: no account for [REDACTED_EMAIL]');
    expect(String(thrown)).toBe(record.error);
    expect(thrown.message).toBe('no account for [REDACTED_EMAIL]');
    expect(thrown).toBeInstanceOf(NotFoundError);
    expect(thrown.name).toBe('NotFoundError');
    expect(thrown.cause).toBe(original);
    expect(String(thrown.stack)).not.toContain(EMAIL);
    // Own properties are not copied — they are as likely as the message to hold the value.
    expect(thrown.code).toBeUndefined();
    expect(thrown.cause.code).toBe('E_NOT_FOUND');
  });

  it('a hook that did not change the text leaves the error exactly as thrown (same object)', async () => {
    const original = new Error('timeout talking to the directory');
    const { thrown } = await thrownBy(async () => { throw original; });
    expect(thrown).toBe(original);
  });

  it('no processor: the error is rethrown untouched', async () => {
    const original = new Error(`no account for ${EMAIL}`);
    const { thrown, record } = await thrownBy(async () => { throw original; }, []);
    expect(thrown).toBe(original);
    expect(record.error).toBe(`Error: no account for ${EMAIL}`);
  });

  it('a thrown non-Error value is replaced by an Error holding the processed text', async () => {
    const { thrown } = await thrownBy(async () => { throw `no account for ${EMAIL}`; });
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toBe('no account for [REDACTED_EMAIL]');
    expect(thrown.cause).toBe(`no account for ${EMAIL}`);
  });

  it('a hook that throws: the record AND the thrown error carry the fixed withheld text', async () => {
    const { thrown, record } = await thrownBy(async () => { throw new Error(`no account for ${EMAIL}`); },
      [{ name: 'broken', processToolError: () => { throw new Error('redactor bug'); } }]);
    expect(record.error).toMatch(/^\[tool error withheld: a processToolError hook threw/);
    expect(String(thrown)).toBe(record.error);
  });

  // S6: a hook that returns no string used to journal `undefined` (and, after it, crash the next hook).
  it.each([
    ['an empty object', () => ({})],
    ['undefined', () => undefined],
    ['a number', () => ({ error: 42 })],
  ])('a hook returning %s falls back to the fixed withheld text', async (_label, hook) => {
    const { thrown, record } = await thrownBy(async () => { throw new Error(`no account for ${EMAIL}`); },
      [{ name: 'sloppy', processToolError: hook }]);
    expect(typeof record.error).toBe('string');
    expect(record.error).toMatch(/^\[tool error withheld: a processToolError hook returned no text/);
    expect(String(thrown)).toBe(record.error);
    expect(JSON.stringify(record)).not.toContain(EMAIL);
  });
});

// The hooks see the text every consumer renders — not `.message`. Measured before: the hook saw
// `.message` only, so an address in the error's `name`, or in a field of a thrown object, reached the
// thread and the model's next prompt untouched (and the journal held "[object Object]" for objects).
describe('the hooks see the text every consumer renders', () => {
  it('an address in the error NAME is masked; the name is dropped from the copy, the text keeps the masked name', async () => {
    const original = new Error('no such account');
    original.name = `NotFound<${EMAIL}>`;
    const { thrown, record } = await thrownBy(async () => { throw original; });
    expect(record.error).toBe('NotFound<[REDACTED_EMAIL]>: no such account');
    expect(String(thrown)).toBe(record.error);
    expect(thrown.name).toBe('');
    expect(`${String(thrown)} ${String(thrown.stack)}`).not.toContain(EMAIL);
    expect(thrown.cause).toBe(original);
  });

  it('a thrown plain object is rendered as JSON — the hook sees its fields, not "[object Object]"', async () => {
    const original = { code: 'E_NOTFOUND', detail: `no account for ${EMAIL}` };
    const { thrown, record } = await thrownBy(async () => { throw original; });
    expect(record.error).toBe('{"code":"E_NOTFOUND","detail":"no account for [REDACTED_EMAIL]"}');
    expect(String(thrown)).toBe(record.error);
  });

  it('a thrown object with a clean message and an address in another field is masked too', async () => {
    const { thrown, record } = await thrownBy(async () => { throw { message: 'lookup failed', email: EMAIL }; });
    expect(record.error).toBe('{"message":"lookup failed","email":"[REDACTED_EMAIL]"}');
    expect(String(thrown)).toBe(record.error);
  });

  it('an object the SDK cannot render as is (cyclic) is re-made even when no hook changed it', async () => {
    const cyclic: any = { message: 'boom' }; cyclic.self = cyclic;
    expect(toolErrorText(cyclic).rendersAsIs).toBe(false);
    const { thrown, record } = await thrownBy(async () => { throw cyclic; }, []);
    expect(thrown).not.toBe(cyclic);
    expect(String(thrown)).toBe(record.error);
  });

  it.each([
    ['a string', 'plain text', 'plain text'],
    ['undefined', undefined, 'unknown error'],
    ['an Error', new TypeError('bad'), 'TypeError: bad'],
    ['a number', 42, '42'],
  ])('toolErrorText renders %s the way the AI SDK does', (_l, value, text) => {
    expect(toolErrorText(value)).toEqual({ text, rendersAsIs: true });
  });
});
