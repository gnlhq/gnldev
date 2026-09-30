/**
 * A rule's refusal: the schema it would produce is one the provider refuses, and the message names
 * the way through. Unlike any other error a rule throws (which skips that rule and keeps the tool),
 * this one propagates — a tool the provider will refuse must not be sent as if nothing were wrong.
 */
export class ToolSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolSchemaError';
  }
}
