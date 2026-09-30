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
import { applyToolCompat, shapeToolDefinitions, defaultRules, type ToolSchemaRule } from '../src/index.js';

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

// Round 2. Invariant (K1): a value a well-behaved model sends under the schema it was TOLD validates
// as the original reads it. The reading of an invited null used to be written by hand, separately
// from the rule that invites it, and guessed from the ORIGINAL schema — and that guess only descended
// into a union with exactly one non-null branch. So inside a discriminatedUnion or a z.union of
// objects, the null the model was told to send was refused (measured: `{ kind: 'a', note: null }`
// failed validation although the schema sent said `note: string | null`). The rule now records each
// node it widens, and the inverse reads those records off the schema that was sent.
describe('the null the OpenAI rule invites, inside unions', () => {
  const act = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('a'), note: z.string().optional() }),
    z.object({ kind: z.literal('b'), n: z.number().optional() }),
  ]);

  it('discriminated union: the branch the value is in reads null as absent', async () => {
    const told = JSON.stringify(patched(z.object({ act })).jsonSchema);
    expect(told).toContain('null');
    expect(await check(z.object({ act }), { act: { kind: 'a', note: null } })).toEqual({ success: true, value: { act: { kind: 'a' } } });
    expect(await check(z.object({ act }), { act: { kind: 'b', n: null } })).toEqual({ success: true, value: { act: { kind: 'b' } } });
  });

  it('plain z.union of objects: the value\'s own keys pick the branch', async () => {
    const q = z.union([z.object({ a: z.string(), x: z.string().optional() }), z.object({ b: z.number(), y: z.number().optional() })]);
    expect(await check(z.object({ q }), { q: { b: 1, y: null } })).toEqual({ success: true, value: { q: { b: 1 } } });
    expect(await check(z.object({ q }), { q: { a: 's', x: null } })).toEqual({ success: true, value: { q: { a: 's' } } });
  });

  it('nested unions: a union inside a union branch', async () => {
    const inner = z.union([z.object({ c: z.string(), note: z.string().optional() }), z.object({ d: z.number() })]);
    const outer = z.discriminatedUnion('kind', [z.object({ kind: z.literal('x'), inner }), z.object({ kind: z.literal('y') })]);
    expect(await check(z.object({ outer }), { outer: { kind: 'x', inner: { c: 'k', note: null } } }))
      .toEqual({ success: true, value: { outer: { kind: 'x', inner: { c: 'k' } } } });
  });

  it('an array of unions: each item reads its own branch', async () => {
    const list = z.array(act);
    expect(await check(z.object({ list }), { list: [{ kind: 'a', note: null }, { kind: 'b', n: 3 }, { kind: 'b', n: null }] }))
      .toEqual({ success: true, value: { list: [{ kind: 'a' }, { kind: 'b', n: 3 }, { kind: 'b' }] } });
  });

  it('a null the author allowed in one branch stays null there', async () => {
    const u = z.union([z.object({ a: z.string(), note: z.string().nullable() }), z.object({ b: z.number(), note: z.string().optional() })]);
    expect(await check(z.object({ u }), { u: { a: 's', note: null } })).toEqual({ success: true, value: { u: { a: 's', note: null } } });
  });

  it('a null at a key no branch widened is still an error', async () => {
    expect((await check(z.object({ act }), { act: null })).success).toBe(false);
    expect((await check(z.object({ act }), { act: { kind: null } })).success).toBe(false);
  });
});

// The same invariant for rules this package does not ship: a custom rule that widens a node says so
// through the context the pipeline hands it, and the inverse reads that record — nothing about the
// custom rule has to be known here.
describe('a custom rule records what it widens', () => {
  const makeNullable: ToolSchemaRule = {
    name: 'nullable-limit',
    shouldApply: () => true,
    transform(schema, _model, ctx) {
      const limit = schema.properties?.limit;
      if (limit) {
        limit.type = [limit.type, 'null'];
        schema.required = [...(schema.required ?? []), 'limit'];
        ctx?.nullMeansAbsent(limit);
      }
      return schema;
    },
  };

  it('its null is read as absent, and .default() then fills the key', async () => {
    const t = tool({ description: 'd', inputSchema: z.object({ q: z.string(), limit: z.number().default(10) }), execute: async () => 'ok' });
    const s = asSchema(applyToolCompat({ t }, 'custom/model', [makeNullable]).t.inputSchema as any);
    expect(await s.validate!({ q: 'x', limit: null })).toEqual({ success: true, value: { q: 'x', limit: 10 } });
  });
});

// Invariant (K3, the narrowing names its way through): `strict: true` plus an open object is a schema
// OpenAI refuses at request time — with no GNL message. The OpenAI rule leaves an open object open
// (closing it told the model a map takes no keys), so under strict it now refuses the tool itself,
// before the model is called, naming both ways through.
describe('strict: true with an open object under the OpenAI rule', () => {
  const rec = (inputSchema: any) => ({ description: 'm', strict: true, inputSchema, execute: async (a: unknown) => a });

  it('applyToolCompat refuses it, naming both ways through', () => {
    expect(() => applyToolCompat({ rec: rec(z.object({ tags: z.record(z.string(), z.number()) })) }, OPENAI, defaultRules))
      .toThrow(/tool 'rec'.*strict: true.*declare the keys with z\.object, or drop strict/s);
  });

  it('the same for catchall and a loose object', () => {
    expect(() => applyToolCompat({ rec: rec(z.object({ a: z.string() }).catchall(z.string())) }, OPENAI, defaultRules)).toThrow(/drop strict/);
    expect(() => applyToolCompat({ rec: rec(z.object({ a: z.string() }).passthrough()) }, OPENAI, defaultRules)).toThrow(/drop strict/);
  });

  it('shapeToolDefinitions (the chain path) refuses it the same way', () => {
    const defs = [{ type: 'function', name: 'rec', strict: true, inputSchema: { type: 'object', properties: { tags: { type: 'object', additionalProperties: { type: 'number' } } }, required: ['tags'] } }];
    expect(() => shapeToolDefinitions(defs, OPENAI, defaultRules)).toThrow(/tool 'rec'.*drop strict/s);
  });

  it('the ways through work: no strict, or declared keys', () => {
    const open = { ...rec(z.object({ tags: z.record(z.string(), z.number()) })), strict: undefined };
    expect(() => applyToolCompat({ open }, OPENAI, defaultRules)).not.toThrow();
    expect(() => applyToolCompat({ rec: rec(z.object({ tags: z.object({ a: z.number() }) })) }, OPENAI, defaultRules)).not.toThrow();
  });

  it('other providers are not affected by the OpenAI refusal', () => {
    expect(() => applyToolCompat({ rec: rec(z.object({ tags: z.record(z.string(), z.number()) })) }, GEMINI, defaultRules)).not.toThrow();
  });
});
