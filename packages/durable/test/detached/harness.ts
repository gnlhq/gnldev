// Spawns detached-node.ts app processes and talks to them over HTTP. Real OS processes: SIGSTOP,
// SIGCONT, SIGKILL and SIGTERM are the kernel's, not simulated.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnFixtureEnv } from '../fixtures/watchdog.js';
import { createDatabaseSync, dropDatabaseSync } from '../../../../test/support/pg-admin.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tsxBin = join(dirname(require.resolve('tsx/package.json')), 'dist/cli.mjs');
const script = join(here, '..', 'fixtures', 'detached-node.ts');
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const PG_BASE = process.env.GNL_PG_URL;

export interface Store { kind: 'sqlite' | 'postgres'; where: string; dir: string; effects: string; drop(): void }

let dbSeq = 0;
export function newStore(kind: 'sqlite' | 'postgres', dbPrefix = 'm3cdetached'): Store {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-detached-'));
  const effects = join(dir, 'effects.log');
  if (kind === 'sqlite') return { kind, where: join(dir, 'runs.db'), dir, effects, drop() {} };
  const name = `${dbPrefix}_${process.pid}_${Date.now().toString(36)}_${dbSeq++}`;
  const where = createDatabaseSync(name);
  return { kind, where, dir, effects, drop() { dropDatabaseSync(name); } };
}

export interface Node { child: ChildProcess; port: number; pid: number; kill(sig: NodeJS.Signals): void; exited: Promise<number | null>; stderr: () => string; url(p: string): string }

let nodeSeq = 0;
export async function startNode(store: Store, envExtra: Record<string, string> = {}, fixture = script): Promise<Node> {
  const ready = join(store.dir, `ready-${nodeSeq++}`);
  const child = spawn(process.execPath, [tsxBin, fixture, store.kind, store.where, ready, store.effects], {
    stdio: ['ignore', 'ignore', 'pipe'], env: { ...spawnFixtureEnv(), ...envExtra },
  });
  let err = '';
  child.stderr!.on('data', (d) => { err += String(d); });
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  for (let i = 0; i < 300 && !existsSync(ready); i++) await sleep(50);
  if (!existsSync(ready)) throw new Error(`node did not start: ${err}`);
  // The app process itself — tsx runs it as a CHILD of the spawned wrapper, so signals go to this pid.
  const [port, pid] = readFileSync(ready, 'utf8').split(' ').map(Number) as [number, number];
  const kill = (sig: NodeJS.Signals) => { try { process.kill(pid, sig); } catch { /* gone */ } };
  return { child, port, pid, kill, exited, stderr: () => err, url: (p) => `http://127.0.0.1:${port}${p}` };
}

export async function post(node: Node, path: string, body: unknown): Promise<Response> {
  return fetch(node.url(path), { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

/** Reads an NDJSON event stream; `stopWhen` may end it early (the client leaves). */
export async function readEvents(res: Response, stopWhen?: (ev: any, all: any[]) => boolean): Promise<any[]> {
  const out: any[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line) continue;
      const ev = JSON.parse(line);
      out.push(ev);
      if (stopWhen?.(ev, out)) { await reader.cancel(); return out; }
    }
  }
  return out;
}

export function effectCount(store: Store): number {
  return existsSync(store.effects) ? readFileSync(store.effects, 'utf8').split('\n').filter(Boolean).length : 0;
}
export function linesOf(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
}
export async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await sleep(25); }
  throw new Error(`timed out waiting for ${what}`);
}
export async function stopNode(n: Node): Promise<void> {
  if (n.child.exitCode === null && n.child.signalCode === null) { n.kill('SIGCONT'); n.kill('SIGKILL'); n.child.kill('SIGKILL'); }
  await n.exited;
}
