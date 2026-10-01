// piiRedactor({ redactToolResults: true }) on STRUCTURED tool output.
//
// Invariant: redaction of a structured value never fails open. The value that reaches the journal
// either has every string leaf (and key) run through the patterns, or is replaced by a marker —
// never the original, unredacted, with no report.
//
// Measured before this file: object output was redacted as JSON TEXT (stringify → redact → parse).
// `phone` masks bare 7–15 digit runs in text, by design, so any JSON NUMBER of that length (an epoch-ms
// timestamp, a numeric id, a coordinate like 41.0082376) became `[REDACTED_PHONE]` inside the JSON,
// the parse failed, and the ORIGINAL object — email and all — was returned and journaled in plaintext.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal, runDurable, createProcessorCtx, readProcessorReports } from '@gnldev/durable';
import { toolCallingModel } from '@gnldev/durable/mock';
import { piiRedactor } from '../src/pii.js';
import { PII_PATTERNS, compileRedactions } from '../src/redact.js';

const EMAIL = 'ayse@acme.com';
const ctx = () => createProcessorCtx(new InMemoryJournal(), 'r');
const run = async (output: unknown, opts: Parameters<typeof piiRedactor>[0] = { redactToolResults: true }, toolName = 't') =>
  (await piiRedactor(opts).processToolResult!({ toolName, toolCallId: 'c', input: {}, output }, ctx())).output;

async function journalText(journal: InMemoryJournal): Promise<string> {
  const out: Record<string, unknown> = {};
  for (const k of (journal as any).keys()) out[k] = await journal.get(k);
  return JSON.stringify(out);
}

