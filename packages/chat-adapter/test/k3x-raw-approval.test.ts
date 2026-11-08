// K3 decision item 2: the crash ladder's "it MAY have already run" question, answered with the PROVIDER's own id
// (`approvals: { call_0: true }`, what every pre-0.17.1 client sends). Run over REST /run and /resume, real kill -9.
//   one call in doubt            → the raw key is accepted as an alias: the work runs ONCE (effects: the crashed one + 1).
//   two calls in doubt, same id  → `approval_key_ambiguous` (typed, 409), nothing recorded, nothing run. Two calls of
//     one run cannot both be in doubt through the public doors (the run stops at the first), so the second is the
//     first's record copied under the next step's GNL id: the state a run that retried across steps could leave.
// Control: the GNL id (named in the refusal text) is accepted today.
import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintCallId, runKeys } from '@gnldev/durable';
import { buildApi, effectsOf, openStorage, runRequest, turnBody } from './k3x/lib.js';

const ROOT = join(__dirname, '..', '..', '..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const PG_URL = process.env.GNL_PG_URL;
const durableRequire = createRequire(join(ROOT, 'packages', 'durable', 'package.json'));
const BACKENDS = ['sqlite', ...(PG_URL ? ['pg'] : [])];
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { await Promise.allSettled(cleanups.map((c) => Promise.race([c(), new Promise((r) => setTimeout(r, 20_000))]))); }, 60_000);
let seq = 0;
async function store(backend: string, dir: string): Promise<{ BACKEND: string; DB: string }> {
  if (backend === 'sqlite') return { BACKEND: 'sqlite', DB: join(dir, 'j.db') };
  const name = `k3raw_${process.pid}_${Date.now().toString(36)}_${seq++}`;
  const { Client } = durableRequire('pg');
  const admin = new Client({ connectionString: PG_URL }); await admin.connect(); await admin.query(`CREATE DATABASE ${name}`); await admin.end();
  cleanups.push(async () => { const a = new Client({ connectionString: PG_URL }); await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end(); });
  const u = new URL(PG_URL!); u.pathname = '/' + name; return { BACKEND: 'pg', DB: u.toString() };
}
function crash(env: Record<string, string>): Promise<number | null> {
  const child = spawn(TSX, [join(__dirname, 'k3x', 'crash-proc.ts')], { env: { ...process.env, ...env }, cwd: join(__dirname, '..') });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  return new Promise((r) => child.on('close', (c) => { clearTimeout(timer); r(c); }));
}
const json = async (res: Response) => { const text = await res.text(); try { return { status: res.status, body: JSON.parse(text), text }; } catch { return { status: res.status, body: {} as any, text }; } };
const gnlIdsIn = (text: string) => [...new Set([...text.matchAll(/call_0\.gnl-[0-9a-z\-]+/g)].map((m) => m[0]))];
const runIdIn = (text: string) => /(run1_[0-9a-f]+):tool:/.exec(text)?.[1];

/** crash, wait past the takeover grace (SQLite ~2 s, Postgres ~6 s), then the first turn is asked again: the ladder's question. */
async function setup(backend: string, calls: number) {
  const dir = mkdtempSync(join(tmpdir(), 'k3raw-'));
  const st = await store(backend, dir); const effects = join(dir, 'eff');
  const code = await crash({ ...st, EFFECTS: effects, CALLS: String(calls), KILL_AFTER_MS: calls > 1 ? '800' : '0' });
  expect(code, 'killed in the tool body').not.toBe(0);
  expect(effectsOf(effects).length, 'precondition: the body was entered').toBeGreaterThanOrEqual(1);
  const before = effectsOf(effects).length;
  await new Promise((r) => setTimeout(r, backend === 'sqlite' ? 5000 : 12000));
  const storage = await openStorage(st.BACKEND, st.DB);
  const api = buildApi(storage, effects, 'serve', calls);
  const asked = await json(await api(runRequest('run', turnBody())));
  return { api, effects, before, asked, storage, close: async () => { try { await storage.close?.(); } catch { /* */ } } };
}

