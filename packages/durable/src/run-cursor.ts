import type { RunSummary, RunStatus } from './journal.js';

/**
 * Where a run listing stopped: the last run a page handed out — never a row number.
 *
 * A row number (`LIMIT … OFFSET n`) is what every adapter used to hand out, and it had two costs.
 * A deep page paid for every row before it: on Postgres, 30 000 runs walked page by page took 71 s,
 * because each page at offset k re-read and discarded k rows (a page at offset 15 000 cost 132 ms,
 * the first page 3 ms). And a run inserted or deleted between two requests moved the window under
 * the reader, so a walk could skip or repeat a run. A position keyed on the row itself has neither:
 * `(created_at, run_id) > (at, runId)` is one index seek, and a run arriving or leaving elsewhere
 * does not move it.
 *
 * - `runId` — the last run handed out. Every reader can place it.
 * - `at` — that run's `created_at`, when the source keeps one in the order (Sqlite, Postgres). A
 *   source that orders an array it built (InMemory) does not, and a database reader resolves
 *   a position without it from the run itself.
 * - `next` — the run the next page starts with, as the source saw it. An array source places the
 *   cursor by it when the run above is gone (purged while the page was on screen).
 * - `seen` — how many runs this listing has handed out so far. Used only when neither run is left
 *   and the source cannot place the position any other way.
 *
 * The encoding is OPAQUE (see `Page`): callers pass `nextCursor` back verbatim.
 */
export interface RunPosition {
  runId: string;
  at?: number;
  next?: string;
  seen: number;
}

/** Which end a listing starts from. Ascending is the order runs were created in. */
export type RunOrder = 'asc' | 'desc';

// r1:<at>:<seen>:<length of runId>:<runId><next> — run ids may hold any character, so the first is
// measured rather than delimited.
const RUN_CURSOR = /^r1:(-?\d*):(\d+):(\d+):([\s\S]*)$/;

/** The opaque `nextCursor` of a run listing — the same family as `WorkStore.list`'s `w1:` (storage.ts). */
export function encodeRunCursor(p: RunPosition): string {
  return `r1:${p.at ?? ''}:${p.seen}:${p.runId.length}:${p.runId}${p.next ?? ''}`;
}

/**
 * The position a cursor names, or `undefined` for no cursor (the first page).
 *
 * Anything else is refused. `WorkStore.list` reads a cursor it never issued as "from the head",
 * which is safe there because its consumers skip finished records; a run list has no such reader. A
 * cursor answered with page one plus a fresh `nextCursor` looks like success, and a client that
 * appends pages (the Studio's) then shows the same runs again and again. That includes the row
 * numbers 0.10 and earlier handed out — they named a position in a window that has since moved, which
 * is the very thing this cursor replaces.
 */
export function decodeRunCursor(cursor: string | undefined): RunPosition | undefined {
  if (cursor === undefined || cursor === '') return undefined;
  const fail = (): never => {
    throw new TypeError(
      `@gnldev/durable: '${cursor}' is not a run-list cursor — pass back a page's nextCursor verbatim, or omit it for the first page.` +
        (/^\d+$/.test(cursor) ? ' Row-number cursors from @gnldev/durable 0.10 and earlier are no longer read.' : ''),
    );
  };
  const m = RUN_CURSOR.exec(cursor);
  const len = m ? Number(m[3]) : -1;
  if (!m || len > m[4]!.length) return fail();
  const next = m[4]!.slice(len);
  return { runId: m[4]!.slice(0, len), seen: Number(m[2]), ...(m[1] ? { at: Number(m[1]) } : {}), ...(next ? { next } : {}) };
}

/** Whether `cursor` is one a run listing can read — for a door that answers a bad one with a 400. */
export function isRunCursor(cursor: string): boolean {
  try { decodeRunCursor(cursor); return true; } catch { return false; }
}

/** The filters every run listing applies, in one place. */
export interface RunFilter {
  status?: RunStatus;
  /** Any of these statuses (`ListQuery.statuses`); with `status` too, a run must match both. */
  statuses?: readonly RunStatus[];
  agent?: string;
  resourceId?: string;
  workKey?: string;
  topLevel?: boolean;
  threadId?: string;
  runIdPrefix?: string;
}

export function matchesRunFilter(r: RunSummary, q: RunFilter | undefined): boolean {
  return (q?.status ? r.status === q.status : true) && (q?.statuses ? q.statuses.includes(r.status) : true)
    && (q?.agent ? r.agent === q.agent : true)
    && (q?.resourceId ? r.resourceId === q.resourceId : true)
    && (q?.threadId ? r.threadId === q.threadId : true)
    && (q?.runIdPrefix ? r.runId.startsWith(q.runIdPrefix) : true)
    && (q?.workKey ? r.workKey === q.workKey : true) && (q?.topLevel ? !r.parentRunId : true);
}

