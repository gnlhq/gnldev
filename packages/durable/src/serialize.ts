import superjson from 'superjson';

// Type-preserving serialization for persistent journals. A real provider's doGenerate
// result may carry fields like Date / undefined / Map; plain JSON loses these, superjson preserves them.

export function serialize(value: unknown): string {
  return superjson.stringify(value);
}

export function deserialize<T = unknown>(text: string): T {
  return superjson.parse(text) as T;
}

/**
 * The value a reader of a store gets: a copy made the way the SQL stores make one (serialize, then
 * parse), so an in-memory store and a SQL store hand back the same thing and a caller's mutation never
 * reaches the stored value.
 */
export function copyValue<T>(value: T): T {
  return value === undefined ? value : deserialize<T>(serialize(value));
}
