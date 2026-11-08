// d25 madde 26a + 26c (kullanici karari, 8 Kas 2026): Studio da REST ile AYNI tek kurala baglidir.
//
//  26a — `memory: new AgentMemory({ storage })` org'lu kimlikte Studio'da REST'teki gibi CALISIR:
//        her org kendi deposunu gorur/yazar, ayni threadId iki orgda iki ayri thread'tir.
//        Bolunemeyen nesne (elle yazilmis store, AgentMemory alt sinifi) AYNI tipli retle reddedilir:
//        `memory_not_splittable` (5xx) — 403 `org_scope_refused` DEGIL.
//  26c — istek anindaki retin HTTP govdesi memoryFactory/`({ orgId }) =>` duzeltme cumlesini ICERMEZ;
//        cumle sunucu loguna yazilir.
//
// @gnldev/cli'da yasar: @gnldev/studio + @gnldev/memory'ye birlikte bagli tek paket (bkz.
// studio-memory-conformance.test.ts). Studio'nun mevcut 403 testlerine (host-store-org-form,
// cross-org-conformance, org-host-refusal-independent) DOKUNULMADI; nesne-ret beklentileri 26a ile degisecek.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryStorage, InMemoryJournal, withOrgStorage, type Storage } from '@gnldev/durable';
import { AgentMemory } from '@gnldev/memory';
import { createStudioApi } from '@gnldev/studio';

