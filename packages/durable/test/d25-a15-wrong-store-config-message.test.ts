// d25 A15 second half (cli/KARAR-7, option A): a store given in the wrong shape is answered with what was given and
// the right option, from one validation point in createGnl. Reported: `journal: { kind: 'mysql' }` →
// "missing putIfAbsent, putIfMatch…" (what the engine lacks, not what the reader got wrong); `storage: { kind }` or a
// connection string → "`storage` or `journal` is required" although `storage` WAS given.
// Option A's wording: "`storage` must be a Storage instance (new SqliteStorage/PostgresStorage/MysqlStorage/
// MongoStorage), got <type>"; for a plain `journal` object: "journal expects a Journal object; to use MySQL/PG/...
// pass `storage: new MysqlStorage({ connectionString })`". "got <type>" — the TYPE, so a connection string's
// password is not echoed into logs.
//
// Builds on fix/d25-cli 9602dd83 (the constructor cases there were green already; kept as controls).
import { describe, it, expect } from 'vitest';
import { createGnl } from '../src/index.js';
import { MongoStorage } from '../src/mongo-storage.js';
import { MysqlStorage } from '../src/mysql-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';

const msg = (f: () => unknown) => { try { f(); return 'NO ERROR'; } catch (e: any) { return String(e?.message ?? e); } };

describe('A15/KARAR-7: createGnl names what was given and the right option', () => {
  it("reported — journal: { kind: 'mysql' } points at storage: new MysqlStorage(...)", () => {
    const m = msg(() => createGnl({ journal: { kind: 'mysql' } as any, agents: {} }));
    expect(m).toMatch(/storage/);
    expect(m).toMatch(/new \w*Storage|MysqlStorage/);
    expect(m).not.toMatch(/putIfAbsent/);
  });
  it("sibling — storage: { kind: 'mysql' } says storage must be a Storage instance (not 'is required')", () => {
    const m = msg(() => createGnl({ storage: { kind: 'mysql' } as any, agents: {} }));
    expect(m).toMatch(/Storage instance|new \w+Storage/);
    expect(m).not.toMatch(/is required/);
  });
  it("sibling — storage: 'mysql://u:secretpw@localhost/db' says a string was given, without echoing the password", () => {
    const m = msg(() => createGnl({ storage: 'mysql://u:secretpw@localhost/db' as any, agents: {} }));
    expect(m).toMatch(/new \w+Storage/);
    expect(m).toMatch(/string/i);
    expect(m).not.toMatch(/is required/);
    expect(m).not.toContain('secretpw');
  });
  it('control (green) — nothing given at all still says storage or journal is required', () => {
    expect(msg(() => createGnl({ agents: {} } as any))).toMatch(/storage.*journal|journal.*storage/);
  });
});

describe('A15/KARAR-7 controls (green on 0.17.1): constructors already name their real options', () => {
  const cases: Array<[string, () => unknown]> = [
    ['new MongoStorage(url string)', () => new (MongoStorage as any)('mongodb://h/db')],
    ['new MongoStorage({ url })', () => new MongoStorage({ url: 'mongodb://h/db' } as any)],
    ['new MysqlStorage({ url })', () => new MysqlStorage({ url: 'mysql://h/db' } as any)],
    ['new PostgresStorage({ url })', () => new PostgresStorage({ url: 'postgres://h/db' } as any)],
  ];
  for (const [label, f] of cases) it(label, () => { expect(msg(f)).toMatch(/connectionString/); });
});
