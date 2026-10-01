// Invariant (ADR-0001): in the root scope, every organization's rows are hidden — RUNS included.
//
// Studio's root reader was the raw journal: `GET /runs` with no organization listed `org:acme:r-acme`,
// and the run views (`/runs/:id`, `/runs/:id/state`, `/runs/:id/trace`, the regression diff) read
// acme's journal by its physical id. The organization's scope (`x-gnl-org`) is the way through, and
// root-level management that is defined over every organization (retention sweep, run purge) keeps
// reaching every organization's rows.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, stampFormat } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

const SECRET = 'ACME-SECRET-RUN';

async function seed() {
  const journal = new InMemoryJournal();
  await journal.put('org:acme:r-acme:input', stampFormat({ prompt: SECRET }));
  await journal.put('org:acme:r-acme:model:0', { content: [{ type: 'text', text: SECRET }], finishReason: 'stop' });
  await journal.put('r-root:input', stampFormat({ prompt: 'root' }));
  await journal.put('r-root:model:0', { content: [{ type: 'text', text: 'root' }], finishReason: 'stop' });
  return journal;
}
const ids = async (r: Response) => {
  const body = await r.json();
  return (Array.isArray(body) ? body : body.items).map((x: { runId: string }) => x.runId).sort();
};
const ACME_ID = encodeURIComponent('org:acme:r-acme');

describe('studio: root-scope run reads hide every organization\'s runs', () => {
  it('GET /runs (array and paged) lists the root\'s runs only', async () => {
    const app = createStudioApi({ reader: await seed(), org: {} });
    expect(await ids(await call(app, '/runs'))).toEqual(['r-root']);
    expect(await ids(await call(app, '/runs?limit=10'))).toEqual(['r-root']);
  });

  it.each([`/runs/${ACME_ID}`, `/runs/${ACME_ID}/state`, `/runs/${ACME_ID}/trace`, `/runs/${ACME_ID}/regression/r-root`])(
    '%s carries nothing of acme\'s run',
    async (path) => {
      const app = createStudioApi({ reader: await seed(), org: {} });
      const r = await call(app, path);
      expect(await r.text()).not.toContain(SECRET);
    },
  );

  it('WAY THROUGH: acme\'s scope (x-gnl-org) reads acme\'s run', async () => {
    const app = createStudioApi({ reader: await seed(), org: {} });
    expect(await ids(await call(app, '/runs', { headers: { 'x-gnl-org': 'acme' } }))).toEqual(['r-acme']);
    expect(await (await call(app, '/runs/r-acme', { headers: { 'x-gnl-org': 'acme' } })).text()).toContain(SECRET);
  });

  it('root management defined over every organization still reaches them: DELETE /runs/:id purges acme\'s run by its physical id', async () => {
    const journal = await seed();
    const app = createStudioApi({ reader: journal, org: {} });
    const r = await call(app, `/runs/${ACME_ID}`, { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(await journal.get('org:acme:r-acme:input')).toBeUndefined();
  });
});
