// `gnl dev` builds two registries over one config (Studio's and the REST host's). The executor — the
// thing that sweeps for runs whose process is gone and claims them — is per process PER STORE
// (executors.ts), so a second registry joins it instead of starting a second sweeper. Two sweepers
// would each try to take over the same dead run; the claim would still be single-winner, but every
// sweep read would double.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryStorage, createGnl } from '../src/index.js';
import { closeExecutorFor } from '../src/executors.js';
import { DetachedRuns } from '../src/detached.js';
import { createMockModel, finalTextResult } from './mock.js';

afterEach(() => vi.restoreAllMocks());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('two registries over one store', () => {
  it('run on ONE executor: one sweeper, one claim path', async () => {
    const storage = new InMemoryStorage();
    const config = { storage, detached: { sweepMs: 10 }, agents: { a: { model: createMockModel(async () => finalTextResult('ok')) } } } as any;
    const studio = createGnl(config);
    const rest = createGnl(config);
    const sweepers = new Set<unknown>();
    const original = DetachedRuns.prototype.sweep;
    vi.spyOn(DetachedRuns.prototype, 'sweep').mockImplementation(function (this: DetachedRuns, ...a: never[]) {
      sweepers.add(this);
      return original.apply(this, a);
    });
    await studio.run('a', { runId: 'r-studio', prompt: 'x' } as never);
    await rest.run('a', { runId: 'r-rest', prompt: 'x' } as never);
    await sleep(120);
    expect(sweepers.size, 'a second executor would show up as a second sweeping instance').toBe(1);
    await closeExecutorFor((storage as any).runs ?? storage);
  });
});
