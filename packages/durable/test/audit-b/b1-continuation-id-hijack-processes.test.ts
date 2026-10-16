// B1 across real processes (Sqlite, and Postgres when GNL_PG_URL is set): a stranger who names
// `cont:<parent>:<toolCallId>` while the task runs must be refused, and the owner's agent woken once.
import { describe, it, expect, afterEach } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newStore, startNode, post, waitFor, stopNode, sleep, linesOf, effectCount, PG_BASE, type Node, type Store } from '../detached/harness.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'deferred-node.ts');
const live: Node[] = [];
const stores: Store[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map(stopNode));
  stores.splice(0).forEach((s) => s.drop());
});
const get = async (n: Node, path: string) => (await fetch(n.url(path))).json();
const kinds: Array<'sqlite' | 'postgres'> = PG_BASE ? ['sqlite', 'postgres'] : ['sqlite'];

describe.each(kinds)('B1 continuation id taken first (%s)', (kind) => {
  it(`${kind}: the stranger is refused and the owner is woken once`, { timeout: 60_000 }, async () => {
    const s = newStore(kind, 'ab'); stores.push(s);
    const env = { DF_TASK_MS: '1500', DF_SWEEP_MS: '200' };
    const a = await startNode(s, env, fixture); live.push(a);
    const b = await startNode(s, env, fixture); live.push(b);
    await post(a, '/chat', { runId: 'hx', threadId: 'THX', text: 'research reefs' });
    await waitFor(() => linesOf(`${s.effects}.started`).length === 1, 10_000, 'the body to start');
    const stranger = await post(b, '/chat', { runId: 'cont:hx:call-1', threadId: 'TMAL', text: 'hello', caller: 'mallory' });
    await waitFor(() => effectCount(s) === 1, 10_000, 'the effect');
    await sleep(3_000);
    const msgs: Array<{ role: string; text: string }> = await get(b, '/thread?threadId=THX');
    const wakes = linesOf(`${s.effects}.calls`).filter((l) => l.split(' ')[1] === 'cont').length;
    expect({
      strangerStatus: stranger.status,
      effects: effectCount(s),
      resultMessages: msgs.filter((m) => m.role === 'user' && m.text.startsWith('Background task')).length,
      wakes,
    }).toEqual({ strangerStatus: 404, effects: 1, resultMessages: 1, wakes: 1 });
  });
});
