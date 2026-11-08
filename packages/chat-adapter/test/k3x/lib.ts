// Shared by the crash process (k3x/crash-proc.ts) and the in-process test (k3x-raw-approval.test.ts): one agent
// server over one store. The provider names every call `call_0`.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { createRestApi } from '../../../server/dist/index.js';
import { chatSurface } from '../../dist/index.js';
import { AgentMemory } from '../../../memory/dist/index.js';

export const effectsOf = (file: string): string[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

export async function openStorage(backend: string, db: string): Promise<any> {
  if (backend === 'sqlite') { const { SqliteStorage } = await import('@gnldev/durable/sqlite') as any; return new SqliteStorage(db); }
  const { PostgresStorage } = await import('@gnldev/durable/postgres') as any; return new PostgresStorage({ connectionString: db });
}

export function buildApi(storage: any, effectsFile: string, role: string, _calls: number, killAfterMs = 0) {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  const model: any = {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => { throw new Error('stream only'); },
    doStream: async ({ prompt }: any) => {
      const lastUser = prompt.map((m: any) => m.role).lastIndexOf('user');
      const answered = prompt.slice(lastUser).some((m: any) => m.role === 'tool');
      const parts: any[] = answered
        ? [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'paid' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: 'stop', usage }]
        : [{ type: 'tool-call', toolCallId: 'call_0', toolName: 'pay', input: JSON.stringify({ amount: 5 }) }, { type: 'finish', finishReason: 'tool-calls', usage }];
      return { stream: new ReadableStream({ start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); for (const p of parts) c.enqueue(p); c.close(); } }) };
    },
  };
  const config: any = {
    storage, preset: 'assistant', memoryFactory: (st: any) => new AgentMemory({ storage: st }),
    agents: { pharm: { model, system: 'you are a pharmacy assistant', tools: { pay: {
      description: 'pay', inputSchema: z.object({ amount: z.number() }), sideEffect: true,
      execute: async (a: any) => {
        appendFileSync(effectsFile, `${role} ${process.pid} amount=${a.amount}\n`);
        if (role === 'crash') { await new Promise((r) => setTimeout(r, killAfterMs)); process.kill(process.pid, 'SIGKILL'); }
        return { ok: true, amount: a.amount };
      },
    } } } },
  };
  return createRestApi(config, { surfaces: [chatSurface()], protectionsBanner: false } as any);
}

export const runRequest = (path: 'run' | 'resume', body: Record<string, unknown>) =>
  new Request(`http://x/agents/pharm/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
export const turnBody = (approvals?: Record<string, boolean>) => ({ runId: 'r-crash', resourceId: 'ayse', threadId: 'TH', messages: [{ role: 'user', content: 'pay 5 (t1)' }], ...(approvals ? { approvals } : {}) });
