// d25 U6 — after kill -9 mid-tool, a restarted process should continue the run on its own (executor sweep).
// Measured: for a run born from a `workKey` (derived id, what the chat door uses once the user is known) the
// takeover is refused with RunInputMismatchError (only a console.warn), the run stays `running`, and the client's
// reconnect gets 200 with no answer. A run born from a plain `runId` is adopted fine (control).
// Two real OS processes over one SQLite file; the first dies by SIGKILL inside the tool body.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROC = join(__dirname, 'd25-u6', 'proc.ts');
const run = (phase: string, file: string, idMode: string, wait = 0, preset = 'assistant') =>
  spawnSync('npx', ['tsx', PROC, phase, file, 'mem', 'x'], { env: { ...process.env, ID_MODE: idMode, WAIT_MS: String(wait), PRESET: preset }, encoding: 'utf8', cwd: join(__dirname, '..') });

// fix/0171-core: the 'critical' profile too — its `strictInput` refused the takeover of a plain runId the same way.
for (const [idMode, preset] of [['runid', 'assistant'], ['workkey', 'assistant'], ['runid', 'critical'], ['workkey', 'critical']] as const) {
  describe(`U6 crash + restart, id from ${idMode}${preset === 'critical' ? ", preset 'critical'" : ''}`, () => {
    it('restarted process continues the crashed run by itself, and the reconnect gets the answer', () => {
      const file = join(mkdtempSync(join(tmpdir(), 'd25u6-')), 'j.db');
      run('crash', file, idMode, 0, preset);
      const r = run('retry', file, idMode, 3000, preset);
      const out = (r.stdout ?? '') + (r.stderr ?? '');
      console.log(`[${idMode}]`, out.split('\n').filter((l) => /EFFECTS_AFTER_WAIT|could not be continued|RESULT/.test(l)).map((l) => l.slice(0, 200)).join('\n'));
      const after = Number(/EFFECTS_AFTER_WAIT (\d+)/.exec(out)?.[1]);
      expect(after).toBe(2);                           // warm-up (1) + the crashed run's tool, run by the sweep (2)
      expect(out).not.toMatch(/could not be continued here/);
      expect(/RESULT .*"text":"paid"/.test(out)).toBe(true);
    }, 60_000);
  });
}
