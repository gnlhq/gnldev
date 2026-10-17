// A run whose id the engine composes from a parent run — `agent:<P>:<call>` (a sub-agent),
// `wf:<P>:<call>` (a workflow tool), `net:<P>:<step>` (a network step) — is begun by the engine only
// (run-id-grammar.ts RUN_ID_FAMILIES, `begin: 'engine'`). Before, a stranger who began such an id
// through the public API first took the owner's call: the owner's sub-agent and workflow tool were
// refused, the whole network run failed, and the owner's erasure — which re-derives these ids from its
// own records — deleted the stranger's run. Each test asserts the harmless outcome.
// Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, afterAll } from 'vitest';
import {
  InMemoryStorage, InMemoryJournal, createGnl, eraseSubject, purgeRun, runNetwork, runDurable, resumeRun, forkRun, type Storage,
} from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { user, runOwnerOf } from '../src/run-identity.js';
import { createMockModel, toolCallResult, finalTextResult } from './mock.js';

const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

const PG_URL = process.env.GNL_PG_URL;
const STORES: Array<[string, () => Promise<Storage>]> = [
  ['in-memory', async () => new InMemoryStorage()],
  ['sqlite', async () => new SqliteStorage(':memory:')],
];
if (PG_URL) {
  STORES.push(['postgres (real)', async () => {
    const s = new PostgresStorage({ connectionString: PG_URL });
    ends.push(() => s.close());
    return s;
  }]);
}
// One store may be shared (Postgres): every test names its own runs and its own people.
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const lastUserText = (prompt: any[]): string => {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i];
    if (m.role !== 'user') continue;
    return typeof m.content === 'string' ? m.content : m.content.map((p: any) => p.text ?? '').join('');
  }
  return '';
};
const toolOutputs = (prompt: any[]): string => JSON.stringify(prompt.filter((m: any) => m.role === 'tool'));

type Stranger = 'mallory' | 'anonymous';
const strangerOpts = (s: Stranger, u: string) => (s === 'mallory' ? { caller: user(`mallory-${u}`) } : {});

async function dump(storage: any, prefix: string): Promise<string> {
  const keys: string[] = await storage.runs.listKeys(prefix);
  const out: string[] = [];
  for (const k of keys) out.push(`${k}=${JSON.stringify(await storage.runs.get(k))}`);
  return out.join('\n');
}
const ownerLabel = async (storage: any, id: string) => {
  const o: any = await runOwnerOf(storage.runs, id);
  return o.state === 'owned' ? `${o.owner.kind}${o.owner.kind === 'user' ? `:${o.owner.id}` : ''}` : o.state;
};