/**
 * The relation a listing can read from an index: who (`resource_id`) or where (`thread_id`). Handed
 * to an adapter's `read` by `keysetRunPage` when the adapter keeps those columns.
 */
export type RunRelationRead = { column: 'resource_id' | 'thread_id'; value: string };

/**
 * The order of ONE relation range: its whole index `(<column>, created_at, run_id)`, leading column
 * first, so the planner reads the range in order instead of sorting it. Postgres does not take
 * `resource_id IS NULL` as fixing that column the way `= $1` does; without it in the ORDER BY the
 * unplaced range was read whole and sorted for every page (see PostgresStorage.listRunsPaged).
 */
export const rangeOrder = (column: RunRelationRead['column'], dir: 'ASC' | 'DESC'): string =>
  `ORDER BY r.${column} ${dir}, r.created_at ${dir}, r.run_id ${dir}`;

/**
 * One page of runs from an array already in ascending creation order — the shape InMemory and a legacy
 * array reader produce. Filters before it slices (the listRunsPaged contract), and
 * places the cursor by its run: the position after `runId`, wherever that run now sits. When that
 * run is gone, the page starts at `next`; when both are gone, at `seen` — the best an array without
 * creation times can do.
 *
 * @internal — engine plumbing shared with the Studio and server run lists; gnl builds its argument from a validated request, no host writes it.
 */
export function pageRunsFromArray(
  ascending: readonly RunSummary[],
  q?: RunFilter & { limit?: number; cursor?: string; order?: RunOrder },
): { items: RunSummary[]; nextCursor?: string } {
  const pos = decodeRunCursor(q?.cursor);
  let list = ascending.filter((r) => matchesRunFilter(r, q));
  if (q?.order === 'desc') list = list.reverse();
  const limit = q?.limit ?? 50;
  let start = 0;
  if (pos) {
    const i = list.findIndex((r) => r.runId === pos.runId);
    const n = i >= 0 || pos.next === undefined ? -1 : list.findIndex((r) => r.runId === pos.next);
    start = i >= 0 ? i + 1 : n >= 0 ? n : Math.min(pos.seen, list.length);
  }
  const items = list.slice(start, start + limit);
  const last = items[items.length - 1];
  const following = list[start + limit];
  const seen = (pos?.seen ?? 0) + items.length;
  return { items, ...(following && last ? { nextCursor: encodeRunCursor({ runId: last.runId, next: following.runId, seen }) } : {}) };
}

/** One run as a database listing reads it: its summary and the `created_at` the order is keyed on. */
export interface KeyedRun {
  summary: RunSummary;
  at: number;
}

/**
 * One page of runs from a table keyed on `(created_at, run_id)` — Sqlite's and Postgres's `gnl_runs`.
 *
 * Each read is an index seek past the cursor's run, never `OFFSET` over the runs before it. A filter
 * the table has no column for (agent, resourceId, workKey, topLevel live in the `:input` blob) is
 * applied to rows read forward in chunks from the cursor until the page is full — never to every
 * row. One run past the page is read to know whether there is a next page, so the last page carries
 * no cursor (the `Page` contract) rather than one that leads to an empty page.
 *
 * `read(where, params, dir, take, skip, rel)` runs the adapter's SELECT; `ph(n)` writes its n-th bound
 * parameter (`?n` for Sqlite, `$n` for Postgres). `skip` is non-zero only for a cursor whose run is gone
 * and that carries no `created_at` — the one case a position must fall back to counting.
 *
 * RELATIONS. An adapter that keeps a run's person and thread in columns (`relations: true` — Sqlite and
 * Postgres, `runRelationsOf`) is handed `rel` for a `resourceId` or `threadId` filter, and reads TWO
 * ranges in one statement: the rows placed under that value, and every row not placed yet
 * (`resource_id IS NULL`: written before the columns, or by an older process). Never only the first —
 * an unplaced row is still a run, and the person's erasure or their own run list must see it. Each row
 * is then decided by `matchesRunFilter` from its `:input`, exactly as without the columns: the column
 * narrows what is read, the record decides what is listed.
 */
