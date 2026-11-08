// d25 P4: drives d25-resume/proc.ts — a crash process, then a restarted process over the same store.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseSync, dropDatabaseSync } from '../../../../test/support/pg-admin.js';

const PROC = join(__dirname, 'proc.ts');
const TSX = join(__dirname, '..', '..', '..', '..', 'node_modules', '.bin', 'tsx');

export type Lines = Record<string, any>;
export function phase(name: string, env: Record<string, string>): { status: number | null; out: string; lines: Lines } {
  const r = spawnSync(TSX, [PROC], { env: { ...process.env, PHASE: name, ...env }, encoding: 'utf8', cwd: join(__dirname, '..', '..'), timeout: 100_000 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const lines = Object.fromEntries(out.split('\n').filter((l) => /^[A-Z_0-9]+ \{/.test(l)).map((l) => [l.slice(0, l.indexOf(' ')), JSON.parse(l.slice(l.indexOf(' ') + 1))]));
  return { status: r.status, out, lines };
}

/** A fresh store: SQLite file (default) or a database of its own on GNL_PG_URL's server (`dispose` drops it). */
export function freshStore(backend: 'sqlite' | 'pg'): { env: Record<string, string>; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'd25-p4-'));
  const base = { EFFECTS: join(dir, 'eff') };
  if (backend === 'sqlite') return { env: { ...base, BACKEND: 'sqlite', DB: join(dir, 'j.db') }, dispose: () => undefined };
  const db = `p4_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const url = createDatabaseSync(db);
  return { env: { ...base, BACKEND: 'pg', DB: url }, dispose: () => dropDatabaseSync(db) };
}

export function crashThenServe(crash: Record<string, string>, serve: Record<string, string> = crash, backend: 'sqlite' | 'pg' = 'sqlite') {
  const store = freshStore(backend);
  try {
    const c = phase('crash', { ...store.env, ...crash });
    const s = phase('serve', { ...store.env, ...serve });
    return { c, s };
  } finally { store.dispose(); }
}
export const PG = process.env.GNL_PG_URL;
