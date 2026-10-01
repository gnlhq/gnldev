// A rolling deploy: a 0.9.0 process and the current code on one SQLite file at the same time. The 0.9.0
// side runs in a child process (run-0.9.0.mjs) with the code from GNL_090_ROOT — a built checkout of
// the 0.9.0 tag, or `node generate/load-0.9.0.mjs <dir>` (the published packages, ~8 s). Skipped when
// GNL_090_ROOT is not set. See CHANGELOG [Unreleased] › Known limits for the contract.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BasicMemory, toJournal } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { createConsumer, emit } from '@gnldev/events';
import { createWorker, enqueue } from '@gnldev/queue';
import { SemanticMemory } from '@gnldev/rag';
import * as w from '@gnldev/workflow';
import * as S from '../../generate/shapes.mjs';

const ROOT_090 = process.env.GNL_090_ROOT;
const HELPER = fileURLToPath(new URL('./run-0.9.0.mjs', import.meta.url));

/** One action by a 0.9.0 process on `file`. */
function as090(action: string, file: string, arg = ''): { ok: true; value: any } | { ok: false; error: string } {
  const r = spawnSync(process.execPath, ['--no-warnings', HELPER, action, file, arg], { encoding: 'utf8', env: { ...process.env, GNL_090_ROOT: ROOT_090 } });
  const line = r.stdout.trim().split('\n').at(-1);
  if (!line) throw new Error(`the 0.9.0 process printed nothing (exit ${r.status}): ${r.stderr.slice(-800)}`);
  return JSON.parse(line);
}

const dirs: string[] = [];
const stores: SqliteStorage[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** A file the current code opened first (as after the deploy's migration), and that open. */
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-rolling-'));
  dirs.push(dir);
  const file = join(dir, 'shared.db');
  const storage = new SqliteStorage(file);
  stores.push(storage);
  return { file, storage };
}
const plainWorker = (storage: SqliteStorage, ran: string[]) =>
  createWorker(storage, { plain: async (p: { n: string }) => { ran.push(p.n); } }, { maxAttempts: 2, heartbeat: false });
const consumer = (storage: SqliteStorage, seen: string[]) =>
  createConsumer(storage.work, S.EVENTS.topic, async (p: { n: string }) => { seen.push(p.n); }, { name: S.EVENTS.consumer });
const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe.skipIf(!ROOT_090)('rolling deploy with a 0.9.0 process — queue and events (Known limits: what holds)', () => {
  it('jobs a 0.9.0 producer enqueues after the current worker has a cursor are run by it, once', async () => {
    const { file, storage } = fresh();
    const ran: string[] = [];
    for (const n of many('new', 60)) await enqueue(storage.work, 'plain', { n }, { id: n });
    await plainWorker(storage, ran).drain();
    expect(as090('enqueue', file, '3')).toMatchObject({ ok: true });
    await plainWorker(storage, ran).drain();
    expect(ran.filter((n) => n.startsWith('old')).sort()).toEqual(many('old', 3));
    expect(new Set(ran).size).toBe(ran.length);
  });

  it('events a 0.9.0 producer emits after the current consumer has a cursor are delivered by it, once', async () => {
    const { file, storage } = fresh();
    const seen: string[] = [];
    for (const n of many('new', 60)) await emit(storage.work, S.EVENTS.topic, { n }, { id: n });
    await consumer(storage, seen).poll();
    expect(as090('emit', file, '3')).toMatchObject({ ok: true });
    await consumer(storage, seen).poll();
    expect(seen.filter((n) => n.startsWith('old')).sort()).toEqual(many('old', 3));
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe.skipIf(!ROOT_090)('rolling deploy with a 0.9.0 process — a 0.9.0 worker or consumer beside the current one (Known limits: a re-scan, not a lost or repeated record)', () => {
  it('a 0.9.0 worker after the current one runs nothing the current one ran, and the current one then runs what 0.9.0 left', async () => {
    const { file, storage } = fresh();
    const ran: string[] = [];
    for (const n of many('new', 60)) await enqueue(storage.work, 'plain', { n }, { id: n });
    await plainWorker(storage, ran).drain();
    const old = as090('drain', file);
    expect(old).toEqual({ ok: true, value: [] });
    expect(as090('enqueue', file, '2')).toMatchObject({ ok: true });
    await plainWorker(storage, ran).drain();
    expect(ran.filter((n) => n.startsWith('old')).sort()).toEqual(many('old', 2));
    expect(new Set(ran).size).toBe(ran.length);
  });

  it('a 0.9.0 consumer after the current one delivers nothing the current one delivered', async () => {
    const { file, storage } = fresh();
    const seen: string[] = [];
    for (const n of many('new', 60)) await emit(storage.work, S.EVENTS.topic, { n }, { id: n });
    await consumer(storage, seen).poll();
    expect(as090('poll', file)).toEqual({ ok: true, value: [] });
    await consumer(storage, seen).poll();
    expect(seen).toHaveLength(60);
  });
});

describe.skipIf(!ROOT_090)('rolling deploy with a 0.9.0 process — records written now, read by 0.9.0 (CHANGELOG: "a journal written now is not for 0.9.0")', () => {
  it('a 0.9.0 agent turn on a BasicMemory thread written now fails loudly, and loses none of it', async () => {
    const { file, storage } = fresh();
    const bm = new BasicMemory(toJournal(storage.runs));
    await bm.append('t', [{ role: 'user', content: 'now 1' }, { role: 'assistant', content: 'now 2' }]);
    const r = as090('basicRun', file, 't');
    expect(r.ok).toBe(false);
    expect((await bm.getMessages('t')).map((m: any) => m.content)).toEqual(['now 1', 'now 2']);
  });

  it('a 0.9.0 agent turn on a SemanticMemory thread written now fails loudly, and loses none of it', async () => {
    const { file, storage } = fresh();
    const sm = new SemanticMemory({ journal: toJournal(storage.runs), embed: S.fixtureEmbed });
    await sm.append('ts', [{ role: 'user', content: 'now s' }]);
    expect(as090('semanticRun', file, 'ts').ok).toBe(false);
    expect((await sm.getMessages('ts')).map((m: any) => m.content)).toEqual(['now s']);
  });

  // The two below PIN what 0.9.0 does, which no change here can alter: it is silent, not loud. The
  // CHANGELOG says only that a journal written now "is not for 0.9.0"; its Known limits (rolling
  // deploy) name the queue and events, not these. If that section ever promises more, these say whether
  // the promise is true.
  it("0.9.0's BasicMemory.getMessages on a log written now returns the stored `{ gnlLog, parts }` record, not the messages and not an error", async () => {
    const { file, storage } = fresh();
    await new BasicMemory(toJournal(storage.runs)).append('t', [{ role: 'user', content: 'now 1' }]);
    const r = as090('basicRead', file, 't');
    expect(r).toMatchObject({ ok: true, value: { gnlLog: 1 } });
  });

  it('a 0.9.0 process resuming a run after a void step written now hands the next step the record marker instead of undefined', async () => {
    const { file, storage } = fresh();
    const calls: string[] = [];
    await expect(S.voidThenUseWorkflow(w, calls, { crash: true }).run(1, { runId: 'vu', journal: toJournal(storage.runs) })).rejects.toThrow(/crashed/);
    const r = as090('voidThenUse', file, 'vu');
    expect(r).toEqual({ ok: true, value: { receivedUndefined: false, received: { __gnlStepRecord: 'void' } } });
  });
});
