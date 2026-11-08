// d25 U6, end to end: a turn of the AUTHENTICATED chat (the route knows the user, so the turn is a workKey and
// its run a derived `run1_` id) whose process is killed inside the payment tool is continued by the next
// process on its own — and the client that sends the same turn again gets the answer, never an empty 200.
// Before the fix the takeover was refused as "different work" (RunInputMismatchError, a console.warn), the run
// stayed parked for good and the reconnect read `start, tool-call` and nothing after it.
//
// Two real OS processes over one store, built packages (dist) as a deployment runs them. The effect is a line
// in a file outside the store and `recover` asks that file honestly, so "exactly once" is counted where the
// money would be: killed BEFORE the effect, the second process charges once; killed AFTER it, recover finds
// the charge and nothing is charged again. Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseSync, dropDatabaseSync } from '../../../test/support/pg-admin.js';

const PROC = join(__dirname, 'fixtures', 'workkey-takeover-proc.ts');
// The retry waits long enough for its executor's sweep to have continued the run before the client comes back
// (EFFECTS_BEFORE_RETRY says whether it did): the run must move on its own, not only on the client's request.
const child = (phase: string, store: string, kill: string, effects: string) =>
  spawnSync('npx', ['tsx', PROC, phase, store, kill, effects], { env: { ...process.env, WAIT_MS: store.startsWith('postgres') ? '8000' : '3000' }, encoding: 'utf8', cwd: join(__dirname, '..'), timeout: 60_000 });

const PG_URL = process.env.GNL_PG_URL;
const ends: Array<() => unknown> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });
const stores: Array<[string, () => Promise<string>]> = [['sqlite', async () => join(mkdtempSync(join(tmpdir(), 'u6wk-')), 'j.db')]];
if (PG_URL) {
  stores.push(['postgres (real)', async () => {
    const db = `u6wk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const url = createDatabaseSync(db);
    ends.push(() => dropDatabaseSync(db));
    return url;
  }]);
}

describe.each(stores)('workKey chat turn killed mid-tool, continued by the next process — %s', (_name, makeStore) => {
  for (const kill of ['before', 'after']) {
    it(`killed ${kill} the effect: continued once, the reconnect gets the answer`, async () => {
      const store = await makeStore();
      const effects = join(mkdtempSync(join(tmpdir(), 'u6wk-fx-')), 'effects.txt');
      const crash = child('crash', store, kill, effects);
      expect(crash.signal === 'SIGKILL' || crash.status === 137).toBe(true); // npx reports its child's SIGKILL as 137
      const r = child('retry', store, kill, effects);
      const out = (r.stdout ?? '') + (r.stderr ?? '');
      console.log(`[${_name}/${kill}]`, out.split('\n').filter((l) => /EFFECTS_BEFORE_RETRY|RESULT|could not be continued/.test(l)).join('\n'));
      const result = JSON.parse(/RESULT (.*)/.exec(out)?.[1] ?? '{}');
      expect(out).not.toMatch(/could not be continued/);
      expect(result.status).toBe(200);
      expect(result.derived).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.text).toBe('paid');
      // The money: one charge in the outside world, whichever side of it the process died on.
      const lines = existsSync(effects) ? readFileSync(effects, 'utf8').split('\n').filter(Boolean) : [];
      expect(lines.length).toBe(1);
      // …and it was there before the client came back: the next process continued the run on its own.
      expect(Number(/EFFECTS_BEFORE_RETRY (\d+)/.exec(out)?.[1])).toBe(1);
    }, 120_000);
  }
});
