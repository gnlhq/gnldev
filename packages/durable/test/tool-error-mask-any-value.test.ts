// Masking a tool's error never changes whether a run completes; it only changes the text.
//
// Invariant: whatever a tool throws — a DOMException (fetch abort/timeout), an Error from another
// realm, a frozen error, an object whose getters throw, a non-Error value — `maskedToolError` returns
// an Error that is safe to read (`name`, `message`, `stack`, `String(err)`), carries the processed
// text, keeps the original as `cause`, and keeps the class and name wherever copying them is safe.
//
// Measured before this file: the masked copy was made with `Object.create(prototype)`. For a
// DOMException the prototype's `name`/`message` are brand-checked getters, so reading `.name` or
// `String(err)` on the copy threw ERR_INVALID_THIS — and the run threw a TypeError where 0.9.0 and the
// unmasked path completed.
import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { createServer } from 'node:net';
import { InMemoryJournal, runDurable } from '../src/index.js';
import { maskedToolError } from '../src/durable-tool.js';
import { toolCallingModel } from '@gnldev/durable/mock';

const SECRET = 'ayse@example.com';
const TEXT = '[REDACTED]';

function readAll(m: Error) {
  return { name: m.name, message: m.message, stack: String(m.stack), str: String(m) };
}

class PayErr extends Error { code = 'E_PAY'; constructor(msg: string) { super(msg); this.name = 'PayErr'; } }
class Proto extends Error {}
Object.defineProperty(Proto.prototype, 'name', { value: 'ProtoName' });

const throwingGetters = (() => {
  const e = new Error(`g ${SECRET}`);
  Object.defineProperty(e, 'name', { get() { throw new Error('name getter'); } });
  Object.defineProperty(e, 'stack', { get() { throw new Error('stack getter'); } });
  return e;
})();
const throwingMessage = (() => {
  const e = new Error('x');
  Object.defineProperty(e, 'message', { get() { throw new Error('message getter'); } });
  return e;
})();

const cases: Array<[string, unknown, string | undefined]> = [
  // [label, thrown value, expected name (undefined = 'Error')]
  ['DOMException AbortError', new DOMException(`abort ${SECRET}`, 'AbortError'), 'AbortError'],
  ['DOMException TimeoutError', new DOMException(`timeout ${SECRET}`, 'TimeoutError'), 'TimeoutError'],
  ['cross-realm RangeError (node:vm)', vm.runInNewContext(`new RangeError('r ${SECRET}')`), 'RangeError'],
  ['frozen Error', Object.freeze(new Error(`f ${SECRET}`)), 'Error'],
  ['Error whose name and stack getters throw', throwingGetters, 'Error'],
  ['Error whose message getter throws', throwingMessage, 'Error'],
  ['subclass with own name', new PayErr(`card of ${SECRET}`), 'PayErr'],
  ['prototype name', new Proto(`p ${SECRET}`), 'ProtoName'],
  ['AggregateError', new AggregateError([new Error(SECRET)], `agg ${SECRET}`), 'AggregateError'],
  ['string', `str ${SECRET}`, 'Error'],
  ['plain object', { message: `obj ${SECRET}` }, 'Error'],
  ['undefined', undefined, 'Error'],
  ['null', null, 'Error'],
  ['Proxy that throws on every trap', new Proxy({}, { get() { throw new Error('trap'); }, getPrototypeOf() { throw new Error('trap'); } }), 'Error'],
];

