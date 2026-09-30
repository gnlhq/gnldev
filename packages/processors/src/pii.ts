import { recordProcessorReport } from '@gnldev/durable';
import type { Processor, ProcessorCtx, ProcessorInput, ProcessorOutput, ProcessorToolResult, ProcessorToolError } from '@gnldev/durable';
import {
  redactString, redactMessages, applyRedactions, compileRedactions, PII_PATTERNS,
  type PiiType, type PiiPattern,
} from './redact.js';

export interface PiiRedactorOptions {
  /** Which PII types to mask (default: all). */
  types?: PiiType[];
  /** Mask generator (default: `[REDACTED_<TYPE>]`). */
  mask?: (type: PiiType) => string;
  /** input/output/both (default: 'both'). */
  on?: 'input' | 'output' | 'both';
  /**
   * Also redact the tool execute result (processToolResult hook) — default: false.
   * Tool output (external API/DB/file result) is otherwise written to the journal as-is; it may
   * contain PII. Opt-in, so a piiRedactor without it behaves exactly as before.
   *
   * A string result is redacted as text. A structured result (object/array) is WALKED: every string
   * leaf and every key goes through the same patterns; numbers, booleans and null stay what they are
   * (the patterns are text patterns — `phone` masks a bare 7–15 digit run in text, and as a JSON number
   * that is an epoch-ms timestamp or an id far more often than a phone). A cyclic back-reference becomes
   * `'[Circular]'`; a `Date` (anything with `toJSON`) is walked as the JSON the journal would store.
   *
   * FAILS CLOSED: a value the walk cannot finish (a getter or `toJSON` that throws, a structure deep
   * enough to overflow the stack) is replaced by a `[REDACTED_TOOL_RESULT: …]` marker, never journaled
   * raw. The marker names the way through: `{ skipTools: ['toolName'] }` journals that tool's output as
   * it returned — for a tool you know carries no PII, or whose output cannot be walked.
   */
  redactToolResults?: boolean | { skipTools?: string[] };
  /**
   * Extra patterns, for the identifiers the five built-in types cannot name.
   *
   * The built-in list is US-shaped (`ssn` exists nowhere else), so a national id, an IBAN, a patient
   * record number or an internal customer id has no type that matches it. Dropping a built-in from
   * `types` removes coverage rather than adding any, and mutating the exported `PII_PATTERNS` changes
   * behavior for every redactor in the process — neither is a way to add your own.
   *
   * These run BEFORE the built-ins, deliberately: the built-in `phone` pattern is greedy enough to
   * swallow a national id (measured — `12345678901` comes back `[REDACTED_PHONE]`), so a pattern that
   * ran afterwards would find its text already masked under the wrong name.
   *
   *   piiRedactor({ extraPatterns: [{ name: 'iban', pattern: /TR\d{24}/g }] })
   */
  extraPatterns?: PiiPattern[];
  /**
   * Run each identifier's own checksum before masking — Luhn for `creditCard`, mod-97 for `iban`,
   * and any `test` on a custom pattern. Default: true.
   *
   * It is what separates a card number from any sixteen digits: measured, the pattern alone masked
   * `order 1234567812345678` as a card, which loses the order number without protecting anything.
   * The trade is real and worth stating — a card typed with a wrong digit fails Luhn and is then left
   * alone. Set to `false` to mask on shape only, which is the older, blunter behavior: it corrupts
   * more text but cannot be talked out of masking anything.
   */
  validate?: boolean;
}

const DEFAULT_TYPES: PiiType[] = ['email', 'phone', 'creditCard', 'ssn', 'ip', 'iban'];

/**
 * Rejects a configuration that would mask less than the caller thinks it does.
 *
 * A name with no built-in behind it used to be dropped in silence — `types: ['iban']` returned the
 * text untouched and reported nothing, so a deployment could believe a type was covered while the
 * value went through in the clear. TypeScript catches it only for TS callers passing a literal;
 * Config read from JS, JSON or an env var reaches here unchecked. Both entry points run this at
 * CONSTRUCTION — config time, not per-run — so a mistake surfaces at startup instead of inside a
 * run that has already touched the data.
 */
