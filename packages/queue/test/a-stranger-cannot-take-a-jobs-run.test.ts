// A queued job's run (`job:<owned id>`) is composed by the queue for the job's owner and begun at its
// first lease. Before, a stranger who began that id first (`gnl.run` under `runId: 'job:~o~:alice:…'`,
// from any door) took it: alice's job failed every attempt ("belongs to a different subject") and
// never ran, and her erasure — which finds the run by her name — deleted the stranger's run.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, createGnl, eraseSubject, user, runOwnerOf, type Storage } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { enqueue, createWorker, listJobs, jobEraser } from '../src/index.js';

const model = () => ({
  specificationVersion: 'v4' as const, provider: 'm', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text' as const, text: 'w' }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [] }),
});
const ownerLabel = async (j: any, id: string) => { const o: any = await runOwnerOf(j, id); return o.state === 'owned' ? `${o.owner.kind}:${o.owner.id ?? ''}` : o.state; };

describe.each([
  ['in-memory', () => new InMemoryStorage() as unknown as Storage],
  ['sqlite', () => new SqliteStorage(':memory:') as unknown as Storage],
] as const)('a stranger cannot take a job\'s run, %s', (_n, make) => {
  it('a stranger beginning the job\'s run id is refused; the job runs once for its owner; her erasure takes only her run', async () => {
    const s: any = make();
    const gnl = createGnl({ storage: s, agents: { w: { model: model() } } } as never);
    const jobId = await enqueue(s.work!, 't', {}, { id: 'nightly-export', caller: user('alice') });
    const runId = `job:${jobId}`;
    await expect(gnl.run('w', { runId, prompt: 'x', caller: user('mallory') })).rejects.toThrow(/composed by/);
    expect(await s.runs.listKeys(`${runId}:`)).toEqual([]);

    let ran = 0;
    const worker = createWorker(s, { t: async () => { ran++; } }, { maxAttempts: 2, retryDelayMs: 0 } as never);
    await worker.drain();
    expect(ran).toBe(1);
    expect((await listJobs(s.work!)).find((j: any) => j.id === jobId)?.status).toBe('done');
    expect(await ownerLabel(s.runs, runId)).toBe('user:alice');

    await eraseSubject(s, 'alice', { erasers: [jobEraser(s)] } as never);
    expect(await s.runs.listKeys(`${runId}:input`)).toEqual([]);
  });
});
