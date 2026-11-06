// Node prints "SQLite is an experimental feature" once per process that loads node:sqlite. The engine
// holds back THAT notice and nothing else: another experimental feature's warning, emitted right after
// the load, must still reach stderr. Run in a child process because Node prints the notice once.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/sqlite-storage.js', import.meta.url));
const child = (code: string) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });

describe('node:sqlite notice', () => {
  it('a bare import of node:sqlite warns (the premise)', () => {
    expect(child("await import('node:sqlite')").stderr).toContain('SQLite is an experimental feature');
  });

  it('opening SqliteStorage prints no SQLite notice, and still lets other warnings through', () => {
    const r = child(`await import(${JSON.stringify(dist)}); process.emitWarning('some other feature', 'ExperimentalWarning');`);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('SQLite is an experimental feature');
    expect(r.stderr).toContain('some other feature');
  });
});