type Api = (r: Request) => Promise<Response>;
const auth = {
  authenticate: (req: Request) => {
    const t = req.headers.get('authorization')?.replace('Bearer ', '');
    if (t === 'acme') return { kind: 'operator', roles: ['admin'], id: 'u-acme', orgId: 'acme' };
    if (t === 'globex') return { kind: 'operator', roles: ['admin'], id: 'u-globex', orgId: 'globex' };
    if (t === 'root') return { kind: 'operator', roles: ['admin', 'platform-admin'], id: 'u-root' };
    return null;
  },
  authorize: () => ({ allow: true }),
  capabilities: () => ({ sso: false, rbac: false, audit: false, multiOrganization: false, users: false }),
};
type Who = 'acme' | 'globex' | 'root';
const send = (api: Api, who: Who, method: string, path: string, body?: unknown) =>
  api(new Request(`http://x${path}`, {
    method,
    headers: { authorization: `Bearer ${who}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));

let logs: string[] = [];
let spies: ReturnType<typeof vi.spyOn>[] = [];
function captureLogs() {
  logs = [];
  const keep = (...a: unknown[]) => { logs.push(a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : typeof x === 'string' ? x : JSON.stringify(x) ?? String(x))).join(' ')); };
  spies = [vi.spyOn(console, 'error').mockImplementation(keep), vi.spyOn(console, 'warn').mockImplementation(keep), vi.spyOn(console, 'log').mockImplementation(keep), vi.spyOn(console, 'info').mockImplementation(keep)];
}
afterEach(() => { for (const s of spies) s.mockRestore(); spies = []; });

const studioOver = (memory: unknown, extra: Record<string, unknown> = {}) =>
  createStudioApi({ reader: new InMemoryJournal(), auth: auth as never, org: {}, memory, ...extra } as never) as unknown as Api;

/** An organization's own partition of the shared storage, seeded the way a REST turn would write it. */
async function seed(storage: Storage, org: string, threadId: string, text: string, resourceId = `${org}-user`) {
  const m = new AgentMemory({ storage: withOrgStorage(storage, org) });
  await m.createThread({ id: threadId, resourceId, title: `${org} thread` } as never);
  await m.append(threadId, [{ role: 'user', content: text }] as never);
}

describe('d25/26a — memory: new AgentMemory(...) under organizations works in Studio like in REST', () => {
  it('each organization lists and reads ITS OWN thread; the same threadId in two orgs is two threads', async () => {
    const storage = new InMemoryStorage();
    await seed(storage, 'acme', 'SAME', 'ACME-SECRET-1');
    await seed(storage, 'globex', 'SAME', 'GLOBEX-SECRET-1');
    await seed(storage, 'acme', 'acme-only', 'ACME-ONLY-2');
    const api = studioOver(new AgentMemory({ storage }));

    for (const [who, other] of [['acme', 'GLOBEX'], ['globex', 'ACME']] as const) {
      const msgs = await send(api, who, 'GET', '/threads/SAME/messages');
      expect(msgs.status, await msgs.clone().text()).toBe(200);
      const text = await msgs.text();
      expect(text).toContain(`${who.toUpperCase()}-SECRET-1`);
      expect(text, `${who} was shown ${other}'s thread`).not.toContain(`${other}-SECRET`);
    }
    const list = await send(api, 'globex', 'GET', '/threads');
    expect(list.status).toBe(200);
    const listText = await list.text();
    expect(listText).toContain('globex thread');
    expect(listText, 'globex lists acme\'s threads').not.toMatch(/acme thread|acme-only/);
    const own = await (await send(api, 'acme', 'GET', '/threads')).text();
    expect(own).toContain('acme-only');
  });

  it('a foreign-only thread id is empty/absent for the other organization', async () => {
    const storage = new InMemoryStorage();
    await seed(storage, 'acme', 'acme-only', 'ACME-ONLY-2');
    const api = studioOver(new AgentMemory({ storage }));
    const r = await send(api, 'globex', 'GET', '/threads/acme-only/messages');
    expect(await r.text()).not.toContain('ACME-ONLY-2');
  });

  it('writes land in the caller\'s partition only: globex deleting "SAME" leaves acme\'s thread intact', async () => {
    const storage = new InMemoryStorage();
    await seed(storage, 'acme', 'SAME', 'ACME-SECRET-1');
    await seed(storage, 'globex', 'SAME', 'GLOBEX-SECRET-1');
    const api = studioOver(new AgentMemory({ storage }));
    const del = await send(api, 'globex', 'DELETE', '/threads/SAME');
    expect(del.status, await del.clone().text()).toBeLessThan(300);
    expect(await (await send(api, 'acme', 'GET', '/threads/SAME/messages')).text(), 'acme lost its thread to globex\'s delete').toContain('ACME-SECRET-1');
    expect(await (await send(api, 'globex', 'GET', '/threads/SAME/messages')).text()).not.toContain('GLOBEX-SECRET-1');
    // And in the storage itself, below Studio.
    const a = await withOrgStorage(storage, 'acme').memory!.getMessages('SAME', { limit: 10 } as never);
    expect(JSON.stringify(a)).toContain('ACME-SECRET-1');
  });

  it('truncateMessagesAfter (a write route) also stays in the caller\'s partition', async () => {
    const storage = new InMemoryStorage();
    for (const org of ['acme', 'globex']) {
      const m = new AgentMemory({ storage: withOrgStorage(storage, org) });
      await m.createThread({ id: 'SAME', resourceId: `${org}-user` } as never);
      await m.append('SAME', [0, 1, 2, 3].map((i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${org}-m${i}` })) as never);
    }
    const api = studioOver(new AgentMemory({ storage }));
    const res = await send(api, 'globex', 'DELETE', '/threads/SAME/messages', { afterIndex: 1 });
    expect(res.status, await res.clone().text()).toBe(200);
    const acme = await (await send(api, 'acme', 'GET', '/threads/SAME/messages')).text();
    expect(acme, 'acme\'s thread was truncated by globex').toContain('acme-m3');
  });

  it('the root/operator identity (no org) still reads the shared object as before', async () => {
    const storage = new InMemoryStorage();
    const root = new AgentMemory({ storage });
    await root.createThread({ id: 'R1', resourceId: 'op' } as never);
    await root.append('R1', [{ role: 'user', content: 'ROOT-MSG' }] as never);
    const r = await send(studioOver(root), 'root', 'GET', '/threads/R1/messages');
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('ROOT-MSG');
  });

  it('regression: `memory` as a function of the organization keeps working', async () => {
    const storage = new InMemoryStorage();
    await seed(storage, 'acme', 'T', 'ACME-FN');
    const api = studioOver(({ orgId }: { orgId?: string }) => new AgentMemory({ storage: orgId ? withOrgStorage(storage, orgId) : storage }));
    const r = await send(api, 'acme', 'GET', '/threads/T/messages');
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('ACME-FN');
  });
});

/** The developer's own store: no notion of an organization. */
const ownStore = () => ({
  getMessages: async () => [{ role: 'user', content: 'OWN-STORE-MSG' }],
  getWorkingMemory: async () => undefined,
  listThreads: async () => [], listAllThreads: async () => [{ id: 't', title: 'OWN' }],
  updateThread: async () => ({ id: 't' }), deleteThread: async () => {}, truncateMessagesAfter: async () => 0,
});
const subclassed = () => { const storage = new InMemoryStorage(); class Mine extends AgentMemory {} return new Mine({ storage }); };
const SHAPES: [string, () => unknown][] = [['a hand-written Memory object', ownStore], ['an AgentMemory subclass', subclassed]];
const THREAD_ROUTES: [string, string][] = [['GET', '/threads'], ['GET', '/threads/t/messages'], ['GET', '/threads/t/working-memory'], ['DELETE', '/threads/t']];

describe('d25/26a — an unsplittable memory under an organization: same typed refusal as REST, not 403', () => {
  for (const [shape, make] of SHAPES) {
    for (const [method, path] of THREAD_ROUTES) {
      it(`${shape}: ${method} ${path} -> 5xx memory_not_splittable (not 403 org_scope_refused)`, async () => {
        captureLogs();
        const r = await send(studioOver(make()), 'acme', method, path);
        const text = await r.text();
        expect(r.status, `Studio still answers the old 403: ${text.slice(0, 200)}`).not.toBe(403);
        expect(r.status).toBeGreaterThanOrEqual(500);
        const code = (() => { try { return JSON.parse(text).code; } catch { return undefined; } })();
        expect(code, text.slice(0, 200)).toBe('memory_not_splittable');
        expect(text, 'the own store was read for an organization').not.toContain('OWN-STORE-MSG');
      });
    }
  }

  it('the root identity is unaffected: the object is served (single-tenant / operator form)', async () => {
    const r = await send(studioOver(ownStore()), 'root', 'GET', '/threads/t/messages');
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('OWN-STORE-MSG');
  });

  it('other host objects keep the 403 org_scope_refused (26a is memory only): `cache` object', async () => {
    const cache = { stats: async () => ({}), invalidate: async () => ({ removed: 0 }), list: async () => [] };
    const r = await send(studioOver(undefined, { cache }), 'acme', 'GET', '/cache');
    // Whatever the route answers, it must not become memory_not_splittable.
    expect(await r.text()).not.toContain('memory_not_splittable');
  });
});

describe('d25/26c — Studio\'s request-time refusal body is generic; the fix goes to the log', () => {
  for (const [shape, make] of SHAPES) {
    it(`${shape}: no memoryFactory / \`({ orgId }) =>\` hint in the body; the log names it`, async () => {
      captureLogs();
      const r = await send(studioOver(make()), 'acme', 'GET', '/threads/t/messages');
      const text = await r.text();
      expect(text, 'the end user is handed a configuration fix').not.toMatch(/memoryFactory/i);
      expect(text, 'the end user is handed the function-of-organization hint').not.toMatch(/\(\{ orgId \}\)/);
      expect(text.length).toBeGreaterThan(20);
      expect(logs.join('\n'), 'the operator is told nothing: the log has no memoryFactory').toMatch(/memoryFactory/);
    });
  }
});
