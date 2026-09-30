import type { JsonSchema } from './types.js';

/**
 * Validation of a patched tool: the tool's OWN schema decides, never the patched one.
 *
 * A rule rewrites what the model is TOLD. It used to replace what the tool ACCEPTS as well: the
 * patched inputSchema was a bare `jsonSchema(js)` with no validator, so the AI SDK validated nothing
 * and zod's `.default()`/`.transform()` never ran — `{ to: 'not-an-email', count: -7 }` reached
 * execute() on every model a rule matched.
 *
 * One rewrite changes what a well-behaved model SENDS, so the original validator cannot be used
 * verbatim: `openaiStrict` makes every key required and widens a formerly-optional one to accept
 * `null`, strict mode's only way to say "not supplied". The original schema refuses that null. So a
 * null at a key the original does NOT require, whose own schema does NOT accept null, is read as the
 * key being absent — which is what the rule told the model null means. Everything else is untouched:
 * a null the author allowed stays null, a null at a required key is still an error.
 */

/** Resolves a local `$ref` (`#/$defs/X`, `#/definitions/X`); anything else is returned as is. */
function deref(s: any, root: any, seen = new Set<string>()): any {
  if (!s || typeof s !== 'object' || typeof s.$ref !== 'string') return s;
  const ref: string = s.$ref;
  if (!ref.startsWith('#/') || seen.has(ref)) return s;
  seen.add(ref);
  let node: any = root;
  for (const part of ref.slice(2).split('/')) node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  return node === undefined ? s : deref(node, root, seen);
}

/** Does this schema admit `null`? A node with no constraint does. */
function acceptsNull(input: any, root: any): boolean {
  const s = deref(input, root);
  if (s === true || s === undefined || s === null || typeof s !== 'object') return s !== false;
  if (s.nullable === true) return true;
  if (s.const !== undefined) return s.const === null;
  if (Array.isArray(s.enum)) return s.enum.includes(null);
  if (Array.isArray(s.anyOf)) return s.anyOf.some((b: any) => acceptsNull(b, root));
  if (Array.isArray(s.oneOf)) return s.oneOf.some((b: any) => acceptsNull(b, root));
  if (Array.isArray(s.allOf)) return s.allOf.every((b: any) => acceptsNull(b, root));
  if (s.type === undefined) return true;
  return s.type === 'null' || (Array.isArray(s.type) && s.type.includes('null'));
}

const isNullBranch = (b: any) => b && typeof b === 'object' && b.type === 'null';

/**
 * Removes the nulls `openaiStrict` invites, guided by the ORIGINAL schema. Copy-on-write: returns the
 * same reference when there was nothing to remove, so a caller can tell "nothing to reinterpret".
 */
export function dropInvitedNulls(value: unknown, schema: JsonSchema, root: JsonSchema = schema): unknown {
  const s = deref(schema, root);
  if (!s || typeof s !== 'object') return value;

  // A nullable wrapper (`anyOf: [X, {type:'null'}]`) describes X — descend into it.
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = s[key];
    if (Array.isArray(branches)) {
      const real = branches.filter((b: any) => !isNullBranch(b));
      if (real.length === 1) return dropInvitedNulls(value, real[0], root);
    }
  }

  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item, i) => {
      const itemSchema = Array.isArray(s.items) ? s.items[i] : s.items;
      const next = itemSchema && typeof itemSchema === 'object' ? dropInvitedNulls(item, itemSchema, root) : item;
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }

  if (value === null || typeof value !== 'object') return value;

  let out = value as Record<string, unknown>;
  let changed = false;
  const props: Record<string, any> = s.properties && typeof s.properties === 'object' ? s.properties : {};
  const required = new Set<string>(Array.isArray(s.required) ? s.required : []);
  const open = s.additionalProperties && typeof s.additionalProperties === 'object' ? s.additionalProperties : undefined;
  const copy = () => { if (!changed) { out = { ...out }; changed = true; } };

  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const declared = Object.prototype.hasOwnProperty.call(props, k);
    const propSchema = declared ? props[k] : open;
    if (v === null && declared && !required.has(k) && !acceptsNull(propSchema, root)) {
      copy();
      delete out[k];
      continue;
    }
    if (propSchema && typeof propSchema === 'object') {
      const next = dropInvitedNulls(v, propSchema, root);
      if (next !== v) { copy(); out[k] = next; }
    }
  }
  // An intersection constrains the value with every branch at once.
  if (Array.isArray(s.allOf)) {
    for (const branch of s.allOf) {
      const next = dropInvitedNulls(out, branch, root);
      if (next !== out) { out = next as Record<string, unknown>; changed = true; }
    }
  }
  return changed ? out : value;
}

type ValidationResult = { success: true; value: unknown } | { success: false; error: Error };

/**
 * The validator a patched tool carries: the tool's own, run on what the model sent, then — only if
 * that fails and there was an invited null to reinterpret — on the value with those nulls removed.
 * A value the original accepts is therefore never altered. With no original validator (a
 * `jsonSchema()` without `validate`) nothing is validated, as before; the nulls are still removed.
 */
export function validateAsWritten(
  original: { validate?: (value: unknown) => ValidationResult | PromiseLike<ValidationResult> } | undefined,
  originalJson: JsonSchema,
): (value: unknown) => Promise<ValidationResult> {
  return async (value) => {
    const cleaned = dropInvitedNulls(value, originalJson);
    if (typeof original?.validate !== 'function') return { success: true, value: cleaned };
    const first = await original.validate(value);
    if (first.success || cleaned === value) return first;
    return original.validate(cleaned);
  };
}
