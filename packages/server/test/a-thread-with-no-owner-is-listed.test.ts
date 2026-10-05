// A run with a threadId but no resourceId keeps its messages — and its thread is listed too. Before, the
// thread was indexed only when the run named a resource, so a host run with no caller, a staff run and
// an anonymous run on an open door stored their messages under a thread nobody could find: Studio's
// thread list showed none of them (measured, 3 of 3 paths: 2 messages, 0 threads listed).
//
// The entry carries resourceId '' (the column is NOT NULL), and '' names nobody: ownership, the per-user
// list and a clone read it exactly as they read "no entry".
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, createGnl, STAFF, type Storage } from '@gnldev/durable';
import { SqliteStorage } from '../../durable/src/sqlite-storage.js';
import { AgentMemory } from '../../memory/src/index.js';
import { createRestApi } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const model: any = { specificationVersion: 'v2', provider: 'm', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] }) };
const users: Record<string, any> = { u1: { kind: 'subject', id: 'u1', roles: [] }, u2: { kind: 'subject', id: 'u2', roles: [] } };
const auth = { authenticate: (r: Request) => users[r.headers.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null, authorize: () => ({ allow: true }) };
const post = (h: any, body: unknown, who?: string) => h(new Request('http://x/agents/a/run', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${who}` } : {}) }, body: JSON.stringify(body) }));

const engines: [string, () => Storage][] = [
  ['InMemoryStorage', () => new InMemoryStorage()],
  ['SqliteStorage', () => new SqliteStorage(':memory:') as unknown as Storage],
];

describe.each(engines)('a thread with no owner is listed (%s)', (_n, make) => {
  const setup = () => {
    const storage = make();
    const memory = new AgentMemory({ storage } as any);
    const cfg: any = { storage, memory, agents: { a: { model } } };
    return { memory, cfg, gnl: createGnl(cfg) };
  };
  const listed = async (m: AgentMemory) => (await m.listAllThreads()).map((t) => `${t.id}:${t.resourceId}`);

  it.each([
    ['a host run with no caller', {}],
    ['a staff run', { caller: STAFF }],
  ])('%s: listed, owned by nobody, in no user\'s list', async (_d, extra) => {
    const { memory, gnl } = setup();
    await gnl.run('a', { runId: 'r1', threadId: 't1', prompt: 'hello', ...extra } as any);
    expect(await listed(memory)).toEqual(['t1:']);
    expect(await memory.getThreadResource('t1')).toBeUndefined();
    expect(await memory.listThreads({ resourceId: 'u1' })).toEqual([]);
    expect(await memory.listThreads({ resourceId: '' })).toEqual([]);
  });

  it('an anonymous run on an open door: listed', async () => {
    const { memory, cfg } = setup();
    const api: any = createRestApi(cfg, { allowOpenAccess: true, protectionsBanner: false } as any);
    expect((await post(api, { runId: 'r1', threadId: 't1', prompt: 'hello' })).status).toBe(200);
    expect(await listed(memory)).toEqual(['t1:']);
  });

  it('the first user who continues it takes it — the entry says so, and their list shows it', async () => {
    const { memory, gnl } = setup();
    await gnl.run('a', { runId: 'r1', threadId: 't1', prompt: 'hello' } as any);
    await gnl.run('a', { runId: 'r2', threadId: 't1', prompt: 'me', resourceId: 'u1' } as any);
    expect(await listed(memory)).toEqual(['t1:u1']);
    expect((await memory.listThreads({ resourceId: 'u1' })).map((t) => t.id)).toEqual(['t1']);
  });

  it('a staff thread stays closed to an end user', async () => {
    const { cfg, gnl } = setup();
    await gnl.run('a', { runId: 'r1', threadId: 't1', prompt: 'staff', caller: STAFF } as any);
    const api: any = createRestApi(cfg, { auth, protectionsBanner: false } as any);
    expect((await post(api, { runId: 'r2', threadId: 't1', prompt: 'in' }, 'u2')).status).toBe(403);
  });

  it('a user\'s thread is unchanged: theirs, in their list only', async () => {
    const { memory, cfg } = setup();
    const api: any = createRestApi(cfg, { auth, protectionsBanner: false } as any);
    expect((await post(api, { runId: 'r1', threadId: 't1', prompt: 'mine' }, 'u1')).status).toBe(200);
    expect(await listed(memory)).toEqual(['t1:u1']);
    expect(await memory.listThreads({ resourceId: 'u2' })).toEqual([]);
  });

  it('a clone of an ownerless thread gets the owner it got before the entry existed', async () => {
    const { memory, gnl } = setup();
    await gnl.run('a', { runId: 'r1', threadId: 't1', prompt: 'hello' } as any);
    expect((await memory.cloneThread('t1', { newThreadId: 't2' })).resourceId).toBe('default');
  });
});