describe('piiRedactor redactToolResults — structured output never fails open', () => {
  it('an object holding an email AND an epoch-ms number: the email is masked, the number stays a number', async () => {
    expect(await run({ email: EMAIL, createdAt: 1727712000000 })).toEqual({ email: '[REDACTED_EMAIL]', createdAt: 1727712000000 });
  });

  it('floats, numeric ids, booleans and null survive untouched beside a masked leaf', async () => {
    expect(await run({ lat: 41.0082376, id: 98765432, ok: true, none: null, email: EMAIL }))
      .toEqual({ lat: 41.0082376, id: 98765432, ok: true, none: null, email: '[REDACTED_EMAIL]' });
  });

  it('end-to-end in runDurable: the journal never holds the plaintext email', async () => {
    const journal = new InMemoryJournal();
    await runDurable({
      runId: 'c1-e2e', journal, prompt: 'look up u1',
      model: toolCallingModel({ toolName: 'lookupUser', input: { id: 'u1' }, doneText: 'done' }),
      tools: { lookupUser: { execute: async () => ({ email: EMAIL, createdAt: 1727712000000 }) } },
      processors: [piiRedactor({ redactToolResults: true })],
    } as any);
    const dump = await journalText(journal);
    expect(dump).toContain('lookupUser');
    expect(dump).toContain('[REDACTED_EMAIL]');
    expect(dump).toContain('1727712000000');
    expect(dump).not.toContain(EMAIL);
  });

  // ── siblings ──────────────────────────────────────────────────────────────────────────────────
  it('nested arrays and objects are walked to every leaf', async () => {
    expect(await run({ users: [{ contact: { mail: EMAIL, ts: 1727712000000 } }, [EMAIL, 7, 'ip 10.0.0.1']] }))
      .toEqual({ users: [{ contact: { mail: '[REDACTED_EMAIL]', ts: 1727712000000 } }, ['[REDACTED_EMAIL]', 7, 'ip [REDACTED_IP]']] });
  });

  it('a KEY that is PII is masked too, and two keys masked to the same text do not overwrite each other', async () => {
    const out = await run({ [EMAIL]: { plan: 'pro' }, 'b@c.io': { plan: 'free' } }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain(EMAIL);
    expect(JSON.stringify(out)).not.toContain('b@c.io');
    expect(Object.values(out)).toEqual([{ plan: 'pro' }, { plan: 'free' }]);
    expect(Object.keys(out)).toEqual(['[REDACTED_EMAIL]', '[REDACTED_EMAIL]#2']);
  });

  it('a Date is journaled as its JSON text (what the journal stores), a BigInt stays a BigInt', async () => {
    const out = await run({ at: new Date('2024-09-30T00:00:00.000Z'), big: 12345678901234567890n, email: EMAIL }) as any;
    expect(out).toEqual({ at: '2024-09-30T00:00:00.000Z', big: 12345678901234567890n, email: '[REDACTED_EMAIL]' });
  });

  it('a cyclic object: the back-reference becomes a marker, the rest is still redacted', async () => {
    const circular: any = { email: EMAIL, n: 1727712000000 };
    circular.self = circular;
    const out = await run(circular) as any;
    expect(out).toEqual({ email: '[REDACTED_EMAIL]', n: 1727712000000, self: '[Circular]' });
    expect(out).not.toBe(circular);
  });

  it('a value that cannot be walked FAILS CLOSED: a marker replaces it, naming the way through', async () => {
    const hostile = { email: EMAIL, get boom() { throw new Error(`leaks ${EMAIL}`); } };
    const out = await run(hostile, { redactToolResults: true }, 'lookupUser');
    expect(typeof out).toBe('string');
    expect(out).not.toContain(EMAIL);
    expect(out).toContain("redactToolResults: { skipTools: ['lookupUser'] }");
  });

  it('the way through: a tool named in skipTools is journaled as it returned', async () => {
    const hostile = { email: EMAIL, get boom() { throw new Error('x'); } };
    expect(await run(hostile, { redactToolResults: { skipTools: ['lookupUser'] } }, 'lookupUser')).toBe(hostile);
    // …and only that tool: every other tool is still redacted.
    expect(await run({ email: EMAIL }, { redactToolResults: { skipTools: ['lookupUser'] } }, 'other')).toEqual({ email: '[REDACTED_EMAIL]' });
  });

  it('a very large output (10k rows) is redacted in full', async () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => ({ id: 1_000_000_000 + i, email: `u${i}@acme.com` }));
    const out = await run({ rows }) as any;
    expect(out.rows).toHaveLength(10_000);
    expect(JSON.stringify(out)).not.toMatch(/@acme\.com/);
    expect(out.rows[9_999]).toEqual({ id: 1_000_009_999, email: '[REDACTED_EMAIL]' });
  });

  it('a structure too deep to recurse fails closed instead of passing through', async () => {
    let deep: any = { email: EMAIL };
    for (let i = 0; i < 200_000; i++) deep = { next: deep };
    const out = await run(deep, { redactToolResults: true }, 'crawl');
    expect(out).toMatch(/^\[REDACTED_TOOL_RESULT: .*RangeError.*skipTools: \['crawl'\]/);
  });

  it('a string output that is JSON text is redacted as text — masked, never returned unredacted', async () => {
    const out = await run(JSON.stringify({ email: EMAIL, createdAt: 1727712000000 }));
    expect(typeof out).toBe('string');
    expect(out).not.toContain(EMAIL);
  });

  it('the audit report names each redacted path', async () => {
    const journal = new InMemoryJournal();
    const c = createProcessorCtx(journal, 'run-paths');
    await piiRedactor({ redactToolResults: true }).processToolResult!(
      { toolName: 't', toolCallId: 'c', input: {}, output: { a: { email: EMAIL }, list: ['ip 10.0.0.1'], ts: 1727712000000 } }, c,
    );
    const reports = await readProcessorReports(journal, 'run-paths');
    expect(reports).toEqual([expect.objectContaining({
      phase: 'tool',
      findings: { redactedCount: 2, types: ['email', 'ip'], paths: ['$.a.email', '$.list[0]'] },
    })]);
  });
});