function assertUsablePatterns(types: PiiType[], extra: PiiPattern[]): void {
  const unknown = types.filter((t) => !(t in PII_PATTERNS));
  if (unknown.length) {
    throw new Error(
      `piiRedactor: unknown PII type(s) ${unknown.map((u) => JSON.stringify(u)).join(', ')} — these would mask nothing. ` +
      `Built-in types are ${Object.keys(PII_PATTERNS).join(', ')}; anything else goes in extraPatterns.`,
    );
  }
  for (const p of extra) {
    if (!p?.name || !(p.pattern instanceof RegExp)) {
      throw new Error(`piiRedactor: extraPatterns entries need a non-empty \`name\` and a RegExp \`pattern\` (got ${JSON.stringify(p)}).`);
    }
  }
}

/**
 * The same masking as `piiRedactor`, as a plain string function, for the text that never passes
 * through a processor at all.
 *
 * A `Processor` only sees `processInput`/`processOutput`/`processToolResult`. A run's failure
 * message is written from `recordRunOutcome` in @gnldev/durable, which no processor is consulted
 * about, and it is not always the host's own text: a provider that refuses a request commonly
 * echoes the offending input back inside the message. Anything that ships that message onward —
 * `@gnldev/otel`'s span attributes are the case this was added for — needs the same mask, and had
 * no way to reuse it because `DEFAULT_TYPES` is private to this module.
 *
 * Shares that constant and the default mask with `piiRedactor` deliberately: two copies of the
 * defaults is exactly how the redacted path and the un-redacted one drift apart.
 *
 *   import { piiTextRedactor } from '@gnldev/processors';
 *   await exportRun(journal, runId, { endpoint, redact: piiTextRedactor() });
 */
export function piiTextRedactor(
  opts: Pick<PiiRedactorOptions, 'types' | 'mask' | 'extraPatterns' | 'validate'> = {},
): (text: string) => string {
  const types = opts.types ?? DEFAULT_TYPES;
  const mask = opts.mask ?? ((t: PiiType) => `[REDACTED_${t.toUpperCase()}]`);
  const extra = opts.extraPatterns ?? [];
  const validate = opts.validate !== false;
  assertUsablePatterns(types, extra);
  return (text: string) => (typeof text === 'string' ? redactString(text, types, mask, extra, validate) : text);
}

/**
 * For the audit report (`recordProcessorReport`): the counts come off the SAME call that performs the
 * redaction (`applyRedactions`), so the report cannot describe a masking that did not run. It used to
 * be a second, independent walk over the same text with the same order copied by hand — which is
 * exactly how the two drift once a validator or a new pattern lands in only one of them.
 */
function countRedactions(
  text: string,
  types: PiiType[],
  mask: (t: PiiType) => string,
  extra: PiiPattern[] = [],
  validate = true,
): { total: number; types: string[] } {
  const { total, types: hitTypes } = applyRedactions(text, types, mask, { extra, validate });
  return { total, types: hitTypes };
}

/**
 * A label for a thrown value that the value cannot choose. `err.name` is the thrower's text — an Error
 * whose name is the email put the email into the marker and the console warning — so only built-in
 * constructors are named, by identity, and everything else is `Error` or `non-Error`.
 */
function thrownLabel(err: unknown): string {
  if (err instanceof RangeError) return 'RangeError'; // the stack overflow of a structure too deep to walk
  if (err instanceof TypeError) return 'TypeError';
  if (err instanceof Error) return 'Error';
  return 'non-Error';
}

/** Buffer, typed arrays, DataView: bytes, which no text pattern can read — see `redactStructured`. */
const isBinary = (v: object): boolean => ArrayBuffer.isView(v) || v instanceof ArrayBuffer;

