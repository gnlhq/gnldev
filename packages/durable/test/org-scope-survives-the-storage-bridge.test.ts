// An organization's view of a STORAGE must still say which organization it is once a door turns it into
// a journal.
//
// Every door builds its org instance with `scopeConfigToOrg`. Given `{ storage }` it returns
// `toJournal(withOrgStorage(storage, org).runs)`. The scoped `runs` port carries the org markers
// (`ORG_SCOPE`, `ORG_PARENT`, copied by `withOrg`), but `toJournal` built a fresh object that kept
// neither. Everything that asks a journal for its organization then read the org view as the root:
//   · the provider-facing idempotency key lost its `org:<id>:` part (durable-tool), so two
//     organizations charging the same order id handed the provider the same key;
//   · the erasure fence of an organization purge (erasure-fence) was never consulted;
//   · global documents (`__pricing__`) were not found through `orgParentOf`.
// The `{ journal }` path kept the markers all along; only the storage path dropped them.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '../src/in-memory-storage.js';
import { scopeConfigToOrg, withOrgStorage } from '../src/org-storage.js';
import { orgScopeOf, orgParentOf } from '../src/organization.js';
import { toJournal } from '../src/storage.js';
import { runDurable } from '../src/run.js';
import { createMockModel, toolCallResult, finalTextResult } from './mock.js';

function keyCapturingTool() {
  const seen: string[] = [];
  const tools = {
    charge: {
      idempotency: 'args' as const,
      idempotencyWindow: 'cross-run' as const,
      execute: async (_args: unknown, options?: { idempotencyKey?: string }) => {
        seen.push(options?.idempotencyKey ?? '<none>');
        return { ok: true };
      },
    },
  };
  return { tools, seen };
}

const model = () => {
  let call = 0;
  return createMockModel(async () => {
    call++;
    if (call === 1) return toolCallResult('charge', 'c-1', { orderId: 'ORD-1' });
    return finalTextResult('done');
  });
};

describe('an organization view of a storage keeps its organization through toJournal', () => {
  it('the journal a door builds from { storage } names its organization and its root', () => {
    const storage = new InMemoryStorage();
    const { journal } = scopeConfigToOrg({ storage }, 'acme');
    expect(orgScopeOf(journal)).toBe('acme');
    expect(orgParentOf(journal), 'global documents and purge fences are read through the root').toBeDefined();
  });

  it('toJournal over a scoped runs port keeps the markers', () => {
    const scoped = withOrgStorage(new InMemoryStorage(), 'globex');
    expect(orgScopeOf(toJournal(scoped.runs))).toBe('globex');
    expect(orgScopeOf(toJournal(scoped))).toBe('globex');
  });

  it('the root storage stays unscoped', () => {
    const journal = toJournal(new InMemoryStorage());
    expect(orgScopeOf(journal)).toBeUndefined();
    expect(orgParentOf(journal)).toBeUndefined();
  });

  it('two organizations on one storage hand the provider DIFFERENT keys for the same order', async () => {
    const storage = new InMemoryStorage();
    const { tools, seen } = keyCapturingTool();
    for (const org of ['acme', 'globex']) {
      const { journal } = scopeConfigToOrg({ storage }, org);
      await runDurable({ runId: 'bill', journal, model: model(), tools, prompt: 'charge ORD-1' } as never);
    }
    expect(seen.length).toBe(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]).toContain('acme');
    expect(seen[1]).toContain('globex');
  });
});
