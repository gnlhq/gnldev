// k3-b2 child process: holds a run lock in real Postgres, then releases it while the store refuses the
// release write (once, or always) — and stays alive. Prints ACQUIRED / RELEASED; on stdin 'close' it
// closes its store (and prints CLOSED) but keeps running.
// argv: <pgUrl> <key> <once|always>
import { newStorage } from './backends.mjs';
import { acquireRunLock } from '../../dist/run-lock.js';
import { storeLiveness } from '../../dist/process-liveness.js';

const [pgUrl, key, mode] = process.argv.slice(2);
const storage = await newStorage(pgUrl);
await storage.runs.get('warm');
await storeLiveness(storage.runs, { own: () => storage.processLiveness() });
const j = storage.runs;
const orig = j.putIfMatch.bind(j);
let armed = false;
j.putIfMatch = async (...a) => {
  if (armed) { if (mode === 'once') armed = false; throw new Error('injected: the store refuses the write'); }
  return orig(...a);
};
const lock = await acquireRunLock(j, key, 'child', 400);
process.stdout.write(lock ? 'ACQUIRED\n' : 'NOT_ACQUIRED\n');
armed = true;
await lock.release();
process.stdout.write('RELEASED\n');
process.stdin.on('data', async (d) => {
  if (String(d).includes('close')) { await storage.close(); process.stdout.write('CLOSED\n'); }
});
setInterval(() => {}, 1 << 30);
