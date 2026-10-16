// AUDIT ROUND 2 (red): C1's fix keys Sqlite liveness by the file's REAL PATH (process-liveness.ts
// sqliteLivenessDir). A hard link is a second path to the same file that realpath does not fold: two
// processes opening one database through two hard links look in two lock directories, and each reads the
// other's live holder as dead — C1 again.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, linkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteLiveness, sqliteLivenessDir } from '../../src/process-liveness.js';

describe('Sqlite liveness is keyed by the database file', () => {
  it('two hard links to one file share one lock directory, and see each other alive', async () => {
    const d = mkdtempSync(join(tmpdir(), 'a2-hl-'));
    const a = join(d, 'app.db');
    const b = join(d, 'same-file.db');
    writeFileSync(a, '');
    linkSync(a, b);
    const la = sqliteLiveness(a);
    const lb = sqliteLiveness(b);
    try {
      expect({ sameDir: sqliteLivenessDir(a) === sqliteLivenessDir(b), bSeesA: await lb.isAlive(la.id) }).toEqual({ sameDir: true, bSeesA: true });
    } finally { await la.close(); await lb.close(); }
  });
});
