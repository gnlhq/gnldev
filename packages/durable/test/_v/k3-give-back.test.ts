// k3-b2 (3b): a holder gives back what it holds even when the give-back write fails. While the holder's
// process lives, the others read a lock that names it as held — a release that failed once used to keep
// it held for the life of the process. Real Postgres across processes; in-memory where one process is
// the whole story.
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BACKEND, BASE_URL, newStorage, scopeUrl } from './backends.mjs';
import { InMemoryJournal } from '../../src/journal.js';
import { acquireRunLock } from '../../src/run-lock.js';
import { storeLiveness, pendingGiveBacks } from '../../src/process-liveness.js';

const PG_URL = BASE_URL;
const uid = () => `k3gb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CHILD = fileURLToPath(new URL('./k3-give-back-child.mjs', import.meta.url));

/** Makes the journal refuse a lock's RELEASE write (putIfMatch to `expires: 0`) while `arm.n` > 0 (n = Infinity: always). */
function refusing<J extends object>(j: J): { j: J; arm: { n: number } } {
  const arm = { n: 0 };
  const rec = j as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const orig = rec.putIfMatch!.bind(j);
  rec.putIfMatch = async (...a: unknown[]) => {
    if (arm.n > 0 && (a[2] as { expires?: unknown } | undefined)?.expires === 0) { arm.n--; throw new Error('injected: the store refuses the write'); }
    return orig(...a);
  };
  return { j, arm };
}

async function acquireWithin(j: object, key: string, owner: string, ms: number) {
  const t0 = performance.now();
  for (;;) {
    const l = await acquireRunLock(j as never, key, owner, 400);
    if (l || performance.now() - t0 > ms) return { lock: l, ms: Math.round(performance.now() - t0) };
    await pause(50);
  }
}

describe.skipIf(!PG_URL)(`k3-b2 give-back — another process, real ${BACKEND}`, () => {
  let storage: Awaited<ReturnType<typeof newStorage>>;
  let url: string;
  const children: ChildProcess[] = [];
  beforeAll(async () => {
    url = await scopeUrl('give_back');
    storage = await newStorage(url, { src: true });
    await storage.runs.get('warm');
    await storeLiveness(storage.runs, { own: () => storage.processLiveness() });
  });
  afterAll(async () => {
    for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
    await storage.close();
  });

  function child(key: string, mode: 'once' | 'always') {
    const c = spawn(process.execPath, [CHILD, url, key, mode], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(c);
    let out = '';
    let err = '';
    c.stdout!.on('data', (d) => { out += d; });
    c.stderr!.on('data', (d) => { err += d; });
    const until = (word: string) => new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`child never printed ${word}; out=${out} err=${err}`)), 20_000);
      const check = () => { if (out.includes(word)) { clearTimeout(t); resolve(); } else setTimeout(check, 10); };
      check();
    });
    return { c, until };
  }

  it('GB1: the holder\'s release write fails ONCE — another process takes the lock shortly after, the holder still alive', async () => {
    const key = uid();
    const { until } = child(key, 'once');
    await until('RELEASED');
    const r = await acquireWithin(storage.runs, key, 'parent', 3000);
    console.log(`[k3-b2 GB1] taken by another process: ${!!r.lock} after ${r.ms} ms`);
    expect(r.lock).not.toBeNull();
    await r.lock?.release();
  }, 30_000);

  it('GB2: the release write fails ALWAYS — held while the holder lives (correct), free once it is killed', async () => {
    const key = uid();
    const { c, until } = child(key, 'always');
    await until('RELEASED');
    const whileAlive = await acquireWithin(storage.runs, key, 'parent', 800);
    const exited = new Promise((r) => c.on('exit', r));
    c.kill('SIGKILL');
    await exited;
    const afterDeath = await acquireWithin(storage.runs, key, 'parent', 5000);
    console.log(`[k3-b2 GB2] while alive: ${whileAlive.lock ? 'TAKEN' : 'held'}; after SIGKILL: ${afterDeath.lock ? 'taken' : 'HELD'} after ${afterDeath.ms} ms`);
    expect(whileAlive.lock).toBeNull();
    expect(afterDeath.lock).not.toBeNull();
    await afterDeath.lock?.release();
  }, 30_000);

  it('GB2b: the release write fails ALWAYS and the holder closes its store (process alive) — free: its pending give-back goes with the store', async () => {
    const key = uid();
    const { c, until } = child(key, 'always');
    await until('RELEASED');
    c.stdin!.write('close\n');
    await until('CLOSED');
    const r = await acquireWithin(storage.runs, key, 'parent', 5000);
    console.log(`[k3-b2 GB2b] after the holder closed its store: ${r.lock ? 'taken' : 'HELD'} after ${r.ms} ms; holder alive: ${c.exitCode === null}`);
    expect(c.exitCode).toBeNull();
    expect(r.lock).not.toBeNull();
    await r.lock?.release();
  }, 30_000);

  it('GB3 (PG): a late retry of an old release does not free the holder\'s own re-acquisition', async () => {
    const key = uid();
    const { arm } = refusing(storage.runs);
    const first = await acquireRunLock(storage.runs, key, 'A', 400);
    arm.n = 1;
    await first!.release(); // fails once: retried in the background
    const again = await acquireRunLock(storage.runs, key, 'A', 400);
    expect(again).not.toBeNull();
    await pause(600); // the retry of the OLD release has run by now
    const rec = await storage.runs.get<{ token: string; expires: number }>(`${key}:lock`);
    const other = await acquireRunLock(storage.runs, key, 'B', 400);
    console.log(`[k3-b2 GB3 pg] record token is the new one: ${rec?.token === again!.token}; expires in future: ${(rec?.expires ?? 0) > Date.now()}; second owner: ${other ? 'TOOK IT' : 'refused'}; pending: ${pendingGiveBacks()}`);
    expect(rec?.token).toBe(again!.token);
    expect(other).toBeNull();
    expect(pendingGiveBacks()).toBe(0);
    await again!.release();
  }, 30_000);
});

describe('k3-b2 give-back — in memory (one process)', () => {
  it('GB1 (in-memory): a release write that fails once — another owner takes the lock', async () => {
    const { j, arm } = refusing(new InMemoryJournal());
    const key = uid();
    const a = await acquireRunLock(j as never, key, 'A', 400);
    arm.n = 1;
    await a!.release();
    const r = await acquireWithin(j, key, 'B', 2000);
    console.log(`[k3-b2 GB1 mem] taken: ${!!r.lock} after ${r.ms} ms`);
    expect(r.lock).not.toBeNull();
  });

  it('GB3 (in-memory): a late retry of an old release does not free the holder\'s own re-acquisition', async () => {
    const { j, arm } = refusing(new InMemoryJournal());
    const key = uid();
    // No liveness in memory: a lock is judged by its age. The first one expires at 50 ms and is re-acquired
    // at ~60 ms; its refused release is retried at ~+100 ms — after the re-acquisition, against it.
    const first = await acquireRunLock(j as never, key, 'A', 50);
    arm.n = 1;
    await first!.release();
    await pause(60);
    const again = await acquireRunLock(j as never, key, 'A', 5000);
    expect(again).not.toBeNull();
    await pause(1000);
    const rec = await j.get<{ token: string; expires: number }>(`${key}:lock`);
    const other = await acquireRunLock(j as never, key, 'B', 400);
    console.log(`[k3-b2 GB3 mem] token new: ${rec?.token === again!.token}; expires in future: ${(rec?.expires ?? 0) > Date.now()}; second owner: ${other ? 'TOOK IT' : 'refused'}; pending: ${pendingGiveBacks()}`);
    expect(pendingGiveBacks()).toBe(0);
    expect(rec?.token).toBe(again!.token);
    expect(other).toBeNull();
  });

  it('GB4: pending give-backs are bounded — a store that refuses every release does not grow memory without limit', async () => {
    const { j, arm } = refusing(new InMemoryJournal());
    arm.n = Infinity;
    const warn = console.warn;
    let warned = 0;
    console.warn = () => { warned++; };
    try {
      for (let i = 0; i < 1100; i++) {
        const l = await acquireRunLock(j as never, `${uid()}-${i}`, 'A', 60_000);
        await l!.release();
      }
      const peak = pendingGiveBacks();
      arm.n = 0; // the store is back
      for (let t = 0; t < 40 && pendingGiveBacks() > 0; t++) await pause(50);
      console.log(`[k3-b2 GB4] peak pending: ${peak}; warned: ${warned}; after the store came back: ${pendingGiveBacks()}`);
      expect(peak).toBeLessThanOrEqual(1024);
      expect(warned).toBe(1);
      expect(pendingGiveBacks()).toBe(0);
    } finally {
      console.warn = warn;
    }
  });
});