/**
 * The primitive inside a `new String/Number/Boolean(…)`, as JSON.stringify unwraps it; `undefined`
 * for anything else. The tag is only a cheap filter (it can be forged with `Symbol.toStringTag`); the
 * `valueOf` brand check is what decides, and a forged tag is walked as the object it really is.
 */
function unbox(v: object): string | number | boolean | undefined {
  const tag = Object.prototype.toString.call(v);
  try {
    if (tag === '[object String]') return String.prototype.valueOf.call(v);
    if (tag === '[object Number]') return Number.prototype.valueOf.call(v);
    if (tag === '[object Boolean]') return Boolean.prototype.valueOf.call(v);
  } catch {
    // not really boxed: the tag lied
  }
  return undefined;
}

/** A path segment chain, turned into `$.a[0]["k"]` text only for a path that is reported. */
type PathNode = { up: PathNode | undefined; seg: string | number } | undefined;
function pathText(p: PathNode): string {
  const segs: (string | number)[] = [];
  for (let n = p; n; n = n.up) segs.push(n.seg);
  let out = '$';
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i]!;
    out += typeof s === 'number' ? `[${s}]` : /^[A-Za-z_$][\w$]*$/.test(s) ? `.${s}` : `[${JSON.stringify(s)}]`;
  }
  return out;
}

/**
 * Redacts a structured value by walking it — never by re-parsing text, which is what failed open.
 *
 * INVARIANT: the value returned holds no text the patterns did not see. The journal stores it with
 * superjson, so the walk follows what superjson would store, node by node:
 *   - a string, a key, and a boxed `new String(…)` (unwrapped, as JSON.stringify does) go through
 *     `redact`; numbers, booleans, null and bigint are kept; boxed Number/Boolean become primitives;
 *   - `toJSON` is honoured (a `Date` becomes its ISO text, then is redacted as text; what toJSON
 *     returns is walked by these same rules, so a toJSON returning a boxed String is unwrapped too);
 *   - an array, a Map and a Set are walked into a new array/Map/Set (superjson keeps Map and Set with
 *     their contents, so turning them into `{}` lost data); any other object by its own enumerable
 *     keys, functions/symbols/undefined dropped from objects and nulled in arrays;
 *   - binary data — a Buffer, a typed array, a DataView, an ArrayBuffer — is WITHHELD: replaced by a
 *     marker naming the way through, and its path reported. It is checked BEFORE toJSON, because a
 *     Buffer's toJSON hands over its bytes as numbers, and a typed array's keys are indices holding
 *     numbers: either way the email reached the journal as bytes, which no text pattern can read.
 * Two deviations from serialisation, both so the walk FINISHES where it would throw: a cyclic
 * back-reference becomes `'[Circular]'`, and a bigint is kept. A key masked into one already present
 * gets `#2`, `#3`… instead of overwriting it.
 *
 * Throws whatever a getter or `toJSON` throws (or a RangeError on a structure too deep to recurse);
 * the caller turns that into a marker. It never returns a partially-walked original.
 */
