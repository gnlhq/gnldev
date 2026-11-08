// d25 U9 — `gnl runs` must end when it has answered. Measured: it prints, then the process never exits on MySQL / MongoDB
// (and lingers ~11 s on Postgres) because the storage it opened is never closed (`pending`/`upgrade` do close theirs).
// Needs a real server per backend (GNL_PG_URL / GNL_MYSQL_URL / GNL_MONGO_URL, as in CI); sqlite always runs.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const cli = join(__dirname, '..', 'dist', 'cli.js');
const cfg = (k: string) => join(__dirname, 'd25-u9', `gnl.config.${k}.ts`);
const LIMIT_MS = 20_000;
function runsExit(k: string, command: string[] = ['runs']): Promise<{ exited: boolean; ms: number; out: string }> {
  return new Promise((res) => {
    const t0 = Date.now(); let out = '';
    const p = spawn('node', [cli, ...command, '--config', cfg(k)], { cwd: join(__dirname, '..') });
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => { p.kill('SIGKILL'); res({ exited: false, ms: Date.now() - t0, out }); }, LIMIT_MS);
    p.on('exit', () => { clearTimeout(timer); res({ exited: true, ms: Date.now() - t0, out }); });
  });
}
const NEEDS: Record<string, string | undefined> = { sqlite: undefined, pg: 'GNL_PG_URL', mysql: 'GNL_MYSQL_URL', mongo: 'GNL_MONGO_URL' };
describe('U9 gnl runs exits', () => {
  for (const k of ['sqlite', 'pg', 'mysql', 'mongo']) {
    it.skipIf(NEEDS[k] !== undefined && !process.env[NEEDS[k]!])(`${k}: process ends within ${LIMIT_MS / 1000}s of printing`, async () => {
      const r = await runsExit(k);
      console.log(`${k}: exited=${r.exited} after ${r.ms} ms; output=${JSON.stringify(r.out.trim().slice(0, 60))}`);
      expect(r.exited).toBe(true);
      expect(r.ms).toBeLessThan(5_000);
    }, 40_000);
  }
});

// The fix is the dispatcher's, so it covers every one-shot command — not only `runs`. Each ends (with whatever
// exit code its own logic gives a missing id) within seconds of answering, on the backends that held the process open.
describe('U9 the other one-shot commands end too', () => {
  for (const k of ['mysql', 'mongo']) {
    for (const command of [['run', 'no-such-run'], ['inspect', 'no-such-run'], ['sweep'], ['pending'], ['resume', 'no-such-run'], ['fork', 'no-such-run'], ['pricing']]) {
      it.skipIf(!process.env[NEEDS[k]!])(`${k}: gnl ${command.join(' ')}`, async () => {
        const r = await runsExit(k, command);
        expect(r.exited).toBe(true);
        expect(r.ms).toBeLessThan(5_000);
      }, 40_000);
    }
  }
});
