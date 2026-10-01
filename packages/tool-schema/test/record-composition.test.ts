// Invariant: a null a rule invited (`ShapeContext.nullMeansAbsent`) is read as absent whatever the
// rules AFTER it do to the schema — and which union branch a value is in is decided by the schema
// the recording rule returned, not by what later rules left of it.
//
// Measured before this file (review panel, s-a-schema):
//  · S-a6: on Google's OpenAI-compatible endpoint (provider `openai.chat`, model `gemini-*`) both
//    bundled rules apply; the gemini rule deletes `additionalProperties`, the branch picker relied on
//    it, and `{ u: { a, x: null } }` — the null the model was told to send — was refused;
//  · S-a1 / S-a2: a later rule that rebuilds a property by spread, or deep-clones the schema, replaced
//    the node the record was kept by (identity), and every invited null was refused.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { tool, asSchema } from 'ai';
import { applyToolCompat, chainToolCompat, defaultRules, openaiStrict, gemini, type ToolSchemaRule } from '../src/index.js';

const OPENAI = { provider: 'openai.chat', modelId: 'gpt-4o' };
const GEMINI_VIA_OPENAI = { provider: 'openai.chat', modelId: 'gemini-2.0-flash' };
const schema = z.object({ q: z.string(), limit: z.number().optional() });

async function validate(rules: ToolSchemaRule[], inputSchema: any, value: unknown, model = OPENAI) {
  const t = tool({ description: 'd', inputSchema, execute: async () => 'ok' });
  return asSchema(applyToolCompat({ t }, model, rules).t.inputSchema as any).validate!(value);
}

const describeAll: ToolSchemaRule = {
  name: 'describe', shouldApply: () => true,
  transform(s) { for (const k of Object.keys(s.properties ?? {})) s.properties[k] = { ...s.properties[k], description: `arg ${k}` }; return s; },
};
const jsonClone: ToolSchemaRule = { name: 'clone', shouldApply: () => true, transform: (s) => JSON.parse(JSON.stringify(s)) };

describe('the record survives the rules after it', () => {
  it('S-a1: a later rule rebuilds each property by spread', async () => {
    expect(await validate([openaiStrict, describeAll], schema, { q: 'x', limit: null })).toMatchObject({ success: true, value: { q: 'x' } });
  });

  it('S-a2: a later rule deep-clones the schema', async () => {
    expect(await validate([openaiStrict, jsonClone], schema, { q: 'x', limit: null })).toMatchObject({ success: true, value: { q: 'x' } });
  });

  it('S-a6: openai + gemini on an OpenAI-compatible Gemini endpoint — a null inside a union branch', async () => {
    const s = z.object({ q: z.string(), u: z.union([z.object({ a: z.string(), x: z.string().optional() }), z.object({ b: z.number() })]).optional() });
    expect(await validate(defaultRules, s, { q: 'x', u: null }, GEMINI_VIA_OPENAI)).toMatchObject({ success: true, value: { q: 'x' } });
    expect(await validate(defaultRules, s, { q: 'x', u: { a: 's', x: null } }, GEMINI_VIA_OPENAI)).toMatchObject({ success: true, value: { q: 'x', u: { a: 's' } } });
  });

  it('SIBLING: the gemini rule before the openai one (order reversed) still reads the invited nulls', async () => {
    const s = z.object({ u: z.union([z.object({ a: z.string(), x: z.string().optional() }), z.object({ b: z.number() })]) });
    expect(await validate([gemini, openaiStrict], s, { u: { a: 's', x: null } }, GEMINI_VIA_OPENAI)).toMatchObject({ success: true, value: { u: { a: 's' } } });
  });

  it('SIBLING: the fallback chain path — a later cloning rule on one candidate', async () => {
    const chain = chainToolCompat({ t: tool({ description: 'd', inputSchema: schema, execute: async () => 'ok' }) }, [openaiStrict, jsonClone]);
    chain.shape([{ type: 'function', name: 't', inputSchema: asSchema(schema as any).jsonSchema }] as any, OPENAI);
    expect(await asSchema(chain.tools.t.inputSchema).validate!({ q: 'x', limit: null })).toMatchObject({ success: true, value: { q: 'x' } });
  });

  it("SIBLING: a null the author allowed (.nullable()) is still the author's null after a cloning rule", async () => {
    const s = z.object({ note: z.string().nullable() });
    expect(await validate([openaiStrict, jsonClone], s, { note: null })).toMatchObject({ success: true, value: { note: null } });
  });

  it('SIBLING: a value outside the schema is still refused after a cloning rule (the tool validates)', async () => {
    expect((await validate([openaiStrict, jsonClone], schema, { q: 1, limit: null })).success).toBe(false);
  });
});
