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
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runDurable, createProcessorCtx, readProcessorReports } from '@gnldev/durable';
import { toolCallingModel } from '@gnldev/durable/mock';
import { piiRedactor } from '../src/pii.js';

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