describe.each(STORES)('a derived run is born by the engine, %s', (_n, make) => {
  for (const stranger of ['mallory', 'anonymous'] as Stranger[]) {
    it(`agent: — ${stranger} begins agent:P:tc1 first; alice's sub-agent call is unharmed`, async () => {
      const storage: any = await make();
      const u = unique(); const P = `P-${u}`; const alice = `alice-${u}`;
      let workerCalls = 0;
      let parentSaw = '';
      const worker = createMockModel(async ({ prompt }: any) => { workerCalls++; return finalTextResult(`echo ${lastUserText(prompt)}`); });
      const parent = createMockModel(async ({ prompt }: any) => {
        if (!prompt.some((m: any) => m.role === 'tool')) return toolCallResult('agent_w', 'tc1', { task: 'ALICE-TASK' });
        parentSaw = toolOutputs(prompt);
        return finalTextResult('parent done');
      });
      const gnl: any = createGnl({ storage, agents: { parent: { model: parent, agents: ['w'] }, w: { model: worker } } } as any);
      let strangerRefused = false;
      try { await gnl.run('w', { runId: `agent:${P}:tc1`, prompt: 'MALLORY-SECRET', ...strangerOpts(stranger, u) }); } catch { strangerRefused = true; }
      const before = workerCalls;
      let ownerError = '';
      try { await gnl.run('parent', { runId: P, prompt: 'go', caller: user(alice) }); } catch (e: any) { ownerError = String(e?.message ?? e).slice(0, 160); }
      const outcome = {
        strangerRefused,
        ownerError,
        childOwner: await ownerLabel(storage, `agent:${P}:tc1`),
        workerRanForAlice: workerCalls - before,
        aliceGotStrangersText: parentSaw.includes('MALLORY-SECRET'),
        aliceGotOwnAnswer: parentSaw.includes('echo ALICE-TASK'),
      };
      expect(outcome).toMatchObject({ strangerRefused: true, ownerError: '', childOwner: `user:${alice}`, workerRanForAlice: 1, aliceGotStrangersText: false, aliceGotOwnAnswer: true });
    });

    it(`wf: — ${stranger} begins wf:P:tc1 first; alice's workflow tool call is unharmed`, async () => {
      const storage: any = await make();
      const u = unique(); const P = `P-${u}`; const alice = `alice-${u}`;
      const ran: string[] = [];
      const wf = { build: () => [{ id: 's1' }], run: async (input: any) => { ran.push(JSON.stringify(input)); return { got: input }; } };
      let parentSaw = '';
      const parent = createMockModel(async ({ prompt }: any) => {
        if (!prompt.some((m: any) => m.role === 'tool')) return toolCallResult('workflow_w', 'tc1', { input: { who: 'ALICE-INPUT' } });
        parentSaw = toolOutputs(prompt);
        return finalTextResult('parent done');
      });
      const gnl: any = createGnl({ storage, workflows: { w: wf }, agents: { parent: { model: parent, workflows: ['w'] } } } as any);
      let strangerRefused = false;
      try { await gnl.runWorkflow('w', { who: 'MALLORY-SECRET' }, { runId: `wf:${P}:tc1`, ...(stranger === 'mallory' ? { resourceId: `mallory-${u}`, caller: user(`mallory-${u}`) } : {}) }); } catch { strangerRefused = true; }
      const before = ran.length;
      let ownerError = '';
      try { await gnl.run('parent', { runId: P, prompt: 'go', caller: user(alice) }); } catch (e: any) { ownerError = String(e?.message ?? e).slice(0, 160); }
      const outcome = {
        strangerRefused,
        ownerError,
        childOwner: await ownerLabel(storage, `wf:${P}:tc1`),
        workflowRanForAlice: ran.length - before,
        aliceGotStrangersOutput: parentSaw.includes('MALLORY-SECRET'),
        aliceGotOwnOutput: parentSaw.includes('ALICE-INPUT'),
      };
      expect(outcome).toMatchObject({ strangerRefused: true, ownerError: '', childOwner: `user:${alice}`, workflowRanForAlice: 1, aliceGotStrangersOutput: false, aliceGotOwnOutput: true });
    });

    it(`net: — ${stranger} begins net:P:0 first; alice's network step is unharmed`, async () => {
      const storage: any = await make();
      const u = unique(); const P = `P-${u}`; const alice = `alice-${u}`;
      let workerCalls = 0;
      let routerSaw = '';
      let routed = 0;
      const worker = createMockModel(async ({ prompt }: any) => { workerCalls++; return finalTextResult(`echo ${lastUserText(prompt)}`); });
      const router = createMockModel(async ({ prompt }: any) => {
        if (routed++ === 0) return finalTextResult(JSON.stringify({ action: 'route', agent: 'w', task: 'ALICE-TASK' }));
        routerSaw = JSON.stringify(prompt);
        return finalTextResult(JSON.stringify({ action: 'final', answer: 'done' }));
      });
      const gnl: any = createGnl({ storage, agents: { w: { model: worker } }, networks: { n: { router, agents: ['w'] } } } as any);
      let strangerRefused = false;
      try { await gnl.run('w', { runId: `net:${P}:0`, prompt: 'MALLORY-SECRET', ...strangerOpts(stranger, u) }); } catch { strangerRefused = true; }
      const before = workerCalls;
      let ownerError = '';
      let r: any;
      try { r = await gnl.runNetwork('n', { runId: P, task: 'go', caller: user(alice) }); } catch (e: any) { ownerError = String(e?.message ?? e).slice(0, 160); }
      const outcome = {
        strangerRefused,
        ownerError,
        childOwner: await ownerLabel(storage, `net:${P}:0`),
        workerRanForAlice: workerCalls - before,
        aliceGotStrangersText: routerSaw.includes('MALLORY-SECRET') || JSON.stringify(r?.steps ?? []).includes('MALLORY-SECRET'),
        aliceGotOwnAnswer: routerSaw.includes('echo ALICE-TASK'),
      };
      expect(outcome).toMatchObject({ strangerRefused: true, ownerError: '', childOwner: `user:${alice}`, workerRanForAlice: 1, aliceGotStrangersText: false, aliceGotOwnAnswer: true });
    });
  }
});

