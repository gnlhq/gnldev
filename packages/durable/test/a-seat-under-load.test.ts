// maxToolCalls seats under many parallel calls. A seat taken by a bounded compare-and-set retry refused
// all but 22 of 200 parallel calls with the limit a million away (measured on InMemory, Sqlite, Postgres
// and Redis). The seat is now one atomic step on the request's total, and a finished call gives its seat
// back in the step that counts it: every call the limit admits runs, and no more. A custom store whose
// incrBy does not return values keeps a compare-and-set seat: never past the limit, and every call runs
// when the limit is far away. Postgres and Redis run when GNL_PG_URL / GNL_REDIS_URL are set.
import { describe, it, expect, afterAll } from 'vitest';
import { z } from 'zod';
import { InMemoryStorage, createGnl, gnlTool, STAFF } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { RedisStorage } from '../src/redis-storage.js';
import { createMockModel, toolCallResult, finalTextResult } from './mock.js';

const usage = { inputTokens: 1, outputTokens: 1 };
const ends: (() => Promise<unknown>)[] = [];
afterAll(async () => { for (const e of ends) await e(); });

/** A custom adapter whose incrBy adds but does not say the new value: seats fall back to compare-and-set. */
function silentIncr(): InMemoryStorage {
  const s = new InMemoryStorage() as any;
  for (const host of [s, s.runs]) {
    if (typeof host?.incrBy !== 'function') continue;
    const add = host.incrBy.bind(host);
    host.incrBy = async (k: string, f: Record<string, number>) => { await add(k, f); };
  }
  return s;
}

const STORES: [string, () => Promise<any>][] = [
  ['memory', async () => new InMemoryStorage()],
  ['sqlite', async () => new SqliteStorage(':memory:')],
  ['custom incrBy without a value', async () => silentIncr()],
];
if (process.env.GNL_PG_URL) {
  STORES.push(['postgres (real)', async () => {
    const pg = (await import('pg')).default;
    const admin = new pg.Client({ connectionString: process.env.GNL_PG_URL }); await admin.connect();
    const db = `seat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    await admin.query(`CREATE DATABASE ${db}`);
    const url = new URL(process.env.GNL_PG_URL!); url.pathname = `/${db}`;
    const s = new PostgresStorage({ connectionString: url.toString() });
    ends.push(async () => { await s.close(); await admin.query(`DROP DATABASE IF EXISTS ${db}`); await admin.end(); });
    return s;
  }]);
}
if (process.env.GNL_REDIS_URL) {
  STORES.push(['redis (real)', async () => {
    const { default: Redis } = await import('ioredis');
    const c = new Redis(process.env.GNL_REDIS_URL!); ends.push(() => c.quit());
    return new RedisStorage({ client: c as never, keyPrefix: `seat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}:` });
  }]);
}

/** n sub-agents in one step, one tool call each. */
async function fanOut(storage: any, n: number, maxToolCalls: number) {
  let ran = 0;
  const t = gnlTool({ description: 't', inputSchema: z.object({}).passthrough(), execute: async () => { ran++; return { ok: true }; } }, { sideEffect: true, idempotencyWindow: 'run', idempotencyKey: (a: any) => String(a.k) } as any);
  const parent = createMockModel(async ({ prompt }: any) => prompt.some((m: any) => m.role === 'tool') ? finalTextResult('ok')
    : { content: Array.from({ length: n }, (_, i) => ({ type: 'tool-call', toolCallId: `p${i}`, toolName: 'agent_w', input: JSON.stringify({ task: `w${i}` }) })), finishReason: 'tool-calls', usage, warnings: [] });
  const w = createMockModel(async ({ prompt }: any) => prompt.some((m: any) => m.role === 'tool') ? finalTextResult('done') : toolCallResult('t', 'call_0', { k: JSON.stringify(prompt).match(/w\d+/)![0] }));
  await createGnl({ storage, agents: { parent: { model: parent, agents: ['w'] }, w: { model: w, tools: { t } } } } as any)
    .run('parent', { runId: `r${maxToolCalls}`, prompt: 'go', caller: STAFF, limits: { maxToolCalls } } as any).catch(() => {});
  return ran;
}

describe.each(STORES)('a seat under load — %s', (_name, make) => {
  it('200 parallel calls, the limit far away: all 200 run', async () => {
    expect(await fanOut(await make(), 200, 1_000_000)).toBe(200);
  });
  it('200 parallel calls, limit 50: exactly 50 run (a compare-and-set seat: at most 50)', async () => {
    const ran = await fanOut(await make(), 200, 50);
    if (_name.startsWith('custom')) expect(ran).toBeLessThanOrEqual(50);
    else expect(ran).toBe(50);
  });
}, 120_000);

// A finished call is counted and its seat given back in one step. Counted first and given back after,
// a call asking for a seat in between saw the finished call twice: limit 2, A finished, B refused —
// 1 ran (measured with the one step split in two, 3 of 3). The writes after A's count are slowed so B
// asks then.
it('a call that asks while another is being counted is not refused (limit 2: both run)', async () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const did: string[] = [];
  let aDone = false;
  const s = new InMemoryStorage() as any;
  const slowed = new Set<string>();
  for (const host of [s, s.runs]) for (const m of ['putIfMatch', 'putIfAbsent', 'incrBy', 'put']) {
    if (typeof host?.[m] !== 'function') continue;
    const orig = host[m].bind(host);
    host[m] = async (k: string, ...r: any[]) => {
      if (aDone && /p0/.test(k) && /limits_(counters|state)/.test(k) && !slowed.has(m + k)) { slowed.add(m + k); await sleep(150); }
      return orig(k, ...r);
    };
  }
  const t = gnlTool({ description: 't', inputSchema: z.object({}).passthrough(), execute: async (a: any) => { did.push(a.k); if (a.k === 'A') aDone = true; return { ok: true }; } }, { sideEffect: true, idempotencyWindow: 'run', idempotencyKey: (a: any) => String(a.k) } as any);
  const parent = createMockModel(async ({ prompt }: any) => prompt.some((m: any) => m.role === 'tool') ? finalTextResult('ok')
    : { content: ['A', 'B'].map((task, i) => ({ type: 'tool-call', toolCallId: `p${i}`, toolName: 'agent_w', input: JSON.stringify({ task }) })), finishReason: 'tool-calls', usage, warnings: [] });
  const w = createMockModel(async ({ prompt }: any) => {
    if (prompt.some((m: any) => m.role === 'tool')) return finalTextResult('done');
    const k = JSON.stringify(prompt).includes('"B"') ? 'B' : 'A';
    if (k === 'B') await sleep(60);
    return toolCallResult('t', 'call_0', { k });
  });
  await createGnl({ storage: s, agents: { parent: { model: parent, agents: ['w'] }, w: { model: w, tools: { t } } } } as any)
    .run('parent', { runId: 'r', prompt: 'go', caller: STAFF, limits: { maxToolCalls: 2 } } as any);
  expect(slowed.size).toBeGreaterThan(0); // the window was opened
  expect(did.sort()).toEqual(['A', 'B']);
}, 30_000);
