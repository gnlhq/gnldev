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
 * `null`, strict mode's only way to say "not supplied". The original schema refuses that null.
 *
 * INVARIANT: the reading of that null is the RULE's own record, never a second guess. The rule calls
 * `ctx.nullMeansAbsent(node)` on each node it widens (`ShapeContext`), and the inverse below walks the
 * value alongside the schema that was SENT, dropping a null only where the sent schema carries such a
 * record. The earlier inverse re-derived the widening from the ORIGINAL schema by hand, and the two
 * drifted: it descended only into unions with exactly one non-null branch, so in a discriminatedUnion
 * or a z.union of objects the null the model was told to send was refused.
 */

/** What a patched tool was told, and the nodes a rule widened in it. */
export interface Shaped {
  schema: JsonSchema;
  nullMeansAbsent: WeakSet<object>;
}

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

const isNullBranch = (b: any) => b && typeof b === 'object' && b.type === 'null';
const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Could `value` be an instance of this (sent) union branch? A SHAPE check, just enough to pick the
 * branch a value is in: the type, a closed object's keys, and the `const`/`enum` a discriminator
 * carries. A null is admitted at a key the branch widened (that is what the model was told) — the
 * check is for choosing where to read nulls, the tool's own validator still decides validity.
 */
function couldBe(value: unknown, branch: any, root: JsonSchema, marks: WeakSet<object>): boolean {
  const s = deref(branch, root);
  if (!s || typeof s !== 'object') return s !== false;
  if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    return [...(s.anyOf ?? []), ...(s.oneOf ?? [])].some((b: any) => couldBe(value, b, root, marks));
  }
  if (s.const !== undefined) return value === s.const;
  if (Array.isArray(s.enum)) return s.enum.includes(value);
  const types: string[] = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
  const isObject = types.includes('object') || (types.length === 0 && s.properties && typeof s.properties === 'object');
  if (isObject && isPlainObject(value)) {
    const props: Record<string, any> = s.properties && typeof s.properties === 'object' ? s.properties : {};
    for (const [k, v] of Object.entries(value)) {
      const p = props[k];
      if (p === undefined) {
        if (s.additionalProperties === false) return false;
        continue;
      }
      if (v === null && marks.has(p)) continue;
      const ps = deref(p, root);
      // Only the narrow facts a discriminator is made of are checked per key.
      if (ps && typeof ps === 'object' && (ps.const !== undefined || Array.isArray(ps.enum)) && !couldBe(v, ps, root, marks)) return false;
    }
    return true;
  }
  if (types.length === 0) return true;
  const t = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value;
  return types.includes(t) || (t === 'integer' && types.includes('number'));
}

/**
 * Removes the nulls a rule recorded as "not supplied", walking the value alongside the SENT schema.
 * Copy-on-write: returns the same reference when there was nothing to remove.
 *
 * At a union, the value is read in every branch it could be in (`couldBe`); a null is dropped only
 * when every such branch recorded it, so a branch where the author allowed null keeps its null.
 */
export function dropRecordedNulls(value: unknown, node: unknown, shaped: Shaped, root: JsonSchema = shaped.schema): unknown {
  const s = deref(node, root);
  if (!s || typeof s !== 'object' || value === null || typeof value !== 'object') return value;
  const marks = shaped.nullMeansAbsent;

  for (const key of ['anyOf', 'oneOf'] as const) {
    if (!Array.isArray(s[key])) continue;
    const fits = (s[key] as any[]).filter((b) => !isNullBranch(b) && couldBe(value, b, root, marks));
    if (fits.length === 0) return value;
    const reads = fits.map((b) => dropRecordedNulls(value, b, shaped, root));
    // Every branch the value could be in must agree, or the value is left as sent.
    const first = reads[0];
    return reads.every((r) => JSON.stringify(r) === JSON.stringify(first)) ? first : value;
  }

  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item, i) => {
      const itemSchema = Array.isArray(s.items) ? s.items[i] : s.items;
      const next = itemSchema && typeof itemSchema === 'object' ? dropRecordedNulls(item, itemSchema, shaped, root) : item;
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }

  let out = value as Record<string, unknown>;
  let changed = false;
  const props: Record<string, any> = s.properties && typeof s.properties === 'object' ? s.properties : {};
  const open = s.additionalProperties && typeof s.additionalProperties === 'object' ? s.additionalProperties : undefined;
  const copy = () => { if (!changed) { out = { ...out }; changed = true; } };

  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const propSchema = Object.prototype.hasOwnProperty.call(props, k) ? props[k] : open;
    if (v === null && propSchema && marks.has(propSchema)) {
      copy();
      delete out[k];
      continue;
    }
    if (propSchema && typeof propSchema === 'object') {
      const next = dropRecordedNulls(v, propSchema, shaped, root);
      if (next !== v) { copy(); out[k] = next; }
    }
  }
  // An intersection constrains the value with every branch at once.
  if (Array.isArray(s.allOf)) {
    for (const branch of s.allOf) {
      const next = dropRecordedNulls(out, branch, shaped, root);
      if (next !== out) { out = next as Record<string, unknown>; changed = true; }
    }
  }
  return changed ? out : value;
}

type ValidationResult = { success: true; value: unknown } | { success: false; error: Error };

/**
 * The validator a patched tool carries: the tool's own, run on what the model sent, then — only if
 * that fails — on the value with the recorded nulls removed, once per schema the model may have been
 * sent (one on a plain model; one per shaped candidate on a fallback chain). A value the original
 * accepts is therefore never altered. With no original validator (a `jsonSchema()` without
 * `validate`) nothing is validated, as before; the nulls of the first sent schema are still removed.
 */
export function validateAsWritten(
  original: { validate?: (value: unknown) => ValidationResult | PromiseLike<ValidationResult> } | undefined,
  sent: () => readonly Shaped[],
): (value: unknown) => Promise<ValidationResult> {
  return async (value) => {
    const cleaned = sent().map((sh) => dropRecordedNulls(value, sh.schema, sh)).filter((c) => c !== value);
    if (typeof original?.validate !== 'function') return { success: true, value: cleaned[0] ?? value };
    const first = await original.validate(value);
    if (first.success) return first;
    for (const c of cleaned) {
      const r = await original.validate(c);
      if (r.success) return r;
    }
    return first;
  };
}
