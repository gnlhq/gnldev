// k3-b2 child process: a durable tool call in real Postgres fails between its claim and its body (the
// duplicate-marker read fails), and the write that gives its claim back fails once too. The process stays
// alive. Prints GAVE_UP when the call has thrown.
// argv: <pgUrl> <runId> <toolCallId>
import { newStorage } from './backends.mjs';
import { durableTool } from '../../dist/durable-tool.js';

const [pgUrl, runId, toolCallId] = process.argv.slice(2);
const storage = await newStorage(pgUrl);
await storage.runs.get('warm');
const toolKey = `${runId}:tool:${toolCallId}`;
let claimed = false;
let dupFailed = false;
let backFailed = false;
const journal = new Proxy(storage.runs, {
  get(target, prop) {
    const v = target[prop];
    if (typeof v !== 'function') return v;
    if (!['get', 'putIfAbsent', 'putIfMatch'].includes(prop)) return v.bind(target);
    return async (key, ...rest) => {
      const value = prop === 'putIfMatch' ? rest[1] : rest[0];
      if (claimed && !dupFailed && prop === 'get' && key.includes('dup-')) { dupFailed = true; throw new Error('injected: dup read fails'); }
      if (dupFailed && !backFailed && prop === 'putIfMatch' && key === toolKey && value?.status !== 'running') { backFailed = true; throw new Error('injected: the store refuses the give-back'); }
      const r = await v.call(target, key, ...rest);
      if ((prop === 'putIfAbsent' || prop === 'putIfMatch') && r === true && key === toolKey && value?.status === 'running') claimed = true;
      return r;
    };
  },
});
const tool = { sideEffect: true, execute: async () => { process.stdout.write('CHILD_RAN\n'); return { by: 'child' }; } };
try {
  await durableTool(tool, { journal, runId }, 'charge').execute({ amount: 1 }, { toolCallId });
  process.stdout.write('UNEXPECTED_OK\n');
} catch (e) {
  process.stdout.write(`GAVE_UP dup=${dupFailed} back=${backFailed} ${String(e?.message).slice(0, 80)}\n`);
}
setInterval(() => {}, 1 << 30);
