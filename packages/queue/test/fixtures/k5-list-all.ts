// k5 (Mod 3) test adapter: every job in the store, whatever organization — what `listJobs(work)` returned
// before it took `{ orgId, cursor, limit }` and returned a page. Candidate E keeps no directory of the
// organizations that enqueued (its worker takes from the ready set and needs none), so the adapter asks
// the organizations these tests use, plus the jobs with no organization. Whether the queue offers an
// operator-wide listing is an open API decision, not this adapter's.
import type { WorkStore } from '@gnldev/durable';
import { listJobs } from '../../src/index.js';

const TEST_ORGS = ['acme', 'globex', 'a', 'orgx', 'orgy', 'orgz', 'o1', 'o2', 'o3'];

export async function listAllJobs(work: WorkStore, orgs: string[] = TEST_ORGS): Promise<any[]> {
  const out: any[] = [];
  for (const orgId of [undefined, ...orgs]) {
    let cur: string | undefined;
    do {
      const p = await (listJobs as any)(work, { ...(orgId !== undefined ? { orgId } : {}), ...(cur ? { cursor: cur } : {}), limit: 1000 });
      out.push(...p.items);
      cur = p.nextCursor;
    } while (cur);
  }
  return out;
}
