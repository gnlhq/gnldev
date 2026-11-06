// `node:sqlite`, loaded without Node's one-line "SQLite is an experimental feature" notice.
//
// Node (>= 22.13) prints that notice on the first load of the module, in every process that opens a
// `SqliteStorage` — each `gnl` command, each test, each dev server restart. It is a statement about
// Node's API surface, not about anything a project can act on, and it buried the lines that are.
//
// ONLY that notice is held back: the filter matches the warning's type (`ExperimentalWarning`) AND
// its text, it lives for exactly the one synchronous `require` that triggers the notice (nothing else
// can emit inside it), and `process.emitWarning` is put back in a `finally`. Every other warning —
// another experimental feature, a deprecation, the same notice from a different module — passes.
import { createRequire } from 'node:module';

type DatabaseSyncCtor = new (path: string) => any;

const SQLITE_NOTICE = /^SQLite is an experimental feature\b/;

export function requireNodeSqlite(from: string): { DatabaseSync: DatabaseSyncCtor } {
  const original = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (type === 'ExperimentalWarning' && typeof text === 'string' && SQLITE_NOTICE.test(text)) return;
    return (original as (...a: unknown[]) => void).call(this ?? process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return createRequire(from)('node:sqlite') as { DatabaseSync: DatabaseSyncCtor };
  } finally {
    process.emitWarning = original;
  }
}
