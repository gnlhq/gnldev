// A per-organization registry must not inherit the shared config's conversation store.
//
// `orgInstance` builds each organization's registry from `{ ...config, journal: scoped }`. The spread
// carried `config.memory` through, and `createGnl` resolves memory as `config.memory ?? memoryFactory(…)`
// — so the object won, the factory was never called for an organization, and every organization shared
// one store whose threads are keyed by a caller-chosen `threadId` alone.
//
// HONEST NOTE ON THE SHAPE OF THIS TEST. The construction guard (`memory` + `org` throws) now makes
// that state unreachable through the front door, and the author's own test covers the throw. This file
// covers the SECOND half of the change — the explicit `const { memory: _shared, ...perOrg } = config`
// — which the guard otherwise masks entirely. `restApiApp` closes over the config OBJECT and reads it
// again on the first request for each organization, so setting the field after construction reaches
// the line under test and nothing else. It is deliberately artificial: it exists so that relaxing the
// construction guard (or adding a fifth way for `memory` to appear) cannot silently restore a shared
// store. The behavioural assertion is the one that matters — a tenant's messages land in that tenant's
// own store and the shared object is never written to at all.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

function mkModel(): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
  };
}

/** A store with no notion of an organization — the shape every host reaches for. */
function store() {
  const threads = new Map<string, unknown[]>();
  return {
    threads,
    appends: 0,
    getMessages: async function (this: any, id: string) { return threads.get(id) ?? []; },
    append: async function (this: any, id: string, msgs: unknown[]) {
      this.appends++;
      threads.set(id, [...(threads.get(id) ?? []), ...msgs]);
    },
  };
}

const run = (api: any, org: string, runId: string, prompt: string) =>
  call(api, '/agents/a/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gnl-org': org },
    body: JSON.stringify({ runId, threadId: 'shared-thread-name', prompt }),
  });

describe('two organizations naming the same thread', () => {
  // KARAR-1 (user decision, 8 Nov 2026) changed the expected outcome of this artificial path: a `memory`
  // object that reaches an organization's registry is no longer DROPPED in silence (that drop is what
  // hid the roleAuth `orgId` case), it is REFUSED loudly. What still must hold: nothing is ever written
  // into the shared object, and nothing runs for the organization as if memory were on.
  it('refuse a conversation store carried through the shared config, and never write into it', async () => {
    const perOrg: ReturnType<typeof store>[] = [];
    const shared = store();
    const config: Record<string, unknown> = {
      journal: new InMemoryJournal(),
      memoryFactory: () => { const s = store(); perOrg.push(s); return s; },
      agents: { a: { model: mkModel() } },
    };
    const api = createRestApi(config as never, { org: {} } as never);
    const madeAtBoot = perOrg.length; // the default (org-less) instance builds one at construction

    // The field the spread used to carry. Set after construction, which is the only way to reach the
    // drop now that construction refuses it outright — see the note at the top of this file.
    config.memory = shared;

    const acme = await run(api, 'acme', 'r-acme', 'ACME-SECRET-REVENUE');
    const globex = await run(api, 'globex', 'r-globex', 'globex asks a question');
    expect(acme.status, 'the shared object was dropped in silence and the run served').toBeGreaterThanOrEqual(500);
    expect(globex.status).toBeGreaterThanOrEqual(500);

    expect(shared.appends, 'both organizations wrote into one store handed over by the host').toBe(0);
    expect(JSON.stringify([...shared.threads.values()])).not.toContain('ACME-SECRET-REVENUE');
  });

  it('are given DIFFERENT journals to build their stores over', async () => {
    // The factory's argument is the only thing that makes two stores over one backend distinct. If
    // both organizations receive the same journal, per-organization stores are per-organization in
    // name only.
    const journals: unknown[] = [];
    const api = createRestApi(
      {
        journal: new InMemoryJournal(),
        memoryFactory: (j: unknown) => { journals.push(j); return store(); },
        agents: { a: { model: mkModel() } },
      } as never,
      { org: {} } as never,
    );

    await run(api, 'acme', 'r1', 'hi');
    await run(api, 'globex', 'r2', 'hi');

    const perOrgJournals = journals.slice(journals.length - 2);
    expect(perOrgJournals[0], 'both organizations build their store over the same journal')
      .not.toBe(perOrgJournals[1]);
  });
});
