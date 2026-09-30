// applyToolCompat changes what the MODEL is told, never what the tool ACCEPTS.
//
// Measured before this file: the patched tool's inputSchema was `jsonSchema(js)` with no validator,
// so on every model a rule matched (OpenAI, groq, Gemini, Claude) the AI SDK validated nothing —
// `{ to: 'not-an-email', count: -7 }` reached execute() — and zod's `.default()`/`.transform()` never
// ran, so execute() saw a different value with compat on than off.
//
// One subtlety the fix has to carry: the OpenAI rule makes every property required and widens a
// formerly-optional one to accept `null` (strict mode's only way to say "not supplied"). The original
// validator does not accept that null. So the model is told "send null", and a verbatim validator
// would reject exactly that. A null the ORIGINAL schema would refuse, at a key it does not require,
// is read as "absent" before validating.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { z as z4 } from 'zod4';
import { tool, jsonSchema, asSchema } from 'ai';
import { applyToolCompat, defaultRules } from '../src/index.js';

const OPENAI = { provider: 'openai.chat', modelId: 'gpt-4o' };
const GEMINI = { provider: 'google.generative-ai', modelId: 'gemini-1.5-pro' };

function patched(inputSchema: any, model: unknown = OPENAI) {
  const t = tool({ description: 'd', inputSchema, execute: async () => 'ok' });
  return asSchema(applyToolCompat({ t }, model, defaultRules).t.inputSchema as any);
}
async function check(inputSchema: any, value: unknown, model: unknown = OPENAI) {
  const s = patched(inputSchema, model);
  return s.validate ? await s.validate(value) : { success: 'no-validator' as const };
}

const mail = z.object({
  to: z.string().email(),
  cc: z.string().optional(),
  count: z.number().int().positive(),
  priority: z.enum(['low', 'high']).default('low'),
});

describe('applyToolCompat keeps the tool\'s own validation', () => {
  it('invalid input is rejected (OpenAI rule applied)', async () => {
    const r = await check(mail, { to: 'not-an-email', cc: null, count: -7 });
    expect(r.success).toBe(false);
  });

  it('.default() still fills a missing field', async () => {
    const r = await check(mail, { to: 'a@b.co', cc: 'x@y.co', count: 2 });
    expect(r).toEqual({ success: true, value: { to: 'a@b.co', cc: 'x@y.co', count: 2, priority: 'low' } });
  });

  it('a .transform() still runs', async () => {
    const r = await check(z.object({ name: z.string().transform((s) => s.trim()) }), { name: '  ada ' });
    expect(r).toEqual({ success: true, value: { name: 'ada' } });
  });

  it('the Gemini rule keeps validation too (every rule used to drop it)', async () => {
    expect((await check(mail, { to: 'nope', count: 1 }, GEMINI)).success).toBe(false);
  });

  it('what the MODEL is told is still the patched schema', () => {
    const js = patched(mail).jsonSchema as any;
    expect(js.additionalProperties).toBe(false);
    expect(js.required).toEqual(['to', 'cc', 'count', 'priority']);
    expect(js.properties.to.format).toBeUndefined();
  });
});

describe('the null the OpenAI rule invites is read as "absent"', () => {
  it('null at a widened optional key validates, and the key is absent in the value', async () => {
    const r = await check(mail, { to: 'a@b.co', cc: null, count: 2, priority: null });
    expect(r).toEqual({ success: true, value: { to: 'a@b.co', count: 2, priority: 'low' } });
  });

  it('a field the author made nullable keeps its null', async () => {
    const r = await check(z.object({ note: z.string().nullable().optional() }), { note: null });
    expect(r).toEqual({ success: true, value: { note: null } });
  });

  it('a null at a REQUIRED key is still an error — nothing the rule widened', async () => {
    expect((await check(mail, { to: null, count: 2 })).success).toBe(false);
  });

  it('nested: inside an array of objects, and inside an optional object', async () => {
    const s = z.object({
      items: z.array(z.object({ sku: z.string(), note: z.string().optional() })),
      meta: z.object({ tag: z.string().optional() }).optional(),
    });
    expect(await check(s, { items: [{ sku: 'a', note: null }], meta: { tag: null } }))
      .toEqual({ success: true, value: { items: [{ sku: 'a' }], meta: {} } });
    expect(await check(s, { items: [], meta: null })).toEqual({ success: true, value: { items: [] } });
  });

  it('zod 4 behaves the same', async () => {
    const s = z4.object({ to: z4.string(), cc: z4.string().optional(), n: z4.number().default(1) });
    expect(await check(s, { to: 'a', cc: null, n: null })).toEqual({ success: true, value: { to: 'a', n: 1 } });
    expect((await check(s, { to: 5 })).success).toBe(false);
  });

  it('a jsonSchema() tool with no validator stays unvalidated, but gets the same null → absent reading', async () => {
    const s = jsonSchema({ type: 'object', properties: { q: { type: 'string' }, lang: { type: 'string' } }, required: ['q'] });
    expect(await check(s, { q: 'x', lang: null })).toEqual({ success: true, value: { q: 'x' } });
  });
});

describe('z.record under the OpenAI rule', () => {
  // The rule closed EVERY object node with `additionalProperties: false`, including a record's
  // `additionalProperties: {…}` — so the model was told a map takes no keys at all. A declared-open
  // object is the author's contract; it is left open. (Under `strict: true` OpenAI refuses an open
  // object at request time — loudly, which is better than a map that silently accepts nothing.)
  it('a record stays open, typed by its value schema', () => {
    const js = patched(z.object({ tags: z.record(z.string(), z.number()) })).jsonSchema as any;
    expect(js.properties.tags.additionalProperties).toEqual({ type: 'number' });
  });

  it('a record\'s values are still validated and still get the null reading', async () => {
    const s = z.object({ tags: z.record(z.string(), z.number()) });
    expect(await check(s, { tags: { a: 1 } })).toEqual({ success: true, value: { tags: { a: 1 } } });
    expect((await check(s, { tags: { a: 'x' } })).success).toBe(false);
  });

  it('a plain object is still closed', () => {
    const js = patched(z.object({ o: z.object({ a: z.string() }) })).jsonSchema as any;
    expect(js.properties.o.additionalProperties).toBe(false);
  });
});