function redactStructured(
  value: unknown,
  redact: (text: string) => { text: string; total: number; types: string[] },
  withheldMarker: string,
): { value: unknown; total: number; types: string[]; paths: string[]; withheld: string[] } {
  let total = 0;
  const hit = new Set<string>();
  const paths: string[] = [];
  const withheld: string[] = [];
  const ancestors = new Set<object>();
  // Keys repeat on every row of a result set; each distinct key is redacted once per walk.
  const keyCache = new Map<string, { text: string; total: number; types: string[] }>();
  const record = (r: { total: number; types: string[] }, path: PathNode) => {
    if (r.total === 0) return;
    total += r.total;
    for (const t of r.types) hit.add(t);
    paths.push(pathText(path));
  };
  const text = (s: string, path: PathNode): string => {
    const r = redact(s);
    record(r, path);
    return r.text;
  };
  const redactKey = (k: string) => {
    let r = keyCache.get(k);
    if (!r) { r = redact(k); keyCache.set(k, r); }
    return r;
  };
  const withhold = (path: PathNode): string => {
    withheld.push(pathText(path));
    return withheldMarker;
  };
  const dropped = (v: unknown) => v === undefined || typeof v === 'function' || typeof v === 'symbol';

  const walk = (input: unknown, key: string, path: PathNode): unknown => {
    let v = input;
    if (typeof v === 'string') return text(v, path);
    if (v === null || typeof v !== 'object') return v;
    if (isBinary(v)) return withhold(path);
    if (typeof (v as { toJSON?: unknown }).toJSON === 'function') {
      v = (v as { toJSON: (k: string) => unknown }).toJSON(key);
      if (typeof v === 'string') return text(v, path);
      if (v === null || typeof v !== 'object') return v;
      if (isBinary(v)) return withhold(path);
    }
    const prim = unbox(v);
    if (prim !== undefined) return typeof prim === 'string' ? text(prim, path) : prim;
    if (ancestors.has(v)) return '[Circular]';
    ancestors.add(v);
    try {
      if (Array.isArray(v)) {
        return v.map((item, i) => {
          const w = walk(item, String(i), { up: path, seg: i });
          return dropped(w) ? null : w;
        });
      }
      if (v instanceof Map) {
        const out = new Map<unknown, unknown>();
        let i = 0;
        for (const [k, item] of v) {
          const at: PathNode = { up: path, seg: i++ };
          const wk = typeof k === 'string' ? text(k, at) : walk(k, '', at);
          let unique = wk;
          for (let n = 2; typeof wk === 'string' && out.has(unique); n++) unique = `${wk}#${n}`;
          out.set(unique, walk(item, typeof k === 'string' ? k : '', at));
        }
        return out;
      }
      if (v instanceof Set) {
        const out = new Set<unknown>();
        let i = 0;
        for (const item of v) out.add(walk(item, '', { up: path, seg: i++ }));
        return out;
      }
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v)) {
        // Paths name the MASKED key: a report must not carry the PII it reports on.
        const masked = redactKey(k);
        const name = masked.text;
        const at: PathNode = { up: path, seg: name };
        const item = walk((v as Record<string, unknown>)[k], k, at);
        if (dropped(item)) continue;
        record(masked, at);
        let unique = name;
        for (let n = 2; Object.prototype.hasOwnProperty.call(out, unique); n++) unique = `${name}#${n}`;
        // defineProperty, so a `__proto__` key stays data instead of setting the prototype.
        if (unique === '__proto__') Object.defineProperty(out, unique, { value: item, enumerable: true, writable: true, configurable: true });
        else out[unique] = item;
      }
      return out;
    } finally {
      ancestors.delete(v);
    }
  };
  const out = walk(value, '', undefined);
  return { value: out, total, types: [...hit], paths, withheld };
}

/** Aggregates redactions across ALL text fields of a ProcessorInput/ProcessorOutput (system/prompt/messages
 *  are counted separately — same granularity as redactMessages, which redacts each message/part INDEPENDENTLY). */
function countInputRedactions(
  fields: { system?: unknown; prompt?: unknown; messages?: any[] },
  types: PiiType[],
  mask: (t: PiiType) => string,
  extra: PiiPattern[] = [],
  validate = true,
): { total: number; types: string[] } {
  let total = 0;
  const typeSet = new Set<string>();
  const add = (r: { total: number; types: string[] }) => { total += r.total; for (const t of r.types) typeSet.add(t); };
  if (typeof fields.system === 'string') add(countRedactions(fields.system, types, mask, extra, validate));
  if (typeof fields.prompt === 'string') add(countRedactions(fields.prompt, types, mask, extra, validate));
  for (const m of fields.messages ?? []) {
    if (typeof m?.content === 'string') add(countRedactions(m.content, types, mask, extra, validate));
    else if (Array.isArray(m?.content)) {
      for (const part of m.content) if (typeof part?.text === 'string') add(countRedactions(part.text, types, mask, extra, validate));
    }
  }
  return { total, types: [...typeSet] };
}

