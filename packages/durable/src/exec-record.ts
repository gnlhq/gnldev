// WHERE A DETACHED RUN'S EXECUTION RECORD LIVES — shared by the executor (detached.ts) and the erasure
// model (model.ts), so a run's deletion reaches the record that names it.
//
// The record is in the platform (unscoped) journal every process shares, keyed by the run's scope (an
// organization id, '' for the root) and its id. The trailing '#' closes the key: a prefix delete of one
// record never reaches another run whose id extends it (ids are encoded, so '#' cannot occur in them).

/** The family every execution record lives under. */
export const EXEC_PREFIX = '__exec__:';

/** The execution record of `runId` in `scope`. */
export const execKey = (scope: string | undefined, runId: string): string =>
  `${EXEC_PREFIX}${encodeURIComponent(scope ?? '')}/${encodeURIComponent(runId)}#`;

/** Every execution record of one organization (its purge deletes them). */
export const execScopePrefix = (orgId: string): string => `${EXEC_PREFIX}${encodeURIComponent(orgId)}/`;
