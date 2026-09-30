import { asSchema, jsonSchema } from 'ai';
import { detectModel } from './detect.js';
import { validateAsWritten, type Shaped } from './validate.js';
import type { JsonSchema, ModelInfo, ShapeContext, ToolSchemaRule } from './types.js';
import { ToolSchemaError } from './errors.js';


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
 * in place. Returns the nodes the rules recorded as widened (`ShapeContext.nullMeansAbsent`) with the
 * schema they were recorded in — the validator's inverse reads exactly that record.
 */
function shapeSchema(schema: JsonSchema, active: ToolSchemaRule[], info: ModelInfo, toolName: string, strict?: boolean): Shaped {
  let js: JsonSchema = structuredClone(schema);
  const nullMeansAbsent = new WeakSet<object>();
  const ctx: ShapeContext = {
    nullMeansAbsent: (node) => { if (node && typeof node === 'object') nullMeansAbsent.add(node); },
    ...(strict !== undefined ? { strict } : {}),
  };
  for (const r of active) {
    try {
      js = r.transform(js, info, ctx) ?? js;
    } catch (err) {
      if (err instanceof ToolSchemaError) throw new ToolSchemaError(`@gnldev/tool-schema: tool '${toolName}': ${err.message}`);
      // any other rule error shouldn't drop the tool; skip that rule
    }
  }
  return { schema: js, nullMeansAbsent };
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
    const shaped = shapeSchema(base.json, active, info, name, t?.strict);
    out[name] = { ...t, inputSchema: jsonSchema(shaped.schema, { validate: validateAsWritten(base.validator, () => [shaped]) }) };
  }
  return out;
}

/**
 * The wire-level counterpart of `applyToolCompat`, for when the model is not known until the call:
 * applies the rules to the AI SDK's already-converted tool definitions
 * (`[{ type, name, description, inputSchema, strict? }]`, `inputSchema` plain JSON Schema) for ONE
 * model. It changes only what is sent; `chainToolCompat` pairs it with the validators that read back
 * what each candidate was told.
 */
export function shapeToolDefinitions<T extends { inputSchema?: unknown }>(
  definitions: T[],
  model: unknown,
  rules: ToolSchemaRule[],
): T[] {
  return shapeDefinitions(definitions, model, rules).definitions;
}

function shapeDefinitions<T extends { inputSchema?: unknown }>(
  definitions: T[],
  model: unknown,
  rules: ToolSchemaRule[],
): { definitions: T[]; shaped: Map<string, Shaped> } {
  const shaped = new Map<string, Shaped>();
  const info = detectModel(model);
  const active = activeRules(rules, info);
  if (active.length === 0) return { definitions, shaped };
  const out = definitions.map((d) => {
    if (!d?.inputSchema || typeof d.inputSchema !== 'object') return d;
    const { name, strict } = d as { name?: unknown; strict?: unknown };
    const toolName = typeof name === 'string' ? name : '?';
    const sh = shapeSchema(d.inputSchema as JsonSchema, active, info, toolName, typeof strict === 'boolean' ? strict : undefined);
    if (typeof name === 'string') shaped.set(name, sh);
    return { ...d, inputSchema: sh.schema };
  });
  return { definitions: out, shaped };
}

/**
 * Schema compatibility for a model chosen at call time (a fallback chain): `@gnldev/durable` installs
 * `shape` per candidate, at the moment one is chosen, because providers' requirements contradict
 * (OpenAI strict requires `additionalProperties: false`, Gemini rejects it), and sends `tools`.
 *
 * The two halves share one record: every schema `shape` sends is kept per tool, and each tool's
 * validator (the tool's own, as in `applyToolCompat`) reads an invited `null` back through the record
 * of what that candidate was told. The earlier pair — a validator built before any candidate was
 * known — had to guess the widening from the original schema, and guessed wrong inside unions.
 */
export function chainToolCompat(
  tools: Record<string, any>,
  rules: ToolSchemaRule[],
): { tools: Record<string, any>; shape: <T extends { inputSchema?: unknown }>(definitions: T[], model: unknown) => T[] } {
  const sent = new Map<string, Shaped[]>();
  const out: Record<string, any> = {};
  for (const [name, t] of Object.entries(tools)) {
    const base = readSchema(t?.inputSchema);
    out[name] = base
      ? { ...t, inputSchema: jsonSchema(base.json, { validate: validateAsWritten(base.validator, () => sent.get(name) ?? []) }) }
      : t;
  }
  const shape = <T extends { inputSchema?: unknown }>(definitions: T[], model: unknown): T[] => {
    const r = shapeDefinitions(definitions, model, rules);
    for (const [name, sh] of r.shaped) {
      const list = sent.get(name) ?? [];
      // One entry per distinct schema: a chain retried many times sends the same few shapes.
      const key = JSON.stringify(sh.schema);
      if (!list.some((x) => JSON.stringify(x.schema) === key)) list.push(sh);
      sent.set(name, list);
    }
    return r.definitions;
  };
  return { tools: out, shape };
}
