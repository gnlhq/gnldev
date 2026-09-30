// @gnldev/tool-schema type surface — the core of the mechanism.

/** Tool input schema — JSON Schema node (loose; `any`-friendly across gnl). */
export type JsonSchema = Record<string, any>;

/** Provider identity — for rule matching. */
export interface ModelInfo {
  /** e.g. 'openai', 'google', 'anthropic', 'groq' */
  provider: string;
  /** e.g. 'gpt-4o', 'gemini-1.5-pro', 'claude-3-5-sonnet' */
  modelId: string;
}

/**
 * Extensible tool-schema compatibility rule. Must be PURE: runs BEFORE the model call,
 * never touches the journal, and returns the same output for the same input. Developers can
 * write their own rule and add it to the pipeline (`[...defaultRules, myRule]`).
 */
export interface ToolSchemaRule {
  /** Stable, unique name (for logging/diagnostics). */
  name: string;
  /** Does this rule apply to the given model? */
  shouldApply(model: ModelInfo): boolean;
  /**
   * Transform the JSON Schema (may mutate in place and return the same object). `ctx` is how a rule
   * says what it changed that the tool's own validator will not read back — see `ShapeContext`.
   */
  transform(schema: JsonSchema, model: ModelInfo, ctx?: ShapeContext): JsonSchema;
}

/**
 * Handed to every `transform` by the pipeline. A rule that changes what a well-behaved model SENDS
 * must say so here, because the tool still validates with its OWN schema (compat changes what the
 * model is told, never what the tool accepts). The record is the inverse: nothing is guessed.
 */
export interface ShapeContext {
  /**
   * This node — a property schema, as it now stands in the schema being sent — was widened to accept
   * `null` as the way to say "not supplied". A `null` the model sends there is read as the key being
   * absent before the tool validates. Call it with the node that ends up in the schema (after any
   * wrapping), and do not replace the node afterwards: the record is by identity.
   */
  nullMeansAbsent(node: JsonSchema): void;
  /**
   * The tool's own `strict` flag (OpenAI's strict mode for tool calls), when the tool sets it. A rule
   * that leaves a schema strict mode refuses should throw a `ToolSchemaError` naming the way through.
   */
  strict?: boolean;
}
