// Writes the k3 upgrade fixtures WITH THE CODE OF THIS CHECKOUT (generated on release/0.17.1, 98892c59 —
// the data format before any call-identity change). Run from packages/chat-adapter after `pnpm -r build`:
//
//   ../../node_modules/.bin/tsx test/k3/fixtures/generate.ts
//
//   dead-marker.db  — a process killed -9 inside `pay` (tool call `call_0`, thread TH, workKey wk-t1, the
//                     default 'assistant' preset): its half-done call and its duplicate marker, as 0.17.1
//                     leaves them. dead-marker.eff holds that one effect.
//   pending-confirm.db — a run (workKey wk-c1, thread th-1) whose model calls pay 5 then pay 7, both `call_0`,
//                     tool confirm: true; suspended on the first question (pay 5), as 0.17.1 leaves it.
//   pending-confirm-one.db — the same with a one-step script (only pay 5): the plain "an old question is
//                     answered after the upgrade" case.
// Each is checkpointed and VACUUMed into one self-contained file.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { createRestApi } from '../../../../server/dist/index.js';
import { chatSurface } from '../../../dist/index.js';
import { AgentMemory } from '../../../../memory/dist/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TSX = join(HERE, '..', '..', '..', '..', '..', 'node_modules', '.bin', 'tsx');

function compact(src: string, dst: string) {
  if (existsSync(dst)) rmSync(dst);
  const db = new DatabaseSync(src);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`);
  db.close();
}

// ---- dead-marker ----
{
  const dir = mkdtempSync(join(tmpdir(), 'k3-fx-'));
  const r = spawnSync(TSX, [join(HERE, '..', 'proc.ts')], { cwd: join(HERE, '..', '..', '..'), encoding: 'utf8', env: { ...process.env, ROLE: 'crash', BACKEND: 'sqlite', DB: join(dir, 'j.db'), EFFECTS: join(dir, 'eff'), IDS: 'same', DOOR: 'run' } });
  if (r.status === 0) throw new Error('the crash process was not killed: ' + r.stdout + r.stderr);
  compact(join(dir, 'j.db'), join(HERE, 'dead-marker.db'));
  copyFileSync(join(dir, 'eff'), join(HERE, 'dead-marker.eff'));
  console.log('dead-marker.db written');
}

// ---- pending-confirm ----
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
function twoStep(steps: number[]): any {
  const stream = (parts: any[]) => ({ stream: new ReadableStream({ start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); for (const p of parts) c.enqueue(p); c.close(); } }) });
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => { throw new Error('stream only'); },
    doStream: async ({ prompt }: any) => {
      const lastUser = prompt.map((m: any) => m.role).lastIndexOf('user');
      const n = prompt.slice(lastUser).filter((m: any) => m.role === 'tool').flatMap((m: any) => m.content).filter((p: any) => p.type === 'tool-result').length;
      if (n < steps.length) return stream([{ type: 'tool-call', toolCallId: 'call_0', toolName: 'pay', input: JSON.stringify({ amount: steps[n] }) }, { type: 'finish', finishReason: 'tool-calls', usage }]);
      return stream([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'done' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: 'stop', usage }]);
    },
  };
}
for (const [name, steps] of [['pending-confirm', [5, 7]], ['pending-confirm-one', [5]]] as const) {
  const dir = mkdtempSync(join(tmpdir(), 'k3-fx-'));
  const { SqliteStorage } = await import('@gnldev/durable/sqlite') as any;
  const storage = new SqliteStorage(join(dir, 'j.db'));
  const paid: number[] = [];
  const api = createRestApi({ storage, preset: 'assistant', memoryFactory: (st: any) => new AgentMemory({ storage: st }), agents: { a: { model: twoStep([...steps]), system: 'assistant', tools: {
    pay: { description: 'pay', inputSchema: z.object({ amount: z.number() }), sideEffect: true, confirm: true, execute: async (a: any) => { paid.push(a.amount); return { charged: a.amount }; } },
  } } } } as any, { surfaces: [chatSurface()], protectionsBanner: false } as any);
  const res = await api(new Request('http://x/agents/a/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workKey: 'wk-c1', resourceId: 'u1', threadId: 'th-1', messages: [{ role: 'user', content: 'pay' }] }) }));
  const body: any = await res.json();
  if (body.interrupts?.length !== 1 || paid.length) throw new Error('expected one question and nothing paid: ' + JSON.stringify(body));
  await storage.close?.();
  compact(join(dir, 'j.db'), join(HERE, `${name}.db`));
  console.log(`${name}.db written`, JSON.stringify(body.interrupts.map((i: any) => [i.toolCallId, i.args])));
}
process.exit(0);
