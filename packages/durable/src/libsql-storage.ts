// @gnldev/durable/libsql — a libSQL database FILE, run by the Sqlite store on the libSQL driver: the
// same schema, the same statements and the same guarantees as SqliteStorage, measured by the same
// conformance kit (34 of 34 scenarios, liveness included; two OS processes racing on one file left
// one winner in every round of claim, compare-and-set and run-lock takeover).
//
// Only a file. The libSQL driver opens two other kinds of database, and this store refuses both where
// it is made, because a promise cannot be kept on either (measured, ADR-0009's first new backend):
//
// - An EMBEDDED REPLICA (`syncUrl`). Its writes go to the remote primary and its reads come from the
//   local copy, so a write is not read back until the copy syncs. The kit failed 29 of its 34
//   scenarios there — a claim among them: two callers could each take the same call.
// - A REMOTE database (`libsql:`, `http(s):`, `ws(s):`). A remote libSQL server has no session a
//   process holds the way it holds a Postgres advisory lock, so whether another process is alive can
//   only be told by a lease it renews; a live process that stalls past its lease is then judged dead
//   and its call taken over. Measured: the side effect ran twice, 3 of 3 (on a file, and on Postgres,
//   once).
//
// `libsql` is an optional peer dependency: a node:sqlite user installs no native binary for it.
import { createRequire } from 'node:module';
import { refuseUnknownNames, optionNames } from '@gnldev/options';
import { SqliteStorage } from './sqlite-storage.js';

/**
 * Options a libSQL driver offers that this store does NOT take, named so that passing one says why
 * instead of "unknown option". There is nothing to configure on a local file.
 */
export interface LibsqlStorageOptions {
  /** Refused: an embedded replica does not read back its own writes until it syncs (see the module comment). */
  syncUrl?: never;
  /** Refused: a token is for a remote database, which this store does not open (see the module comment). */
  authToken?: never;
}
const LIBSQL_STORAGE_NAMES = optionNames<LibsqlStorageOptions>()(['syncUrl', 'authToken']);

const REMOTE = /^(libsql|https?|wss?):/i;

const REPLICA_REFUSED =
  "@gnldev/durable: LibsqlStorage does not open an embedded replica (`syncUrl`). Its writes go to the remote primary and its reads come from the local copy, so a write is not read back until the copy syncs — a claim could be taken by two callers, and the conformance kit fails on it. Open the libSQL file on its own (`new LibsqlStorage(path)`), or use PostgresStorage for a database several hosts share.";

const REMOTE_REFUSED = (what: string) =>
  `@gnldev/durable: LibsqlStorage opens a local libSQL file, not a remote database (${what}). A remote libSQL server has no session a process holds, so another process's liveness could only be told by a lease — and a live process that stalled past it would be taken over, running a side effect twice (measured). Use a local file, or PostgresStorage for a database several hosts share.`;

/** The libSQL driver, loaded when a store is made: it is an optional peer dependency. */
function libsqlDriver(): new (path: string) => unknown {
  try {
    return createRequire(import.meta.url)('libsql') as new (path: string) => unknown;
  } catch (e) {
    throw new Error("@gnldev/durable: LibsqlStorage needs the `libsql` package — install it beside @gnldev/durable (`npm i libsql`).", { cause: e });
  }
}

/** The arguments refused before anything is opened, so a refused store leaves nothing on disk. */
function refuseWhatCannotBeKept(path: string, opts: LibsqlStorageOptions): void {
  const given = opts as Record<string, unknown>;
  if (given.syncUrl !== undefined) throw new Error(REPLICA_REFUSED);
  if (given.authToken !== undefined) throw new Error(REMOTE_REFUSED('an `authToken` was given'));
  refuseUnknownNames('LibsqlStorage', opts, LIBSQL_STORAGE_NAMES);
  if (REMOTE.test(path)) throw new Error(REMOTE_REFUSED(`'${path.slice(0, path.indexOf(':') + 1)}' is a remote address`));
}

/**
 * A store on a libSQL database file: `new LibsqlStorage('./runs.db')`. Everything else is
 * SqliteStorage's — upgrade, liveness, the stores it offers, `close()`.
 */
export class LibsqlStorage extends SqliteStorage {
  constructor(path = ':memory:', opts: LibsqlStorageOptions = {}) {
    refuseWhatCannotBeKept(path, opts);
    super(path);
  }

  protected override openDatabase(path: string): unknown {
    const Database = libsqlDriver();
    return new Database(path);
  }
}