export async function keysetRunPage(
  q: (RunFilter & { limit?: number; cursor?: string; order?: RunOrder }) | undefined,
  statusCond: string | undefined,
  atOf: (runId: string) => number | undefined | Promise<number | undefined>,
  read: (where: string, params: unknown[], dir: 'ASC' | 'DESC', take: number, skip: number, rel?: RunRelationRead) => KeyedRun[] | Promise<KeyedRun[]>,
  ph: (n: number) => string = (n) => `?${n}`,
  relations = false,
  /**
   * `q.runIdPrefix` as SQL over the run id's index — `run_id >= prefix AND run_id < upper`, numbered
   * from `from` — built by the adapter, which knows its collation. Without it the prefix is a row
   * filter like `agent`: exact, and paid for by reading the rest.
   */
  runIdRange?: (prefix: string, from: number) => { where: string; params: unknown[] },
): Promise<{ items: RunSummary[]; nextCursor?: string }> {
  const limit = q?.limit ?? 50;
  const desc = q?.order === 'desc';
  const pos = decodeRunCursor(q?.cursor);
  const unindexed = !!(q?.agent || q?.resourceId || q?.threadId || q?.workKey || q?.topLevel || (q?.runIdPrefix && !runIdRange));
  // One column is read by index; with both filters given the other is decided per row, like any filter.
  const rel: RunRelationRead | undefined = !relations ? undefined
    : q?.resourceId ? { column: 'resource_id', value: q.resourceId }
    : q?.threadId ? { column: 'thread_id', value: q.threadId }
    : undefined;
  // `inclusive`: the position is placed BY the next run (its own run is gone), so that run is listed.
  let after: { at: number; runId: string; inclusive?: boolean } | undefined;
  let skip = 0;
  if (pos) {
    const at = pos.at ?? (await atOf(pos.runId));
    const nextAt = at === undefined && pos.next !== undefined ? await atOf(pos.next) : undefined;
    if (at !== undefined) after = { at: Number(at), runId: pos.runId };
    else if (nextAt !== undefined) after = { at: Number(nextAt), runId: pos.next!, inclusive: true };
    else skip = pos.seen;
  }
  // Every status the filter admits is an open one: the read is served by a partial index (runStatusSql).
  const openOnly = (q?.status !== undefined && q.status !== 'completed') || (q?.statuses !== undefined && !q.statuses.includes('completed'));
  const take = unindexed ? Math.max(limit + 1, 200) : limit + 1;
  let skipRows = unindexed ? 0 : skip;
  let skipMatches = unindexed ? skip : 0;
  const out: KeyedRun[] = [];
  for (;;) {
    const conds: string[] = statusCond ? [statusCond] : [];
    const params: unknown[] = [];
    if (after) {
      // A row comparison, the one form both planners read as a single range on the (created_at, run_id)
      // index. Written out as `created_at >= a AND (created_at > a OR run_id > b)` the Postgres plan
      // depended on its statistics: 10 000 runs walked in 1.3 s before an ANALYZE, 0.15 s after; the
      // row form took 0.13 s either way (and 30 000 runs 0.43 s).
      const [cmp, cmpEq] = desc ? ['<', '<='] : ['>', '>='];
      // A RELATION read is different: its index leads with the relation's column —
      // `(resource_id, created_at, run_id)` — so the position is a range on the SECOND column under an
      // equality (or IS NULL) on the first, `created_at >= a` as the index bound and the run id as a
      // filter on the rows of that one millisecond. Here the expanded form is the plain one, and the
      // row form is refused by pg-mem outright against that index ("cannot cast type list to list").
      // A read of open runs only (`openOnly`) is the same case: it reads the `gnl_runs_open` partial
      // index, pg-mem refuses the row form against it the same way, and on Postgres the expanded form
      // over that index is one bound either way — 1M runs, 167 open: 0.2–0.3 ms before and after an
      // ANALYZE. A read that can include 'completed' runs keeps the row form on `gnl_runs_created`.
      if (rel || openOnly) conds.push(`r.created_at ${cmpEq} ${ph(1)} AND (r.created_at ${cmp} ${ph(1)} OR r.run_id ${after.inclusive ? cmpEq : cmp} ${ph(2)})`);
      else conds.push(`(r.created_at, r.run_id) ${after.inclusive ? cmpEq : cmp} (${ph(1)}, ${ph(2)})`);
      params.push(after.at, after.runId);
    }
    if (q?.runIdPrefix && runIdRange) {
      const r = runIdRange(q.runIdPrefix, params.length + 1);
      conds.push(r.where);
      params.push(...r.params);
    }
    const rows = await read(conds.length ? ` WHERE ${conds.join(' AND ')}` : '', params, desc ? 'DESC' : 'ASC', take, skipRows, rel);
    skipRows = 0;
    for (const row of rows) {
      after = { at: row.at, runId: row.summary.runId };
      if (unindexed && !matchesRunFilter(row.summary, q)) continue;
      if (skipMatches > 0) { skipMatches--; continue; }
      out.push(row);
      if (out.length > limit) break;
    }
    if (out.length > limit || rows.length < take) break;
  }
  const items = out.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items: items.map((r) => r.summary),
    ...(out.length > limit && last ? { nextCursor: encodeRunCursor({ runId: last.summary.runId, at: last.at, next: out[limit]!.summary.runId, seen: (pos?.seen ?? 0) + items.length }) } : {}),
  };
}

