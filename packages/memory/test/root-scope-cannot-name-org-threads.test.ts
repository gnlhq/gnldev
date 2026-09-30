// Invariant (ADR-0001): in the root scope, every organization's rows are hidden — including when the
// root caller NAMES one.
//
// An organization's threads sit physically in the root store as `org:<id>:<threadId>`. A root-scope
// memory that accepted such an id read that thread directly (by id, no scan involved), and one that
// created it put a root user's thread INSIDE acme's partition. Measured before (review panel, F8
// sibling C): `root.createThread({ id: 'org:acme:x' })` was accepted, and — while the scan still took
// its partition from the id — a resource recall anchored there returned acme's secret.
//
// A root-scope AgentMemory now refuses every thread id under `org:`; an organization's memory, whose
// ids the view prefixes, is unaffected.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, withOrgStorage, ReservedThreadIdError, type Storage } from '@gnldev/durable';
import { SqliteStorage } from '../../durable/src/sqlite-storage.js';
import { AgentMemory } from '../src/index.js';

const SECRET = 'ACME-SECRET-42';
const DIMS = ['password', 'weather', 'car'];
const embed = async (text: string): Promise<number[]> => DIMS.map((k) => text.toLowerCase().split(k).length - 1 + 0.01);
const u = (content: string) => ({ role: 'user', content });

const engines: [string, () => Storage][] = [
  ['InMemoryStorage', () => new InMemoryStorage()],
  ['SqliteStorage', () => new SqliteStorage(':memory:') as unknown as Storage],
];

describe.each(engines)('a root-scope memory cannot name an organization\'s thread (%s)', (_n, make) => {
  async function seeded() {
    const storage = make();
    const acme = new AgentMemory({ storage: withOrgStorage(storage, 'acme'), embed, recentN: 1, workingMemory: { scope: 'thread' } });
    await acme.createThread({ id: 't-acme', resourceId: 'u-shared' });
    await acme.append('t-acme', [u(`my secret password is ${SECRET}`)]);
    await acme.setWorkingMemory('t-acme', SECRET);
    const root = new AgentMemory({ storage, embed, recentN: 1 });
    return { storage, acme, root };
  }

  it("createThread({ id: 'org:acme:x' }) is refused, with the way through named", async () => {
    const { root } = await seeded();
    const err = await root.createThread({ id: 'org:acme:x', resourceId: 'u-shared' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReservedThreadIdError);
    expect((err as Error).message).toMatch(/withOrgStorage\(storage, orgId\)/);
  });

  it.each([
    ['append', (m: AgentMemory, t: string) => m.append(t, [u('hello')])],
    ['getMessages (thread)', (m: AgentMemory, t: string) => m.getMessages(t)],
    ['getMessages (resource recall)', (m: AgentMemory, t: string) => m.getMessages(t, { query: 'password', resourceId: 'u-shared', scope: 'resource' })],
    ['loadContext', (m: AgentMemory, t: string) => m.loadContext(t, { query: 'password', resourceId: 'u-shared' })],
    ['getWorkingMemory', (m: AgentMemory, t: string) => m.getWorkingMemory(t)],
    ['setWorkingMemory', (m: AgentMemory, t: string) => m.setWorkingMemory(t, 'x')],
    ['getThreadById', (m: AgentMemory, t: string) => m.getThreadById(t)],
    ['getThreadResource', (m: AgentMemory, t: string) => m.getThreadResource(t)],
    ['updateThread', (m: AgentMemory, t: string) => m.updateThread(t, { title: 'x' })],
    ['deleteThread', (m: AgentMemory, t: string) => m.deleteThread(t)],
    ['cloneThread (source)', (m: AgentMemory, t: string) => m.cloneThread(t, { newThreadId: 'mine' })],
    ['cloneThread (destination)', (m: AgentMemory, _t: string) => m.cloneThread('mine', { newThreadId: 'org:acme:stolen' })],
    ['recallObservations', (m: AgentMemory, t: string) => m.recallObservations(t, 'password')],
  ])('%s on acme\'s physical thread id is refused, and acme\'s thread is untouched', async (_label, op) => {
    const { root, acme } = await seeded();
    await root.createThread({ id: 'mine', resourceId: 'u-shared' });
    await expect(op(root, 'org:acme:t-acme')).rejects.toBeInstanceOf(ReservedThreadIdError);
    expect(JSON.stringify(await acme.getMessages('t-acme'))).toContain(SECRET);
    expect(await acme.getWorkingMemory('t-acme')).toBe(SECRET);
    expect((await acme.listThreads({ resourceId: 'u-shared' })).map((t) => t.id)).toEqual(['t-acme']);
  });

  it('the root still lists only its own threads — acme\'s are not in its store listing', async () => {
    const { root } = await seeded();
    await root.createThread({ id: 't-root', resourceId: 'u-shared' });
    expect((await root.listThreads({ resourceId: 'u-shared' })).map((t) => t.id)).toEqual(['t-root']);
    expect((await root.listAllThreads()).map((t) => t.id)).toEqual(['t-root']);
  });

  it("CONTROL: an organization's memory may use an id that starts with 'org:' — its view prefixes it", async () => {
    const { acme, root } = await seeded();
    await acme.createThread({ id: 'org:notes', resourceId: 'u-shared' });
    await acme.append('org:notes', [u('fine')]);
    expect((await acme.getMessages('org:notes')).map((m: { content: string }) => m.content)).toEqual(['fine']);
    expect((await root.listAllThreads()).map((t) => t.id)).toEqual([]);
  });

  it('CONTROL: ids that merely contain "org" are the root\'s to use', async () => {
    const { root } = await seeded();
    for (const id of ['organization', 'my-org:1', 'orgs', 'Org:acme:x']) {
      await root.createThread({ id, resourceId: 'u' });
      await root.append(id, [u('ok')]);
    }
    expect((await root.listThreads({ resourceId: 'u' })).length).toBe(4);
  });
});
