// One scheduler process for the A4 audit. Config in argv[2] (JSON). Writes one line per event to `log`:
//   start <tag> <runId>   — the runner was called for this run (the workflow's plain code runs)
//   effect <tag> <runId>  — the body of a side-effecting durableTool ran (the real effect)
//   end <tag> <runId> <outcome>
import { appendFileSync } from 'node:fs';
import { storeLiveness, durableTool } from '@gnldev/durable';
import { PostgresStorage } from '@gnldev/durable/postgres';
import { createScheduler, scheduleWorkflow, type WorkflowRunner } from '../../../src/index.js';

const cfg = JSON.parse(process.argv[2]!) as {
  url: string; tag: string; offsetMs: number; bindLiveness: boolean; lockTtlMs: number;
  preludeMs: number; log: string; schedule?: { id: string; atInMs: number }; lifeMs: number;
};
const realNow = Date.now;
Date.now = () => realNow() + cfg.offsetMs; // this process's (possibly skewed) wall clock
const log = (s: string) => appendFileSync(cfg.log, `${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => process.exit(0), cfg.lifeMs).unref?.();

const storage = new PostgresStorage({ connectionString: cfg.url });
await storage.runs.get('warm');
if (cfg.bindLiveness) await storeLiveness(storage.runs, { own: () => storage.processLiveness() }); // what createGnl's executor does at start

const runner: WorkflowRunner = {
  async runWorkflow(_name, _input, o) {
    const runId = o!.runId!;
    log(`start ${cfg.tag} ${runId}`);
    await sleep(cfg.preludeMs); // the workflow's plain (non-journaled) work — frozen here in the freeze scenario
    let outcome = 'ok';
    try {
      await durableTool(
        { sideEffect: true, recover: async () => ({ done: false as const }), execute: async () => { log(`effect ${cfg.tag} ${runId}`); return { ok: cfg.tag }; } } as any,
        { journal: storage.runs, runId } as any, 'charge',
      ).execute!({ n: 1 }, { toolCallId: 'c1' } as any);
    } catch (e) { outcome = `threw:${(e as Error).name}`; }
    log(`end ${cfg.tag} ${runId} ${outcome}`);
    return { runId };
  },
};

if (cfg.schedule) await scheduleWorkflow(storage.runs, { id: cfg.schedule.id, name: 'wf', at: realNow() + cfg.schedule.atInMs }, realNow());
log(`ready ${cfg.tag}`);
createScheduler(storage.runs, runner, { pollMs: 100, lockTtlMs: cfg.lockTtlMs, owner: cfg.tag }).start();
