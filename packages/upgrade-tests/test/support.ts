// Shared by every upgrade test: open a COPY of a fixture with the current code, scan it raw, and the
// migration contract every fixture must keep.
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { afterEach, expect, it } from 'vitest';
import { SqliteStorage } from '@gnldev/durable/sqlite';

/** The `schema` step of `storage.upgrade()`: whether it ran, and the statements it applied (or, dry, would apply). */
async function schemaStep(s: { upgrade(o: { only: ['schema']; dryRun?: boolean }): Promise<{ steps: Array<{ name: string; ran: boolean; detail?: Record<string, unknown> }> }> }, dryRun = false) {
  const step = (await s.upgrade({ only: ['schema'], dryRun })).steps.find((x) => x.name === 'schema')!;
  return { ran: step.ran, statements: (step.detail?.statements ?? []) as string[] };
}

// Through require: vite resolves a static `node:sqlite` import as a file called `sqlite` and fails.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export const FIXTURES_090 = fileURLToPath(new URL('../fixtures/0.9.0/', import.meta.url));

/** What 0.9.0 did while writing the fixtures (written by the generator beside them). */
export const notes090: Record<string, any> = JSON.parse(readFileSync(join(FIXTURES_090, 'notes-sqlite.json'), 'utf8')).notes;

const opened: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!();
});

export interface OpenedFixture {
  /** The temp copy. The committed fixture is never written to. */
  path: string;
  storage: SqliteStorage;
  /** A second process opening the same file (what a restart does): the constructor migrates again. */
  reopen(): SqliteStorage;
}

/**
 * Copies `fixtures/0.9.0/<file>` to a temp dir and opens it with the current SqliteStorage, after the one
 * upgrade step this version refuses a 0.9.0 file without: `run-status` (0.9.0's status flags into the
 * `status`/`outcome` columns — what `gnl upgrade` runs first; run-status.test.ts proves the refusal and
 * the statuses it keeps). Every other step is left to the test, as before. Closed after each test.
 */
export async function openFixture(file: string): Promise<OpenedFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-upgrade-'));
  const path = join(dir, file);
  copyFileSync(join(FIXTURES_090, file), path);
  const all: SqliteStorage[] = [];
  const open = () => {
    const s = new SqliteStorage(path);
    all.push(s);
    return s;
  };
  opened.push(async () => {
    for (const s of all) await s.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  await open().upgrade({ only: ['run-status'] });
  const storage = open();
  return { path, storage, reopen: open };
}

/** Copies `fixtures/0.9.0/<file>` to a temp dir as 0.9.0 left it — no step run. Removed after each test. */
export function copyFixture(file: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-upgrade-'));
  const path = join(dir, file);
  copyFileSync(join(FIXTURES_090, file), path);
  opened.push(async () => { rmSync(dir, { recursive: true, force: true }); });
  return path;
}

/** Every row, in every table of the file, with a text column containing `needle` — `table[first column]: column=value`. */
export function rowsContaining(path: string, needle: string): string[] {
  const db = new DatabaseSync(path);
  try {
    const out: string[] = [];
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const cols = (db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).map((c) => c.name);
      for (const row of db.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>) {
        for (const c of cols) {
          const v = row[c];
          if (typeof v === 'string' && v.includes(needle)) out.push(`${name}[${String(row[cols[0]!])}]: ${c}=${v.length > 160 ? `${v.slice(0, 160)}…` : v}`);
        }
      }
    }
    return out;
  } finally {
    db.close();
  }
}

/** The schema as SQLite records it, for comparing two opens. */
export function schemaOf(path: string): string[] {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare("SELECT type || ' ' || name || ' ' || coalesce(sql, '') AS s FROM sqlite_master ORDER BY type, name").all() as Array<{ s: string }>).map((r) => r.s);
  } finally {
    db.close();
  }
}

/** Raw rows of one query against the file. */
export function rawQuery<T = Record<string, unknown>>(path: string, sql: string, ...params: Array<string | number>): T[] {
  const db = new DatabaseSync(path);
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

/**
 * The migration contract, the same for every fixture: opening a 0.9.0 file brings it to the current
 * schema, a second open (a restart, another process) changes nothing, and `migrateSchema` then has
 * nothing left to apply.
 */
export function itMigrates(file: string): void {
  it(`${file}: the current code migrates the 0.9.0 schema once, and a second open changes nothing`, async () => {
    const f = await openFixture(file);
    const check = await f.storage.checkSchema();
    expect(check, JSON.stringify(check)).toMatchObject({ ok: true, missingTables: [], missingColumns: [] });
    const first = schemaOf(f.path);
    const again = f.reopen();
    expect((await schemaStep(again)).statements).toEqual([]);
    expect((await schemaStep(again)).statements).toEqual([]);
    expect(schemaOf(f.path)).toEqual(first);
    // The additive work-store migration of [Unreleased] is there.
    const cols = rawQuery<{ name: string }>(f.path, 'PRAGMA table_info(gnl_work_log)').map((c) => c.name);
    expect(cols).toContain('seq');
    expect(rawQuery(f.path, "SELECT name FROM sqlite_master WHERE name = 'gnl_work_seq'")).toHaveLength(1);
  });
}