// The erasure half: the parent's erasure and purge re-derive `agent:P:<call>` / `wf:P:<call>` from the
// parent's records. A stranger's run under such an id was deleted with alice's; now the stranger cannot
// begin it at all, so what alice's erasure reaches there is alice's own child and nothing else.
describe.each(STORES)('a derived run is born by the engine, erasure, %s', (_n, make) => {
  for (const how of ['eraseSubject(alice)', 'purgeRun(P)'] as const) {
    it(`agent: — mallory cannot begin agent:P:tc1, so ${how} reaches alice's child only`, async () => {
      const storage: any = await make();
      const u = unique(); const P = `P-${u}`; const alice = `alice-${u}`; const child = `agent:${P}:tc1`;
      const worker = createMockModel(async () => finalTextResult('w'));
      const parent = createMockModel(async ({ prompt }: any) => prompt.some((m: any) => m.role === 'tool') ? finalTextResult('done') : toolCallResult('agent_w', 'tc1', { task: 'x' }));
      const gnl: any = createGnl({ storage, agents: { parent: { model: parent, agents: ['w'] }, w: { model: worker } } } as any);
      await expect(gnl.run('w', { runId: child, prompt: 'MALLORY-SECRET', caller: user(`mallory-${u}`) })).rejects.toThrow(/composed by/);
      expect(await storage.runs.listKeys(child)).toEqual([]);
      await gnl.run('parent', { runId: P, prompt: 'go', caller: user(alice) });
      expect(await ownerLabel(storage, child)).toBe(`user:${alice}`);
      expect(await dump(storage, `${child}:`)).not.toContain('MALLORY-SECRET');
      if (how === 'purgeRun(P)') await purgeRun(storage.runs, P); else await eraseSubject(storage, alice);
      expect(await storage.runs.listKeys(`${child}:`)).toEqual([]);
    });

    it(`wf: — mallory cannot begin wf:P:tc1, so ${how} reaches alice's child only`, async () => {
      const storage: any = await make();
      const u = unique(); const P = `P-${u}`; const alice = `alice-${u}`; const child = `wf:${P}:tc1`;
      const wf = { build: () => [{ id: 's1' }], run: async (input: any) => ({ got: input }) };
      const parent = createMockModel(async ({ prompt }: any) => prompt.some((m: any) => m.role === 'tool') ? finalTextResult('done') : toolCallResult('workflow_w', 'tc1', { input: {} }));
      const gnl: any = createGnl({ storage, workflows: { w: wf }, agents: { parent: { model: parent, workflows: ['w'] } } } as any);
      await expect(gnl.runWorkflow('w', { who: 'MALLORY-SECRET' }, { runId: child, resourceId: `mallory-${u}`, caller: user(`mallory-${u}`) })).rejects.toThrow(/composed by/);
      expect(await storage.runs.listKeys(child)).toEqual([]);
      await gnl.run('parent', { runId: P, prompt: 'go', caller: user(alice) });
      expect(await ownerLabel(storage, child)).toBe(`user:${alice}`);
      if (how === 'purgeRun(P)') await purgeRun(storage.runs, P); else await eraseSubject(storage, alice);
      expect(await storage.runs.listKeys(`${child}:`)).toEqual([]);
    });
  }
});