describe.each(BACKENDS)('k3 raw-id approval of a crash question [%s]', (backend) => {
  it('precondition + control: one call in doubt, answered by its GNL id → runs once', async () => {
    const s = await setup(backend, 1);
    console.log(`[raw ${backend} control] asked: ${s.asked.status} ${s.asked.text.slice(0, 220)}`);
    const ids = gnlIdsIn(s.asked.text);
    expect(s.asked.text, 'the crash question is there').toMatch(/MAY have already run|crashed mid-execution/);
    expect(ids.length).toBe(1);
    const done = await json(await s.api(runRequest('run', turnBody({ [ids[0]!]: true }))));
    console.log(`[raw ${backend} control] approved by GNL id: ${done.status} effects ${effectsOf(s.effects).length}`);
    expect(done.status).toBe(200);
    expect(effectsOf(s.effects).length).toBe(s.before + 1);
    await s.close();
  }, 120_000);

  it('/run: approvals { call_0: true } (the provider\'s id) → accepted, the work runs once', async () => {
    const s = await setup(backend, 1);
    expect(s.asked.text).toMatch(/MAY have already run|crashed mid-execution/);
    const done = await json(await s.api(runRequest('run', turnBody({ call_0: true }))));
    console.log(`[raw ${backend} /run] ${done.status} ${done.text.slice(0, 260)} | effects ${effectsOf(s.effects).length}`);
    expect(done.status, 'the raw key is an alias of the one call in doubt').toBe(200);
    expect(done.text).not.toMatch(/crashed mid-execution|MAY have already run/);
    expect(effectsOf(s.effects).length, 'once').toBe(s.before + 1);
    // …and a repeat of the same answer runs nothing more
    await s.api(runRequest('run', turnBody({ call_0: true })));
    expect(effectsOf(s.effects).length).toBe(s.before + 1);
    await s.close();
  }, 120_000);

  it('/resume: approvals { call_0: true } → accepted, the work runs once', async () => {
    const s = await setup(backend, 1);
    const runId = 'r-crash';
    const done = await json(await s.api(runRequest('resume', { runId, resourceId: 'ayse', approvals: { call_0: true } })));
    console.log(`[raw ${backend} /resume] ${done.status} ${done.text.slice(0, 260)} | effects ${effectsOf(s.effects).length}`);
    expect(done.status).toBe(200);
    expect(done.text).not.toMatch(/crashed mid-execution|MAY have already run/);
    expect(effectsOf(s.effects).length, 'once').toBe(s.before + 1);
    await s.close();
  }, 120_000);

  it('two calls in doubt share the id: /run and /resume answer typed `approval_key_ambiguous`, nothing runs', async () => {
    const s = await setup(backend, 1);
    const runId = 'r-crash';
    const journal = s.storage.runs ?? s.storage;
    const prefix = runKeys.tool(runId, '');
    const [firstKey] = await journal.listKeys(prefix);
    expect(firstKey, 'precondition: the call in doubt is in the journal').toBeTruthy();
    const second = runKeys.tool(runId, mintCallId('call_0', runId, 1, 0));
    await journal.put(second, await journal.get(firstKey!));
    console.log(`[raw ${backend} ambiguous] two calls in doubt sharing call_0: ${firstKey} | ${second}`);
    const a = await json(await s.api(runRequest('run', turnBody({ call_0: true }))));
    console.log(`[raw ${backend} ambiguous /run] ${a.status} ${a.text.slice(0, 260)}`);
    expect(a.status).toBe(409);
    expect(JSON.stringify(a.body)).toContain('approval_key_ambiguous');
    const b = await json(await s.api(runRequest('resume', { runId, resourceId: 'ayse', approvals: { call_0: true } })));
    console.log(`[raw ${backend} ambiguous /resume] ${b.status} ${b.text.slice(0, 260)}`);
    expect(b.status).toBe(409);
    expect(JSON.stringify(b.body)).toContain('approval_key_ambiguous');
    expect(effectsOf(s.effects).length, 'nothing was run').toBe(s.before);
    await s.close();
  }, 120_000);
});