/**
 * PII redaction processor — pure regex (email/phone/credit-card/ssn/ip). Deterministic, so no
 * journaling is needed: produces the same masking on resume. The input side runs BEFORE persistInput
 * → masked content is written to the journal, the model NEVER sees raw PII.
 *
 * HONEST WARNING (naive regex matching): These regexes are best-effort, they do NOT provide an
 * AUDIT/COMPLIANCE-grade (GDPR/HIPAA/PCI-DSS etc.) PII DETECTION GUARANTEE. Known limits: only
 * matches specific formats (e.g. US/generic-format phone numbers, plain 16-digit card numbers) —
 * international/local formats, unstructured PII like name/address, or unusual formatting (line
 * breaks, different separators) can slip through; it can also produce false positives (e.g. a
 * random 16-digit number). Use it as a noise-reduction / first-line-of-defense layer, not as a real
 * compliance/security boundary.
 *
 * SCOPE, measured — WHAT THE OUTPUT SIDE DOES NOT COVER: `processOutput` transforms the
 * `{text, messages}` view, so `result.text` and `result.response.messages` come back masked on both
 * `runDurable` and `streamDurable`, and so does persisted thread memory. `result.steps` and
 * `result.content` DO NOT — they still hold the model's raw output, and a caller reading either one
 * sees unredacted PII. This is not fixable inside the hook: a processor's output arity is
 * unconstrained (a summariser legally returns one message for a turn that produced three), so no
 * mapping back onto per-step records exists, and `content` is a parts array rather than messages.
 * Read `text`/`response.messages`; treat `steps`/`content` as raw. On the STREAM path the
 * `textStream`/`fullStream` deltas are raw as well — they reach the client before the turn ends, so
 * use `on: 'input'` (or `runDurable`) if the wire itself must never carry it.
 */