// net: every step, not only step 0 — the step number is the easiest part of the id to guess.
describe.each(STORES)('a derived run is born by the engine, net steps 0..N, %s', (_n, make) => {
  it('a stranger refused at net:P:0..3 writes nothing; alice\'s three steps all run for her; her erasure takes them', async () => {
    const storage: any = await make();
    const u = unique(); const P = `P-${u}`; const alice = `alice-${u}`;
    const workerTasks: string[] = [];
    const worker = createMockModel(async ({ prompt }: any) => { workerTasks.push(lastUserText(prompt)); return finalTextResult(`echo ${lastUserText(prompt)}`); });
    let routed = 0;
    const router = createMockModel(async () => {
      const i = routed++;
      return finalTextResult(JSON.stringify(i < 3 ? { action: 'route', agent: 'w', task: `ALICE-${i}` } : { action: 'final', answer: 'done' }));
    });
    const gnl: any = createGnl({ storage, agents: { w: { model: worker } }, networks: { n: { router, agents: ['w'] } } } as any);
    for (const i of [0, 1, 2, 3]) {
      await expect(gnl.run('w', { runId: `net:${P}:${i}`, prompt: 'MALLORY-SECRET', caller: user(`mallory-${u}`) })).rejects.toThrow(/composed by/);
      await expect(gnl.run('w', { runId: `net:${P}:${i}`, prompt: 'MALLORY-SECRET' })).rejects.toThrow(/composed by/);
    }
    expect(await storage.runs.listKeys(`net:${P}:`)).toEqual([]);
    expect(workerTasks).toEqual([]);
    const r = await gnl.runNetwork('n', { runId: P, task: 'go', caller: user(alice) });
    expect(r.steps.map((s: any) => s.text)).toEqual(['echo ALICE-0', 'echo ALICE-1', 'echo ALICE-2']);
    for (const i of [0, 1, 2]) expect(await ownerLabel(storage, `net:${P}:${i}`)).toBe(`user:${alice}`);
    expect(await ownerLabel(storage, `net:${P}:3`)).toBe('missing');
    // A continuation of a step that exists is not a beginning: alice reads her own step back.
    const again = await gnl.run('w', { runId: `net:${P}:1`, prompt: 'ALICE-1', caller: user(alice) });
    expect(again.text).toBe('echo ALICE-1');
    expect(workerTasks).toHaveLength(3);
    await eraseSubject(storage, alice);
    expect(await storage.runs.listKeys(`net:${P}:`)).toEqual([]);
  });
});

// The ways through, for the ones that begin such a run legitimately.
describe('a derived run is born by the engine: the ways through', () => {
  const routeOnce = () => {
    let i = 0;
    return createMockModel(async () => finalTextResult(JSON.stringify(i++ === 0 ? { action: 'route', agent: 'a', task: 'T' } : { action: 'final', answer: 'done' })));
  };

  it('a host network target begins the step run with the third parameter; one that spells the id alone is refused; a plain function needs neither', async () => {
    const journal: any = new InMemoryJournal();
    const echo = createMockModel(async ({ prompt }: any) => finalTextResult(`echo ${lastUserText(prompt)}`));
    const withChild = await runNetwork({
      runId: 'N1', journal, routerModel: routeOnce(), task: 'go',
      agents: { a: { run: async (task, _id, child) => runDurable({ ...child, journal, model: echo, prompt: task }) } },
    });
    expect(withChild.steps[0]!.text).toBe('echo T');
    await expect(runNetwork({
      runId: 'N2', journal, routerModel: routeOnce(), task: 'go',
      agents: { a: { run: async (task, nestedRunId) => runDurable({ runId: nestedRunId, journal, model: echo, prompt: task }) } },
    })).rejects.toThrow(/composed by/);
    const plain = await runNetwork({
      runId: 'N3', journal, routerModel: routeOnce(), task: 'go',
      agents: { a: { run: async (task: string) => ({ text: `plain ${task}` }) } },
    });
    expect(plain.steps[0]!.text).toBe('plain T');
  });

  it('a fork of a sub-agent run keeps its family when the engine names it, and is resumable; a caller-chosen family id is refused', async () => {
    const storage: any = new InMemoryStorage();
    const worker = createMockModel(async () => finalTextResult('w'));
    const parent = createMockModel(async ({ prompt }: any) => prompt.some((m: any) => m.role === 'tool') ? finalTextResult('done') : toolCallResult('agent_w', 'tc1', { task: 'x' }));
    const gnl: any = createGnl({ storage, agents: { parent: { model: parent, agents: ['w'] }, w: { model: worker } } } as any);
    await gnl.run('parent', { runId: 'P', prompt: 'go', caller: user('alice') });
    const fork = await forkRun(storage.runs, 'agent:P:tc1', 0);
    expect(fork.newRunId.startsWith('agent:P:tc1:fork:')).toBe(true);
    expect(await ownerLabel(storage, fork.newRunId)).toBe('user:alice');
    const resumed = await resumeRun(fork.newRunId, { journal: storage.runs, model: worker, caller: user('alice') } as any);
    expect(resumed.text).toBe('w');
    await expect(forkRun(storage.runs, 'agent:P:tc1', 0, 'agent:Q:tc9')).rejects.toThrow(/composed by/);
    expect(await storage.runs.listKeys('agent:Q:')).toEqual([]);
  });
});
