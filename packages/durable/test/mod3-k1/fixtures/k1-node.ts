// mod3 k1: one app process over a real database (`cfg.conn`: Sqlite, libSQL, Postgres, MySQL or MongoDB). Config in argv[2] (JSON).
//   role A: starts one agent run (a slow tool, then a streamed answer) in `org` (or the root), writes
//           <dir>/a.owner (the exec record's owner) once the tool runs; then waits to be SIGKILLed — or,
//           with `drain`, drains the process (drainProcess) when <dir>/drain appears and exits.
//           Every body of the tool appends `effect <role>` to <dir>/effects before it does anything else.
//   role B: builds the ROOT registry (as a server's default instance does) and, with `orgReq`, an
//           organization's registry; serves NO request unless <dir>/trigger appears (then one unrelated
//           follow in `orgReq`, or the root). With `start`, calls the registry's `start()` when it has one.
//           Logs every 200 ms: `<ms> exec <status> <owner>` for each execution record.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createGnl, drainProcess, scopeConfigToOrg } from '../../../src/index.js';
import { openStore, type Conn } from '../stores.js';
import { srcMods } from './src-mods.js';
import { streamingModel } from '../../detached/models.js';
import { tool } from 'ai';
import { z } from 'zod';

const cfg = JSON.parse(process.argv[2]!) as {
  role: 'A' | 'B'; conn: Conn; runId: string; dir: string; org?: string; orgReq?: string; drain?: boolean; start?: boolean; sweepMs?: number; dieInClaim?: boolean;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const storage: any = openStore(srcMods, cfg.conn);
storage.pool?.on?.('error', () => {});
// `dieInClaim` (MongoDB): the process is killed inside the transaction of its tool call's claim, the claim and
// the run's document written and nothing committed — what a SIGKILL at the wrong moment leaves on the server.
if (cfg.dieInClaim) {
  const runs = storage.runs;
  const claim = runs.putIfAbsent.bind(runs);
  let armed = false;
  runs.putIfAbsent = (key: string, value: unknown) => { if (key.includes(':tool:')) armed = true; return claim(key, value); };
  const start = storage.client.startSession.bind(storage.client);
  storage.client.startSession = (...a: unknown[]) => {
    const s = start(...a);
    const commit = s.commitTransaction.bind(s);
    s.commitTransaction = async () => { if (armed) { process.kill(process.pid, 'SIGKILL'); await sleep(60_000); } return commit(); };
    return s;
  };
}
const words = Array.from({ length: 20 }, (_, i) => `w${i} `);
const model = streamingModel({ words, gapMs: 50, tool: { name: 'slow', input: { n: 1 } } });
const slow = tool({ description: 'slow', inputSchema: z.object({ n: z.number() }), execute: async () => { appendFileSync(`${cfg.dir}/effects`, `effect ${cfg.role}\n`); await sleep(cfg.role === 'A' ? 1500 : 10); return 'ok'; } }) as any;
const base = { storage, agents: { a: { model, tools: { slow } } }, detached: { sweepMs: cfg.sweepMs ?? 300, pollMs: 100 } } as any;
const orgOf = (id?: string) => (id ? createGnl(scopeConfigToOrg(base, id).config) : createGnl(base));
const log = (s: string) => appendFileSync(`${cfg.dir}/${cfg.role}.log`, `${Date.now()} ${s}\n`);
writeFileSync(`${cfg.dir}/${cfg.role}.pid`, String(process.pid));
const execs = async () => {
  const keys: string[] = await storage.runs.listKeys('__exec__');
  return Promise.all(keys.map(async (k) => [k, await storage.runs.get(k)] as const));
};

if (cfg.role === 'A') {
  const gnl = orgOf(cfg.org);
  const r: any = await gnl.stream('a', { runId: cfg.runId, prompt: 'go', resourceId: 'alice' } as any);
  void (async () => { for await (const _p of r.fullStream) { /* drain the stream */ } log('A stream ended'); })().catch((e) => log(`A stream threw ${e?.message}`));
  for (let i = 0; i < 100; i++) {
    const own = (await execs()).find(([, v]: any) => v?.status === 'running');
    if (own) { writeFileSync(`${cfg.dir}/a.owner`, String((own[1] as any).owner)); break; }
    await sleep(50);
  }
  log('started');
  if (cfg.drain) {
    while (!existsSync(`${cfg.dir}/drain`)) await sleep(50);
    log('draining');
    await drainProcess({ deadlineMs: 10_000 } as any).catch((e) => log(`drain threw ${e?.message}`));
    log('drained');
    process.exit(0);
  }
  await sleep(120_000);
} else {
  const root = createGnl(base);
  const org = cfg.orgReq ? orgOf(cfg.orgReq) : undefined;
  if (cfg.start && typeof (root as any).start === 'function') { await (root as any).start(); log('started root'); }
  log('B up');
  let triggered = false;
  for (;;) {
    if (!triggered && existsSync(`${cfg.dir}/trigger`)) {
      triggered = true;
      log('TRIGGER');
      await (org ?? root).follow('unrelated-run-xyz').catch((e: any) => log(`follow threw ${e?.name}`));
    }
    for (const [k, v] of await execs()) log(`exec ${k} ${(v as any)?.status} ${(v as any)?.owner}`);
    await sleep(200);
  }
}
