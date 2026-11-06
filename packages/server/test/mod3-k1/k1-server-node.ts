// mod3 k1: role B as a SERVER — createRestApi built over the store, never called. Logs execution records
// every 200 ms like k1-node.ts. argv[2]: { conn, dir, sweepMs? }.
import { appendFileSync, writeFileSync } from 'node:fs';
import { tool, jsonSchema } from 'ai';
import { openStore, type Conn } from '../../../durable/test/mod3-k1/stores.js';
import { distMods } from '../../../durable/test/mod3-k1/dist-mods.js';
import { createRestApi } from '../../src/index.js';
import { streamingModel } from '../../../durable/test/detached/models.js';

const cfg = JSON.parse(process.argv[2]!) as { conn: Conn; dir: string; sweepMs?: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const storage: any = openStore(distMods, cfg.conn);
storage.pool?.on?.('error', () => {});
const model = streamingModel({ words: Array.from({ length: 20 }, (_, i) => `w${i} `), gapMs: 50, tool: { name: 'slow', input: { n: 1 } } });
const slow = tool({ description: 'slow', inputSchema: jsonSchema({ type: 'object', properties: { n: { type: 'number' } } }), execute: async () => { appendFileSync(`${cfg.dir}/effects`, 'effect B\n'); return 'ok'; } }) as any;
const log = (s: string) => appendFileSync(`${cfg.dir}/B.log`, `${Date.now()} ${s}\n`);
writeFileSync(`${cfg.dir}/B.pid`, String(process.pid));
createRestApi({ storage, agents: { a: { model, tools: { slow } } }, detached: { sweepMs: cfg.sweepMs ?? 300, pollMs: 100 } } as any, { allowOpenAccess: true, protectionsBanner: false } as any);
log('B up (server, no request)');
for (;;) {
  const keys: string[] = await storage.runs.listKeys('__exec__');
  for (const k of keys) { const v: any = await storage.runs.get(k); log(`exec ${k} ${v?.status} ${v?.owner}`); }
  await sleep(200);
}