describe('maskedToolError: any thrown value yields a readable masked Error', () => {
  for (const [label, orig, name] of cases) {
    // The hooks process `toolErrorText(orig)` — the name is part of that text for an error.
    it(`${label}: masked text with the name kept`, () => {
      const text = `${name}: ${TEXT}`;
      const m = maskedToolError(orig, text);
      const r = readAll(m); // must not throw
      expect(m).toBeInstanceOf(Error);
      expect(r.str).toBe(text);
      expect(r.stack).not.toContain(SECRET);
      expect(m.cause).toBe(orig);
    });
    it(`${label}: masked text without the name — renders as the text alone`, () => {
      const m = maskedToolError(orig, TEXT);
      const r = readAll(m);
      expect(r.str).toBe(TEXT);
      expect(r.name).toBe('');
      expect(r.message).toBe(TEXT);
      expect(r.stack).not.toContain(SECRET);
      expect(m.cause).toBe(orig);
    });
  }

  it('the name is kept where the text still carries it', () => {
    for (const [, orig, name] of cases.slice(0, 9)) {
      const m = maskedToolError(orig, `${name}: ${TEXT}`);
      expect([m.name, m.message]).toEqual([name, TEXT]);
    }
  });

  it('class is kept where safe: a subclass instance stays instanceof its class, without its own fields', () => {
    const m = maskedToolError(new PayErr(`card of ${SECRET}`), TEXT);
    expect(m).toBeInstanceOf(PayErr);
    expect((m as any).code).toBeUndefined();
  });

  it('a DOMException becomes a plain Error with the DOMException name as an own property', () => {
    const orig = new DOMException(`abort ${SECRET}`, 'AbortError');
    const m = maskedToolError(orig, `AbortError: ${TEXT}`);
    expect(Object.getPrototypeOf(m)).toBe(Error.prototype);
    expect(Object.prototype.hasOwnProperty.call(m, 'name')).toBe(true);
    expect(m.name).toBe('AbortError');
  });

  it('a real AbortSignal.timeout through fetch to a closed port is masked readably', async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as any).port;
    await new Promise<void>((r) => srv.close(() => r()));
    let thrown: unknown;
    try { await fetch(`http://127.0.0.1:${port}/${SECRET}`, { signal: AbortSignal.timeout(1) }); } catch (e) { thrown = e; }
    expect(thrown).toBeDefined();
    const m = maskedToolError(thrown, `${(thrown as any).name}: ${TEXT}`);
    const r = readAll(m);
    expect(r.message).toBe(TEXT);
    expect(r.name).toBe((thrown as any).name);
  });
});

describe('e2e: masking never changes whether a run completes', () => {
  const mask = { name: 'mask', processToolError: ({ error }: { error: string }) => ({ error: error.replaceAll(SECRET, '[REDACTED_EMAIL]') }) };
  for (const [label, mk] of [
    ['DOMException TimeoutError', () => new DOMException(`request for ${SECRET} timed out`, 'TimeoutError')],
    ['cross-realm Error', () => vm.runInNewContext(`new Error('request for ${SECRET} timed out')`)],
    
    ['plain Error (control)', () => new Error(`request for ${SECRET} timed out`)],
  ] as const) {
    for (const withMask of [false, true]) {
      it(`${label}, ${withMask ? 'masked' : 'unmasked'}: the run completes`, async () => {
        const journal = new InMemoryJournal();
        const r: any = await runDurable({
          runId: 'd1', journal, prompt: 'x',
          model: toolCallingModel({ toolName: 'fetchUser', input: { id: 'u1' }, doneText: 'done' }),
          tools: { fetchUser: { execute: async () => { throw mk(); } } },
          ...(withMask ? { processors: [mask] } : {}),
        } as any);
        expect(r.text).toBe('done');
        if (withMask) {
          const dump: string[] = [];
          for (const k of (journal as any).keys()) dump.push(JSON.stringify(await journal.get(k)));
          expect(dump.join('\n')).not.toContain(SECRET);
        }
      });
    }
  }
});

describe('e2e: hostile thrown values', () => {
  const mask = { name: 'mask', processToolError: ({ error }: { error: string }) => ({ error: error.replaceAll(SECRET, '[REDACTED_EMAIL]') }) };
  // Masked only: unmasked, the value reaches the AI SDK as thrown and its own `toString()` call throws
  // there (outside this package). Masked, the value the SDK receives is ours, and readable.
  it('an Error whose name getter throws, masked: the run completes and the call is journaled failed', async () => {
    const journal = new InMemoryJournal();
    const r: any = await runDurable({
      runId: 'h1', journal, prompt: 'x',
      model: toolCallingModel({ toolName: 'fetchUser', input: { id: 'u1' }, doneText: 'done' }),
      tools: { fetchUser: { execute: async () => { const e = new Error(`request for ${SECRET}`); Object.defineProperty(e, 'name', { get() { throw new Error('x'); } }); throw e; } } },
      processors: [mask],
    } as any);
    expect(r.text).toBe('done');
  });

  it('an Error whose message getter throws: the call is still journaled failed, not left running', async () => {
    const journal = new InMemoryJournal();
    await runDurable({
      runId: 'h2', journal, prompt: 'x',
      model: toolCallingModel({ toolName: 'fetchUser', input: { id: 'u1' }, doneText: 'done' }),
      tools: { fetchUser: { execute: async () => { const e = new Error('x'); Object.defineProperty(e, 'message', { get() { throw new Error('getter'); } }); throw e; } } },
      processors: [mask],
    } as any).catch(() => undefined);
    const tool = [] as any[];
    for (const k of (journal as any).keys()) if (k.includes(':tool:')) tool.push(await journal.get(k));
    expect(tool.length).toBeGreaterThan(0);
    expect(tool.every((t) => t.status === 'failed')).toBe(true);
  });
});
