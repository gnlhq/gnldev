// K3 decision item 3 (b2), isolated and ORDER-DETERMINISTIC. The acceptance cell (k3-call-identity-crash (b), "when
// another run did the same work, the old run's question says so") is timing-dependent: SQLite takes a dead run
// over ~1-2 s after boot, Postgres ~6 s, and the cell asks the old run's question right after the new run's
// approval — so it passes on SQLite (the old run is already taken over and re-asked) and fails on Postgres (still
// the "crashed mid-execution, MAY have already run" refusal). Here the wait is explicit (SETTLE_MS past the
// Postgres grace), in both orders:
//   msg-first      : the new message reaches the restarted process first, a person approves it (2nd effect, by
//                    ANOTHER run), then the old run is asked.
//   takeover-first : the dead run is taken over and stopped first; then the new message, approved; then the old run.
// Expected (decision A): the old run's question says another run already did this work; a person who approves it
// anyway gets the work done (3rd effect = conscious human decision); without approval the effects stay at 2. Uses the acceptance harness' process driver unchanged (k3/proc.ts, same env switches).
import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROC = join(__dirname, 'k3', 'proc.ts');
const ROOT = join(__dirname, '..', '..', '..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const PG_URL = process.env.GNL_PG_URL;
const OUT_DIR = process.env.K3_OUT;
const durableRequire = createRequire(join(ROOT, 'packages', 'durable', 'package.json'));
type Res = { code: number | null; out: string; lines: Record<string, any> };

function runProc(env: Record<string, string>): Promise<Res> {
  const child = spawn(TSX, [PROC], { env: { ...process.env, ...env }, cwd: join(__dirname, '..') });
  let out = '';
  const onData = (b: Buffer) => { out += b.toString(); };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  const timer = setTimeout(() => child.kill('SIGKILL'), 150_000);
  return new Promise<Res>((resolve) => child.on('close', (code) => {
    clearTimeout(timer);
    const lines: Record<string, any> = {};
    for (const l of out.split('\n')) { const m = /^([A-Z_0-9]+) (\{.*\})$/.exec(l); if (m) { try { lines[m[1]] = JSON.parse(m[2]); } catch { /* partial */ } } }
    resolve({ code, out, lines });
  }));
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { await Promise.allSettled(cleanups.map((c) => Promise.race([c(), new Promise((r) => setTimeout(r, 20_000))]))); }, 60_000);
let seq = 0;
async function storeEnv(backend: string, dir: string): Promise<Record<string, string>> {
  const name = `k3b2_${process.pid}_${Date.now().toString(36)}_${seq++}`;
  if (backend === 'sqlite') return { BACKEND: 'sqlite', DB: join(dir, 'j.db') };
  const { Client } = durableRequire('pg');
  const admin = new Client({ connectionString: PG_URL }); await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`); await admin.end();
  cleanups.push(async () => { const a = new Client({ connectionString: PG_URL }); await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end(); });
  const u = new URL(PG_URL!); u.pathname = '/' + name;
  return { BACKEND: 'pg', DB: u.toString() };
}
const BACKENDS = ['sqlite', ...(PG_URL ? ['pg'] : [])];
const questionText = (r: any) => [...(r?.interrupts ?? []).map((i: any) => i.reason), r?.blocked ?? ''].join(' | ');

const cells = new Map<string, Promise<{ crash: Res; serve: Res }>>();
function cell(backend: string, order: string, approveOld = true) {
  const k = `${backend}-${order}-${approveOld}`;
  if (!cells.has(k)) cells.set(k, (async () => {
    const dir = OUT_DIR ? (() => { const d = join(OUT_DIR, `b2-${backend}-${order}-${approveOld ? 'approved' : 'unapproved'}-${Date.now()}`); mkdirSync(d, { recursive: true }); return d; })() : mkdtempSync(join(tmpdir(), 'k3b2-'));
    const base = { ...(await storeEnv(backend, dir)), EFFECTS: join(dir, 'eff'), DOOR: 'run', IDS: 'same', ORDER: order, APPROVE_T2: '1', OLD_Q: '1', ...(approveOld ? { OLD_APPROVE: '1' } : {}), SETTLE_MS: '14000' };
    const crash = await runProc({ ...base, ROLE: 'crash' });
    const serve = await runProc({ ...base, ROLE: 'serve' });
    if (OUT_DIR) { writeFileSync(join(dir, 'crash.out'), crash.out); writeFileSync(join(dir, 'serve.out'), serve.out); }
    return { crash, serve };
  })());
  return cells.get(k)!;
}

describe.each(BACKENDS)('k3 b2 [%s] — the dead run\'s question after another run did the same work', (backend) => {
  for (const order of ['msg-first', 'takeover-first']) {
    it.concurrent(`${order}: the old run's question says another run did the same work`, async () => {
      const { crash, serve } = await cell(backend, order);
      expect(crash.code).not.toBe(0);
      expect(serve.lines.BOOT?.effects, 'precondition: the crash process reached the tool body').toBe(1);
      const t2 = serve.lines.T2_APPROVED ?? serve.lines.T2;
      expect(serve.lines.AFTER_T2?.effects, 'precondition: another run did the work (a person approved the new message)').toBe(2);
      const old = questionText(serve.lines.OLD_Q);
      console.log(`[b2 ${backend} ${order}] other run ${t2?.runId} | old question: ${old.slice(0, 320)} | effects after approving the old: ${serve.lines.FINAL?.effects}`);
      const other = new RegExp(`${String(t2.runId).replace(/[^a-z0-9_]/gi, '.')}|\\b(another|other)\\s+run\\b|already completed the same work`, 'i');
      expect(old, 'the old run\'s question names the other run that did the same work').toMatch(other);
    }, 240_000);
    // Decision (A): the question SAYS another run did the work; a person who sees that and approves anyway gets the
    // work done (the 3rd effect is a conscious human decision, the framework does not block it); no approval, no effect.
    it.concurrent(`${order}: the question carries the "another run did it" information, and an informed approval runs the work (3rd effect)`, async () => {
      const { serve } = await cell(backend, order, true);
      expect(serve.lines.AFTER_T2?.effects, 'precondition: the other run paid (2)').toBe(2);
      const t2 = serve.lines.T2_APPROVED ?? serve.lines.T2;
      const old = questionText(serve.lines.OLD_Q);
      expect(old, 'before approving, the question names the other run').toMatch(new RegExp(`${String(t2.runId).replace(/[^a-z0-9_]/gi, '.')}|\\b(another|other)\\s+run\\b|already completed the same work`, 'i'));
      expect(serve.lines.FINAL?.effects, 'after the informed approval the work ran: 3 effects').toBe(3);
    }, 240_000);
    it.concurrent(`${order}: without an approval of the old question the effects stay at 2 (negative control)`, async () => {
      const { serve } = await cell(backend, order, false);
      expect(serve.lines.AFTER_T2?.effects, 'precondition: the other run paid (2)').toBe(2);
      expect(serve.lines.FINAL?.effects).toBe(2);
    }, 240_000);
  }
});