// Round 2. Invariant (K1): the walker's OUTPUT holds no text the patterns did not see. The journal
// stores that output with superjson, so the walker models what superjson would store — not what
// Object.keys happens to return. Three shapes broke it, all measured on the round-1 walker:
//   - a boxed `new String(email)` has index keys, so it came back {"0":"a","1":"y",…}: one char per
//     key, no pattern can match a single character, the address reached the journal, no report;
//   - a Buffer's toJSON hands over its bytes as numbers, and a typed array's index keys are numbers:
//     the email reached the journal as bytes;
//   - a Map/Set has no own keys, so it came back {} — no leak, but the data was silently gone,
//     although superjson journals a Map with its contents.
describe('piiRedactor redactToolResults — what the journal would store is what gets walked', () => {
  const charsOf = (v: unknown): string => JSON.stringify(v, (_k, x) => (x instanceof Map ? [...x] : x instanceof Set ? [...x] : x));

  it('a boxed String is unwrapped and redacted as text — top level, nested, and returned by toJSON', async () => {
    expect(await run(new String(EMAIL))).toBe('[REDACTED_EMAIL]');
    expect(await run({ e: new String(EMAIL) })).toEqual({ e: '[REDACTED_EMAIL]' });
    expect(await run({ e: { toJSON: () => new String(EMAIL) } })).toEqual({ e: '[REDACTED_EMAIL]' });
    expect(await run([new String(`mail ${EMAIL}`)])).toEqual(['mail [REDACTED_EMAIL]']);
  });

  it('boxed Number and Boolean become the primitives JSON.stringify would write', async () => {
    expect(await run({ n: new Number(1727712000000), b: new Boolean(false) })).toEqual({ n: 1727712000000, b: false });
  });

  it('binary data (Buffer, typed arrays, DataView) is withheld with a marker — the bytes never reach the journal', async () => {
    for (const bin of [Buffer.from(EMAIL), new TextEncoder().encode(EMAIL), new DataView(new TextEncoder().encode(EMAIL).buffer)]) {
      const out = await run({ file: bin, name: 'x.txt' }, { redactToolResults: true }, 'download') as any;
      expect(out.name).toBe('x.txt');
      expect(typeof out.file).toBe('string');
      expect(out.file).toContain("skipTools: ['download']");
      expect(charsOf(out)).not.toMatch(/97,121,115,101|"0":97/);
    }
    // top level: the whole output is the binary, so the whole output is the marker
    expect(await run(Buffer.from(EMAIL))).toMatch(/^\[REDACTED_TOOL_RESULT: /);
  });

  it('a Map and a Set keep their data, masked, as superjson would journal them', async () => {
    expect(await run({ m: new Map([['k', 'v'], ['email', EMAIL]]) })).toEqual({ m: new Map([['k', 'v'], ['email', '[REDACTED_EMAIL]']]) });
    expect(await run(new Set([EMAIL, 'plain']))).toEqual(new Set(['[REDACTED_EMAIL]', 'plain']));
    // a Map KEY that is PII is masked too
    const keyed = await run(new Map([[EMAIL, 1]])) as Map<string, number>;
    expect([...keyed.keys()]).toEqual(['[REDACTED_EMAIL]']);
  });

  it('the fail-closed marker and warning carry a fixed label, never the thrown error\'s own name or message', async () => {
    class Named extends Error { constructor() { super(`m ${EMAIL}`); this.name = EMAIL; } }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await run({ get x() { throw new Named(); } });
      expect(out).toMatch(/^\[REDACTED_TOOL_RESULT: /);
      expect(out).not.toContain(EMAIL);
      expect(out).toContain('(Error)');
      expect(warn.mock.calls.flat().join(' ')).not.toContain(EMAIL);
      expect(await run({ get x() { throw EMAIL; } })).not.toContain(EMAIL);
    } finally {
      warn.mockRestore();
    }
  });

  it('a tag that only CLAIMS to be a String (Symbol.toStringTag) is walked as the object it is', async () => {
    expect(await run({ [Symbol.toStringTag]: 'String', mail: EMAIL })).toEqual({ mail: '[REDACTED_EMAIL]' });
  });

  it('a key repeated across rows is masked on every row and every path is reported', async () => {
    const journal = new InMemoryJournal();
    const c = createProcessorCtx(journal, 'run-rows');
    const out = await piiRedactor({ redactToolResults: true }).processToolResult!(
      { toolName: 't', toolCallId: 'c', input: {}, output: [{ [EMAIL]: 1 }, { [EMAIL]: 2 }] }, c,
    );
    expect(out.output).toEqual([{ '[REDACTED_EMAIL]': 1 }, { '[REDACTED_EMAIL]': 2 }]);
    const [report] = await readProcessorReports(journal, 'run-rows');
    expect((report!.findings as any).paths).toEqual(['$[0]["[REDACTED_EMAIL]"]', '$[1]["[REDACTED_EMAIL]"]']);
  });
});

// Invariant (K1): with redactToolResults, a tool's PII never reaches the journal in plaintext — on the
// ERROR path too. A tool that throws `Error('no account for ayse@acme.com')` journaled the message in
// `<run>:tool:<id>` {"status":"failed","error":…}; no processor was ever consulted about it.
describe('piiRedactor redactToolResults — the tool error path', () => {
  const e2e = async (execute: () => Promise<unknown>, opts: Parameters<typeof piiRedactor>[0] = { redactToolResults: true }) => {
    const journal = new InMemoryJournal();
    await runDurable({
      runId: 'err', journal, prompt: 'look up u1',
      model: toolCallingModel({ toolName: 'lookupUser', input: { id: 'u1' }, doneText: 'done' }),
      tools: { lookupUser: { execute } },
      processors: [piiRedactor(opts)],
    } as any).catch(() => undefined);
    return { journal, dump: await journalText(journal) };
  };

  it('a thrown error\'s message is journaled masked, and the failure is still recorded as failed', async () => {
    const { journal, dump } = await e2e(async () => { throw new Error(`no account for ${EMAIL}`); });
    expect(dump).not.toContain(EMAIL);
    const rec = await journal.get<any>('err:tool:call-1');
    expect(rec).toMatchObject({ status: 'failed', error: 'Error: no account for [REDACTED_EMAIL]' });
    const reports = await readProcessorReports(journal, 'err');
    expect(reports).toEqual([expect.objectContaining({ phase: 'tool', findings: expect.objectContaining({ redactedCount: 1, types: ['email'] }) })]);
  });

  it('a thrown non-Error value (a bare string) is masked the same way', async () => {
    const { dump } = await e2e(async () => { throw `lookup failed for ${EMAIL}`; });
    expect(dump).not.toContain(EMAIL);
  });

  it('skipTools journals that tool\'s error as thrown, as it does its output', async () => {
    const { journal } = await e2e(async () => { throw new Error(`no account for ${EMAIL}`); }, { redactToolResults: { skipTools: ['lookupUser'] } });
    expect(await journal.get<any>('err:tool:call-1')).toMatchObject({ error: `Error: no account for ${EMAIL}` });
  });
});

// The walker runs the patterns on every key and leaf, so they are compiled once per redactor
// (`compileRedactions`) and a string that holds neither a digit nor `@` skips the built-ins. That skip
// is only sound while every built-in match needs one of those characters — pinned here, so a new
// built-in that breaks the premise fails a test instead of silently never matching inside a tool result.
describe('compileRedactions — the shortcut the walker relies on', () => {
  it('no built-in pattern matches text free of digits and `@`', () => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ .-_+()/:#[]{}\'"\n\tçğışöüÇĞİŞÖÜ';
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let n = 0; n < 5000; n++) {
      let s = '';
      for (let i = 0, len = 1 + Math.floor(rnd() * 60); i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      for (const [type, re] of Object.entries(PII_PATTERNS)) {
        expect(new RegExp(re.source, re.flags.replace('g', '')).test(s), `${type} matched ${JSON.stringify(s)}`).toBe(false);
      }
    }
  });

  it('custom patterns are not skipped by it: a digit-free custom match is still masked in a tool result', async () => {
    expect(await run({ token: 'key secret-abc' }, { redactToolResults: true, extraPatterns: [{ name: 'secret', pattern: /secret-[a-z]+/g }] }))
      .toEqual({ token: 'key [REDACTED_SECRET]' });
  });

  it('a custom test that throws half-way does not leave the shared regex mid-text for the next string', async () => {
    let calls = 0;
    const redactText = compileRedactions(['email'], (t) => `[${t}]`, {
      extra: [{ name: 'id', pattern: /ID\d+/g, test: () => { if (calls++ === 0) throw new Error('once'); return true; } }],
    });
    expect(() => redactText('ID1 ID2')).toThrow('once');
    expect(redactText('ID3 x@y.io')).toEqual({ text: '[REDACTED_ID] [email]', total: 2, types: ['id', 'email'] });
  });
});

