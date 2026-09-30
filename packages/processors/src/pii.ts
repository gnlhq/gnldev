import { recordProcessorReport } from '@gnldev/durable';
import type { Processor, ProcessorCtx, ProcessorInput, ProcessorOutput, ProcessorToolResult } from '@gnldev/durable';
import {
  redactString, redactMessages, applyRedactions, PII_PATTERNS,
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
 * Redacts a structured value by walking it — never by re-parsing text, which is what failed open.
 *
 * Each string leaf and each key goes through `redact`; numbers, booleans, null and bigint are kept
 * as they are. The shape follows what `JSON.stringify` (and so the journal) would store: `toJSON` is
 * honoured (a `Date` becomes its ISO text, then is redacted as text), own enumerable keys only,
 * functions/symbols/undefined dropped from objects and nulled in arrays. Two deviations, both so the
 * walk FINISHES where serialisation would throw: a cyclic back-reference becomes `'[Circular]'`, and
 * a bigint is kept. A key masked into one already present gets `#2`, `#3`… instead of overwriting it.
 *
 * Throws whatever a getter or `toJSON` throws (or a RangeError on a structure too deep to recurse);
 * the caller turns that into a marker. It never returns a partially-walked original.
 */
function redactStructured(
  value: unknown,
  redact: (text: string) => { text: string; total: number; types: string[] },
): { value: unknown; total: number; types: string[]; paths: string[] } {
  let total = 0;
  const hit = new Set<string>();
  const paths: string[] = [];
  const ancestors = new Set<object>();
  const record = (r: { total: number; types: string[] }, path: string) => {
    if (r.total === 0) return;
    total += r.total;
    for (const t of r.types) hit.add(t);
    paths.push(path);
  };
  const text = (s: string, path: string): string => {
    const r = redact(s);
    record(r, path);
    return r.text;
  };
  const dropped = (v: unknown) => v === undefined || typeof v === 'function' || typeof v === 'symbol';

  const walk = (input: unknown, key: string, path: string): unknown => {
    let v = input;
    if (v !== null && typeof v === 'object' && typeof (v as { toJSON?: unknown }).toJSON === 'function') {
      v = (v as { toJSON: (k: string) => unknown }).toJSON(key);
    }
    if (typeof v === 'string') return text(v, path);
    if (v === null || typeof v !== 'object') return v;
    if (ancestors.has(v)) return '[Circular]';
    ancestors.add(v);
    try {
      if (Array.isArray(v)) {
        return v.map((item, i) => {
          const w = walk(item, String(i), `${path}[${i}]`);
          return dropped(w) ? null : w;
        });
      }
      const out = new Map<string, unknown>();
      for (const k of Object.keys(v)) {
        // Paths name the MASKED key: a report must not carry the PII it reports on.
        const masked = redact(k);
        const name = masked.text;
        const at = /^[A-Za-z_$][\w$]*$/.test(name) ? `${path}.${name}` : `${path}[${JSON.stringify(name)}]`;
        const item = walk((v as Record<string, unknown>)[k], k, at);
        if (dropped(item)) continue;
        record(masked, at);
        let unique = name;
        for (let n = 2; out.has(unique); n++) unique = `${name}#${n}`;
        out.set(unique, item);
      }
      // fromEntries defines own properties, so a `__proto__` key stays data instead of a prototype.
      return Object.fromEntries(out);
    } finally {
      ancestors.delete(v);
    }
  };
  const out = walk(value, '', '$');
  return { value: out, total, types: [...hit], paths };
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
    const redactText = (text: string) => applyRedactions(text, types, mask, { extra, validate });
    // durable-tool.ts ALWAYS awaits THIS HOOK (`await proc.processToolResult(...)`) →
    // making it async doesn't break the existing contract (existing tests already await it too).
    proc.processToolResult = async (res: ProcessorToolResult, ctx: ProcessorCtx) => {
      const { output, toolName } = res;
      if (skip.has(toolName)) return { output };
      // `string[]`, not `PiiType[]`: a custom pattern's name belongs in the audit report too, or the
      // report would say fewer types were hit than the redaction actually masked.
      const report = async (findings: { redactedCount: number; types: string[]; [k: string]: unknown }) => {
        if (findings.redactedCount > 0 || findings.failedClosed) await recordProcessorReport(ctx, 'pii-redactor', 'tool', findings);
      };
      if (typeof output === 'string') {
        const r = redactText(output);
        await report({ redactedCount: r.total, types: r.types });
        return { output: r.text };
      }
      if (output === null || typeof output !== 'object') return { output }; // number/boolean/bigint/undefined: no text to mask
      let walked: ReturnType<typeof redactStructured>;
      try {
        walked = redactStructured(output, redactText);
      } catch (err) {
        // The error's MESSAGE is repeated nowhere: a throwing getter's message is tool data too.
        const reason = err instanceof Error ? err.name : typeof err;
        await report({ redactedCount: 0, types: [], failedClosed: true, reason });
        console.warn(`@gnldev/processors: piiRedactor could not walk the output of tool '${toolName}' (${reason}); replaced with a marker, not journaled.`);
        return {
          output: `[REDACTED_TOOL_RESULT: piiRedactor could not walk this value (${reason}), so it was not journaled. ` +
            `To journal this tool's output unredacted, pass piiRedactor({ redactToolResults: { skipTools: ['${toolName}'] } })]`,
        };
      }
      await report({ redactedCount: walked.total, types: walked.types, paths: walked.paths });
      return { output: walked.value };
    };
  }

  return proc;
}
