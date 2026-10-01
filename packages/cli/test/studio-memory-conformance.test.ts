// Studio's thread routes against every memory this repository ships, handed over AS IT IS.
//
// Studio's memory type is picked from @gnldev/durable's `Memory`. Before that it kept its own copy,
// which said `truncateMessages` where AgentMemory says `truncateMessagesAfter`: the "delete messages
// after" route answered 501 for every AgentMemory and no test noticed, because Studio's tests fed it
// fakes written against Studio's copy. This suite feeds it the real objects. It lives in @gnldev/cli
// because that package depends on both sides.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, InMemoryJournal, BasicMemory, withOrgStorage, type Memory } from '@gnldev/durable';
import { memoryPreset } from '@gnldev/memory';
import { createStudioApi, type StudioMemory, type StudioMemoryOption } from '@gnldev/studio';
import * as memoryModule from '@gnldev/memory';
import { devStudioMemory } from '../src/memory.js';

const msgs = (n: number, p = 'm') => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${p}${i}` }));
type Api = (r: Request) => Promise<Response>;
const del = (api: Api, id: string, afterIndex: number, headers: Record<string, string> = {}) =>
  api(new Request(`http://x/threads/${encodeURIComponent(id)}/messages`, {
    method: 'DELETE', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ afterIndex }),
  }));
const read = async (api: Api, id: string, headers: Record<string, string> = {}) =>
  (await (await api(new Request(`http://x/threads/${encodeURIComponent(id)}/messages`, { headers }))).json()) as { content: string }[];

/** Each shipped memory, seeded with one 4-message thread `t1`, and whether it can truncate. */
const MEMORIES: [string, () => Promise<StudioMemory>, boolean][] = [
  ['AgentMemory (memoryPreset)', async () => { const m = memoryPreset(new InMemoryStorage(), 'chat'); await m.createThread({ id: 't1', resourceId: 'u1' }); await m.append('t1', msgs(4)); return m; }, true],
  ['devStudioMemory (gnl dev / gnl studio)', async () => { const st = new InMemoryStorage(); const m = devStudioMemory(memoryModule, st); await m.append('t1', msgs(4)); return m; }, true],
  ['BasicMemory (@gnldev/durable)', async () => { const m = new BasicMemory(new InMemoryJournal()); await m.append('t1', msgs(4)); return m; }, false],
];

describe.each(MEMORIES)('Studio thread routes with %s', (_name, make, truncates) => {
  it('reads the thread', async () => {
    const api = createStudioApi({ reader: new InMemoryJournal(), memory: await make() }) as Api;
    expect((await read(api, 't1')).map((m) => m.content)).toEqual(['m0', 'm1', 'm2', 'm3']);
  });

  it(truncates ? 'truncates after the index: the message at it is kept' : 'answers 501 to a truncation, and deletes nothing', async () => {
    const api = createStudioApi({ reader: new InMemoryJournal(), memory: await make() }) as Api;
    const res = await del(api, 't1', 1);
    if (truncates) {
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, removed: 2 });
      expect((await read(api, 't1')).map((m) => m.content)).toEqual(['m0', 'm1']);
    } else {
      expect(res.status).toBe(501);
      expect(await read(api, 't1')).toHaveLength(4);
    }
  });
});

describe('truncation edges, AgentMemory', () => {
  const setup = async () => {
    const m = memoryPreset(new InMemoryStorage(), 'chat');
    await m.append('t1', msgs(4));
    return createStudioApi({ reader: new InMemoryJournal(), memory: m }) as Api;
  };
  it('past the end removes nothing', async () => {
    expect(await (await del(await setup(), 't1', 99)).json()).toEqual({ ok: true, removed: 0 });
  });
  it('-1 clears the thread', async () => {
    const api = await setup();
    expect(await (await del(api, 't1', -1)).json()).toEqual({ ok: true, removed: 4 });
    expect(await read(api, 't1')).toEqual([]);
  });
  it('an organization thread id at the root is refused as reserved', async () => {
    const res = await del(await setup(), 'org:acme:t1', 0);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('thread_id_reserved');
  });
});

describe('organizations: memory as a function of the calling organization', () => {
  const auth = {
    authenticate: (q: Request) => {
      const t = q.headers.get('authorization')?.replace('Bearer ', '');
      if (t === 'acme' || t === 'globex') return { kind: 'operator', roles: ['admin'], id: `u-${t}`, orgId: t };
      return null;
    },
    authorize: () => ({ allow: true }),
    capabilities: () => ({ sso: false, rbac: false, audit: false, multiOrganization: false, users: false }),
  };
  const AS = { acme: { authorization: 'Bearer acme' }, globex: { authorization: 'Bearer globex' } };

  async function setup() {
    const root = new InMemoryStorage();
    const acme = memoryPreset(withOrgStorage(root, 'acme'), 'chat');
    await acme.append('t1', msgs(4));
    const memory: StudioMemoryOption = ({ orgId }) => memoryPreset(orgId ? withOrgStorage(root, orgId) : root, 'chat');
    const api = createStudioApi({ reader: new InMemoryJournal(), memory, auth, org: {} } as never) as Api;
    return { api, acme };
  }

  it('an organization truncates its own thread', async () => {
    const { api, acme } = await setup();
    const res = await del(api, 't1', 1, AS.acme);
    expect(res.status).toBe(200);
    expect((await acme.getMessages('t1')).map((m: { content: string }) => m.content)).toEqual(['m0', 'm1']);
  });

  it("another organization naming the same thread id reaches its own (empty) thread, never acme's", async () => {
    const { api, acme } = await setup();
    expect(await (await del(api, 't1', 0, AS.globex)).json()).toEqual({ ok: true, removed: 0 });
    expect(await read(api, 't1', AS.globex)).toEqual([]);
    expect(await acme.getMessages('t1')).toHaveLength(4);
  });

  it("another organization naming acme's stored key cannot reach it either", async () => {
    const { api, acme } = await setup();
    // Inside globex's view the id is just one of globex's own thread names: the view prefixes it.
    expect(await (await del(api, 'org:acme:t1', 0, AS.globex)).json()).toEqual({ ok: true, removed: 0 });
    expect(await acme.getMessages('t1')).toHaveLength(4);
  });

  it('a memory OBJECT without a claim is still refused to an organization', async () => {
    const api = createStudioApi({ reader: new InMemoryJournal(), memory: memoryPreset(new InMemoryStorage(), 'chat'), auth, org: {} } as never) as Api;
    expect((await del(api, 't1', 0, AS.acme)).status).toBe(403);
  });
});

// Compile-time half of the contract: these lines fail `tsc` if either side renames a method.
const _agent: StudioMemory = memoryPreset(new InMemoryStorage(), 'chat');
const _basic: StudioMemory = new BasicMemory(new InMemoryJournal());
const _owner: Required<Pick<Memory, 'truncateMessagesAfter'>> = memoryPreset(new InMemoryStorage(), 'chat');
void _agent; void _basic; void _owner;