// Sibling (K1, the hook itself): a processToolError hook that throws must not leave the raw text
// behind it — durable-tool journals a fixed "withheld" text instead.
describe('processToolError — a hook that throws fails closed', () => {
  it('the journal holds a fixed text, not the thrown error\'s message', async () => {
    const journal = new InMemoryJournal();
    await runDurable({
      runId: 'hook-throws', journal, prompt: 'look up u1',
      model: toolCallingModel({ toolName: 'lookupUser', input: { id: 'u1' }, doneText: 'done' }),
      tools: { lookupUser: { execute: async () => { throw new Error(`no account for ${EMAIL}`); } } },
      processors: [{ name: 'broken', processToolError: () => { throw new Error('redactor bug'); } }],
    } as any).catch(() => undefined);
    const rec = await journal.get<any>('hook-throws:tool:call-1');
    expect(rec.status).toBe('failed');
    expect(rec.error).toMatch(/^\[tool error withheld: a processToolError hook threw/);
    expect(await journalText(journal)).not.toContain(EMAIL);
  });
});

// A thrown tool error is masked ONCE, at its source (durable-tool), so every later copy is the
// masked one. Measured before: the journal's tool record was redacted, but the error was rethrown
// untouched — the model's next prompt and the thread log (BasicMemory's `mem:<t>:messages`, in the
// same journal) carried the raw address.
describe('processToolError — the text the model and the thread see is the redacted one', () => {
  it('BasicMemory in the same journal: no key holds the thrown address, and neither does the next prompt', async () => {
    const { BasicMemory } = await import('@gnldev/durable');
    const journal = new InMemoryJournal();
    const prompts: string[] = [];
    const model = toolCallingModel({ toolName: 'lookupUser', input: { id: 'u1' }, doneText: 'done' });
    const generate = model.doGenerate.bind(model);
    model.doGenerate = async (o: any) => { prompts.push(JSON.stringify(o.prompt)); return generate(o); };
    await runDurable({
      runId: 'basic-mem', journal, prompt: 'look up u1', threadId: 't1', memory: new BasicMemory(journal),
      model, tools: { lookupUser: { execute: async () => { throw new Error(`no account for ${EMAIL}`); } } },
      processors: [piiRedactor({ redactToolResults: true })],
    } as any);
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts.join('\n')).toContain('no account for [REDACTED_EMAIL]');
    expect(prompts.join('\n')).not.toContain(EMAIL);
    expect(await journalText(journal)).not.toContain(EMAIL);
  });

  it('skipTools: the tool\'s error reaches the model as thrown (nothing was changed, nothing is re-made)', async () => {
    const journal = new InMemoryJournal();
    const prompts: string[] = [];
    const model = toolCallingModel({ toolName: 'lookupUser', input: { id: 'u1' }, doneText: 'done' });
    const generate = model.doGenerate.bind(model);
    model.doGenerate = async (o: any) => { prompts.push(JSON.stringify(o.prompt)); return generate(o); };
    await runDurable({
      runId: 'skip', journal, prompt: 'look up u1', model,
      tools: { lookupUser: { execute: async () => { throw new Error(`no account for ${EMAIL}`); } } },
      processors: [piiRedactor({ redactToolResults: { skipTools: ['lookupUser'] } })],
    } as any);
    expect(prompts.join('\n')).toContain(EMAIL);
  });
});