/**
 * Every status a run can have that is not 'completed' — the runs a status read asks about in practice
 * (the approval inbox, the live part of a usage total). Counted on the 1M-run store the C+ audit
 * measured: 167 of 1 000 020. Kept in their own partial indexes on Sqlite and Postgres (`gnl_runs_open`
 * in creation order, `gnl_runs_status` by status), so finding them reads those rows and not the other
 * million.
 */
export const OPEN_RUN_STATUSES: readonly RunStatus[] = ['canceled', 'suspended', 'failed', 'running'];

/**
 * The partial indexes' predicate, word for word. A query reaches a partial index only when the planner
 * can prove the query's WHERE implies it, and Sqlite proves it only from a term it finds in the WHERE
 * as written — so every status filter below that admits no 'completed' run carries this exact term.
 * @internal — the Sqlite and Postgres adapters' DDL and listings.
 */
export const openRunPredicate = (alias = ''): string => `${alias}status <> 'completed'`;

/**
 * A run status filter as SQL over `gnl_runs.status` — the status the adapter wrote with the run's
 * counter and outcome (`runStatusOf`), so a filtered page and a full scan read the same column and
 * cannot disagree about a run. A filter that admits no 'completed' run carries `openRunPredicate`, the
 * term that lets both planners read the partial indexes: one status `gnl_runs_status`, the set of every
 * open status `gnl_runs_open`. `undefined` for no filter.
 * Statuses are written as literals: they are this union's own values, never a caller's string (an
 * unknown one matches nothing).
 * @internal — the Sqlite and Postgres adapters' `listRuns`.
 */
export function runStatusSql(q: { status?: RunStatus; statuses?: readonly RunStatus[] } | undefined): string | undefined {
  const known = (s: RunStatus): boolean => s === 'completed' || OPEN_RUN_STATUSES.includes(s);
  const set = (list: readonly RunStatus[]): string => {
    const valid = [...new Set(list)].filter(known);
    if (valid.length === 0) return `1 = 0`; // an empty set matches nothing, as `includes` says
    const open = valid.every((s) => s !== 'completed') ? `${openRunPredicate('r.')} AND ` : '';
    if (open && valid.length === OPEN_RUN_STATUSES.length) return openRunPredicate('r.');
    return valid.length === 1 ? `${open}r.status = '${valid[0]}'` : `${open}r.status IN (${valid.map((s) => `'${s}'`).join(', ')})`;
  };
  const conds: string[] = [];
  if (q?.status) conds.push(set([q.status]));
  if (q?.statuses) conds.push(set(q.statuses));
  return conds.length ? conds.join(' AND ') : undefined;
}

/** Where a change feed stopped: the last run it handed out, keyed on its `updated_at`. */
export interface ChangePosition {
  at: number;
  runId: string;
}

// c1:<at>:<length of runId>:<runId> — same measured-not-delimited run id as RUN_CURSOR.
const CHANGE_CURSOR = /^c1:(-?\d+):(\d+):([\s\S]*)$/;

/** The opaque cursor of `JournalReader.listRunsChangedSince`. @internal — adapters and the scoped views. */
export function encodeChangeCursor(p: ChangePosition): string {
  return `c1:${p.at}:${p.runId.length}:${p.runId}`;
}

/**
 * The position a change cursor names, or `undefined` for none. Anything else is refused, for the reason
 * `decodeRunCursor` gives: a cursor answered as "from the start" would replay every run as changed.
 * @internal — adapters and the scoped views.
 */
export function decodeChangeCursor(cursor: string | undefined): ChangePosition | undefined {
  if (cursor === undefined || cursor === '') return undefined;
  const m = CHANGE_CURSOR.exec(cursor);
  if (!m || Number(m[2]) !== m[3]!.length) {
    throw new TypeError(`@gnldev/durable: '${cursor}' is not a change-feed cursor — pass back a page's nextCursor verbatim, or omit it and give \`since\`.`);
  }
  return { at: Number(m[1]), runId: m[3]! };
}
