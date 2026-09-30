import { asSchema, jsonSchema } from 'ai';
import { detectModel } from './detect.js';
import { validateAsWritten } from './validate.js';
import type { JsonSchema, ModelInfo, ToolSchemaRule } from './types.js';

type Validating = Parameters<typeof validateAsWritten>[0];

/**
 * Reads tool.inputSchema (zod | AI SDK Schema | raw JSON): a JSON Schema COPY of what generateText
 * would send, plus the tool's own validator when it has one.
 * Uses the AI SDK's own `asSchema` → patches the exact same schema that generateText would send.
 */
function readSchema(input: unknown): { json: JsonSchema; validator?: Validating } | undefined {
  if (input == null) return undefined;
  try {
    const s = asSchema(input as Parameters<typeof asSchema>[0]);
    if (s?.jsonSchema && typeof s.jsonSchema === 'object') {
      return { json: structuredClone(s.jsonSchema) as JsonSchema, validator: s as Validating };
    }
  } catch {
    // asSchema didn't accept it → it might be a raw JSON Schema object (below)
  }
  const obj = input as any;
  if (typeof obj === 'object' && (obj.type || obj.properties || obj.anyOf || obj.oneOf)) {
    return { json: structuredClone(obj) as JsonSchema };
  }
  return undefined;
}

function activeRules(rules: ToolSchemaRule[], info: ModelInfo): ToolSchemaRule[] {
  return rules.filter((r) => {
    try {
      return r.shouldApply(info);
    } catch {
      return false;
    }
  });
}

/**
 * THE one place rules touch a schema — both `applyToolCompat` (tool level) and `shapeToolDefinitions`
 * (wire level) go through it, so the two paths cannot shape differently. Copies first: rules mutate
 * in place.
 */
function shapeSchema(schema: JsonSchema, active: ToolSchemaRule[], info: ModelInfo): JsonSchema {
  let js: JsonSchema = structuredClone(schema);
  for (const r of active) {
    try {
      js = r.transform(js, info) ?? js;
    } catch {
      // a rule error shouldn't drop the tool; skip that rule
    }
  }
  return js;
}

/**
 * Applies provider-specific schema compatibility to a tool set. PURE; must run BEFORE the model call.
 * ALL rules with `shouldApply()===true` are applied in sequence (composition).
 *
 * Only what the MODEL is told changes. `execute` and `description` are preserved, and the patched
 * `inputSchema` still VALIDATES with the tool's own schema — zod checks, `.default()` and
 * `.transform()` included — so execute() receives the same value with compat on as off. A `null` the
 * OpenAI rule invited at a formerly-optional key is read as the key being absent (see validate.ts).
 *
 * If no rule matches, the tool set is returned UNCHANGED (same reference).
 * A tool whose schema can't be extracted, or whose rule throws, does NOT DROP at that step — it passes through as-is/as far as it got.
 */
export function applyToolCompat(
  tools: Record<string, any>,
  model: unknown,
  rules: ToolSchemaRule[],
): Record<string, any> {
  const info: ModelInfo = detectModel(model);
  const active = activeRules(rules, info);
  if (active.length === 0) return tools;

  const out: Record<string, any> = {};
  for (const [name, t] of Object.entries(tools)) {
    const base = readSchema(t?.inputSchema);
    if (!base) {
      out[name] = t;
      continue;
    }
    const js = shapeSchema(base.json, active, info);
    out[name] = { ...t, inputSchema: jsonSchema(js, { validate: validateAsWritten(base.validator, base.json) }) };
  }
  return out;
}

/**
 * The wire-level counterpart of `applyToolCompat`, for when the model is not known until the call:
 * applies the rules to the AI SDK's already-converted tool definitions
 * (`[{ type, name, description, inputSchema }]`, `inputSchema` plain JSON Schema) for ONE model.
 * `@gnldev/durable` calls it per fallback candidate, at the moment one is chosen, because providers'
 * requirements contradict (OpenAI strict requires `additionalProperties: false`, Gemini rejects it).
 *
 * It changes only what is sent. Pair it with `keepToolValidation` on the tool set, so a null the
 * OpenAI rule invites is accepted by the tool the SDK validates with.
 */
export function shapeToolDefinitions<T extends { inputSchema?: unknown }>(
  definitions: T[],
  model: unknown,
  rules: ToolSchemaRule[],
): T[] {
  const info = detectModel(model);
  const active = activeRules(rules, info);
  if (active.length === 0) return definitions;
  return definitions.map((d) => {
    if (!d?.inputSchema || typeof d.inputSchema !== 'object') return d;
    return { ...d, inputSchema: shapeSchema(d.inputSchema as JsonSchema, active, info) };
  });
}

/**
 * The tool-level half of `shapeToolDefinitions`: same schema sent, and the tool's own validator
 * wrapped so it accepts the null the OpenAI rule invites (read as "absent"). A value the original
 * accepts is never altered. Tools whose schema cannot be read pass through as they are.
 */
export function keepToolValidation(tools: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [name, t] of Object.entries(tools)) {
    const base = readSchema(t?.inputSchema);
    out[name] = base ? { ...t, inputSchema: jsonSchema(base.json, { validate: validateAsWritten(base.validator, base.json) }) } : t;
  }
  return out;
}
