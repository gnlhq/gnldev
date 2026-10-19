// A MongoDB liveness that has closed is dead to another process as soon as `close()` returns.
//
// The server drops a closed connection from `$currentOp` a moment after the client closes it. Measured
// before (2026-10-19, raporlar/2026-10-19-mongo-close): 12 processes closing at once, the closed liveness
// still read alive right after `close()` in 252 of 1,200 closes (0 of 1,200 on Postgres and on MySQL).
// It failed the storage kit's P1 in the public CI. Reading a closed process alive only delays a takeover,
// but `close()` is the moment a process says it holds nothing; `mongoLiveness` returns from it once no
// connection of its name is left. Separate processes: closes from one event loop did not show it.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnFixtureEnv } from './fixtures/watchdog.js';
import { MONGO_URL, freshMongoDatabase } from './real-backends.js';

const here = dirname(fileURLToPath(import.meta.url));
const tsxLoader = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'loader.mjs');

const closer = (url: string, rounds: number) => new Promise<number>((resolve, reject) => {
  const p = spawn(process.execPath, ['--import', tsxLoader, join(here, 'fixtures', 'closing-mongo-livenesses.ts'), url, String(rounds)], { stdio: ['ignore', 'pipe', 'pipe'], env: spawnFixtureEnv() });
  let out = '', err = '';
  p.stdout!.on('data', (d) => { out += d; });
  p.stderr!.on('data', (d) => { err += d; });
  p.on('exit', (code) => (code === 0 ? resolve(Number(out.trim())) : reject(new Error(`closer exited ${code}: ${err.slice(-500)}`))));
});

describe.skipIf(!MONGO_URL)('a closed MongoDB liveness is dead to another process at once', () => {
  it('12 processes closing at once: none still alive right after close()', async () => {
    const url = freshMongoDatabase();
    const alive = (await Promise.all(Array.from({ length: 12 }, () => closer(url, 25)))).reduce((a, b) => a + b, 0);
    expect(alive, 'closed livenesses still read alive (of 300)').toBe(0);
  }, 120_000);
});
