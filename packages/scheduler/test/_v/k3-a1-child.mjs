// Audit A1 child process: suspends a run on a past-due sleep, lets the waker take the wake ticket,
// and hangs inside the post-sleep step until the parent SIGKILLs it.
// argv: <pgUrl> <runId>
import { newStorage } from '../../../durable/test/_v/backends.mjs';
import { toJournal } from '@gnldev/durable';
import { workflow, step, sleep } from '@gnldev/workflow';
import { createWorkflowWaker } from '../../dist/index.js';

const [pgUrl, runId] = process.argv.slice(2);
const pgs = await newStorage(pgUrl);
await pgs.init();
const journal = toJournal(pgs);

// A cold store (collections created on first use) can take longer than 100 ms to answer the first call; the run
// must still be suspended when it returns, so the margin is settable (K3_WAKE_MARGIN_MS) for such stores.
const margin = Number(process.env.K3_WAKE_MARGIN_MS ?? 100);
const untilMs = Date.now() + margin;
const wf = workflow()
  .then(sleep('wake', untilMs))
  .then(step('after', async () => {
    process.stdout.write('IN_AFTER\n');
    await new Promise(() => {}); // hang forever: the parent kills us here
  }));

const first = await wf.runResumable({}, { runId, journal });
process.stdout.write(`SUSPENDED ${JSON.stringify(first)}\n`);
await new Promise((r) => setTimeout(r, margin + 100));
const waker = createWorkflowWaker({ journal, resume: (id) => wf.runResumable({}, { runId: id, journal }) });
process.stdout.write('TICKING\n');
await waker.tick();