export function piiRedactor(opts: PiiRedactorOptions = {}): Processor {
  const types = opts.types ?? DEFAULT_TYPES;
  const mask = opts.mask ?? ((t: PiiType) => `[REDACTED_${t.toUpperCase()}]`);
  const extra = opts.extraPatterns ?? [];
  const validate = opts.validate !== false;
  assertUsablePatterns(types, extra);
  const on = opts.on ?? 'both';

  const proc: Processor = { name: 'pii-redactor' };

  if (on === 'input' || on === 'both') {
    // NOT async (behavior must stay the same — callers may call processInput synchronously and
    // read the returned object directly). The audit report (recordProcessorReport) is BEST-EFFORT +
    // fire-and-forget: it does NOT CHANGE the transform/synchronous-return contract, it's only an
    // EXTRA record.
    proc.processInput = (input: ProcessorInput, ctx: ProcessorCtx) => {
      const out: ProcessorInput = {
        system: typeof input.system === 'string' ? redactString(input.system, types, mask, extra, validate) : input.system,
        prompt: typeof input.prompt === 'string' ? redactString(input.prompt, types, mask, extra, validate) : input.prompt,
        messages: input.messages ? redactMessages(input.messages, types, mask, extra, validate) : input.messages,
      };
      const { total, types: hitTypes } = countInputRedactions(input, types, mask, extra, validate);
      if (total > 0) void recordProcessorReport(ctx, 'pii-redactor', 'input', { redactedCount: total, types: hitTypes });
      return out;
    };
  }

  if (on === 'output' || on === 'both') {
    proc.processOutput = (output: ProcessorOutput, ctx: ProcessorCtx) => {
      const out: ProcessorOutput = {
        ...output,
        text: typeof output.text === 'string' ? redactString(output.text, types, mask, extra, validate) : output.text,
        messages: output.messages ? redactMessages(output.messages, types, mask, extra, validate) : output.messages,
      };
      const { total, types: hitTypes } = countInputRedactions(
        { prompt: output.text, messages: output.messages }, types, mask, extra, validate,
      );
      if (total > 0) void recordProcessorReport(ctx, 'pii-redactor', 'output', { redactedCount: total, types: hitTypes });
      return out;
    };
  }

  // Opt-in hook so tool output doesn't write plain PII to the journal. It used to redact an object as
  // JSON TEXT (stringify → redact → parse) and return the ORIGINAL when the parse failed — which it
  // did for any JSON number `phone` matched (epoch ms, ids, 41.0082376), so the email beside the
  // timestamp went to the journal in plaintext, unreported. The value is now walked
  // (`redactStructured`), and anything the walk cannot finish is replaced, never passed through.
  if (opts.redactToolResults) {
    const skip = new Set(typeof opts.redactToolResults === 'object' ? opts.redactToolResults.skipTools ?? [] : []);
    const redactText = compileRedactions(types, mask, { extra, validate });
    const wayThrough = (toolName: string) =>
      `To journal this tool's output unredacted, pass piiRedactor({ redactToolResults: { skipTools: ['${toolName}'] } })`;
    // `string[]`, not `PiiType[]`: a custom pattern's name belongs in the audit report too, or the
    // report would say fewer types were hit than the redaction actually masked.
    const report = async (ctx: ProcessorCtx, findings: { redactedCount: number; types: string[]; [k: string]: unknown }) => {
      if (findings.redactedCount > 0 || findings.failedClosed || (findings.withheld as unknown[] | undefined)?.length) {
        await recordProcessorReport(ctx, 'pii-redactor', 'tool', findings);
      }
    };
    // durable-tool.ts ALWAYS awaits THIS HOOK (`await proc.processToolResult(...)`) →
    // making it async doesn't break the existing contract (existing tests already await it too).
    proc.processToolResult = async (res: ProcessorToolResult, ctx: ProcessorCtx) => {
      const { output, toolName } = res;
      if (skip.has(toolName)) return { output };
      if (typeof output === 'string') {
        const r = redactText(output);
        await report(ctx, { redactedCount: r.total, types: r.types });
        return { output: r.text };
      }
      if (output === null || typeof output !== 'object') return { output }; // number/boolean/bigint/undefined: no text to mask
      const binaryMarker = `[REDACTED_TOOL_RESULT: binary data is not walked, so it was not journaled. ${wayThrough(toolName)}]`;
      let walked: ReturnType<typeof redactStructured>;
      try {
        walked = redactStructured(output, redactText, binaryMarker);
      } catch (err) {
        // Neither the error's MESSAGE nor its NAME is repeated: both are the thrower's text, and a
        // throwing getter's text is tool data too (an Error named after the email leaked it here).
        const reason = thrownLabel(err);
        await report(ctx, { redactedCount: 0, types: [], failedClosed: true, reason });
        console.warn(`@gnldev/processors: piiRedactor could not walk the output of tool '${toolName}' (${reason}); replaced with a marker, not journaled.`);
        return { output: `[REDACTED_TOOL_RESULT: piiRedactor could not walk this value (${reason}), so it was not journaled. ${wayThrough(toolName)}]` };
      }
      if (walked.withheld.length) {
        console.warn(`@gnldev/processors: piiRedactor withheld binary data in the output of tool '${toolName}' at ${walked.withheld.join(', ')}; replaced with a marker, not journaled.`);
      }
      await report(ctx, {
        redactedCount: walked.total, types: walked.types, paths: walked.paths,
        ...(walked.withheld.length ? { withheld: walked.withheld } : {}),
      });
      return { output: walked.value };
    };
    // The same promise on the ERROR path: a tool that throws `Error('no account for ayse@acme.com')`
    // had its message journaled as `{status:'failed', error}` with no processor consulted. The text
    // is redacted like any string output; the thrown error itself is untouched (retry policies and
    // the caller still see it as thrown).
    proc.processToolError = async (res: ProcessorToolError, ctx: ProcessorCtx) => {
      if (skip.has(res.toolName)) return { error: res.error };
      const r = redactText(res.error);
      await report(ctx, { redactedCount: r.total, types: r.types, error: true });
      return { error: r.text };
    };
  }

  return proc;
}
