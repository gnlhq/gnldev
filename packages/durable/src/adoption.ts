// THE ADOPTION RULES — what `adoptIntoOrg` does with a root entry, the same on every store.
//
// Adoption moves the root's data into an organization (`org:<id>:…`). Most of it simply moves. What
// needs a rule is what MEETS something there, or is not data at all:
//
//  - a SCOPE FACT (`isScopeFact`) never moves — it speaks for one scope's data only;
//  - an entry whose organization twin exists is decided by its KIND (`onAdoptionCollision`): a counter
//    is summed, a content-addressed cache entry is the organization's already, and any other record
//    refuses the whole adoption before anything moves (`AdoptionConflictError`).
//
// Each store applies these; none restates them. Work-store keys have their own rule beside the store
// (`workKeyAdoption`, storage.ts), and vector documents theirs (`vectorAdoptCollision`).
import { execScopePrefix } from './exec-record.js';
import { THREAD_RECORDS_KEY } from './thread-owner.js';
import { AdoptionConflictError } from './errors.js';
import { ENGINE_META_KEYS, isPlatformKey } from './organization.js';

/**
 * The keys that state a fact about a whole SCOPE rather than hold a record of it: true of the data
 * written under that scope, and of nothing else. Stored as ordinary keys, so an organization's view
 * writes its own under its prefix — but they are not data, and `adoptIntoOrg` never moves one.
 */
const SCOPE_FACT_KEYS: readonly string[] = [THREAD_RECORDS_KEY];

/** Whether a root key is a scope fact (`SCOPE_FACT_KEYS`), which `adoptIntoOrg` leaves where it is. */
/**
 * The ROOT scope's execution records (exec-record.ts): adoption drops them. They name runs the adoption
 * moves into the organization — left behind they would say a run is the root's to continue, against a
 * root journal it is no longer in. Only runs that nothing executes can be adopted (`assertNoRunsInFlight`),
 * so what is dropped is a parked run's record; its next start (an approval) writes it again, in the
 * organization's scope.
 */
export const ROOT_EXEC_RECORDS = execScopePrefix('');

export function isScopeFact(key: string): boolean {
  return SCOPE_FACT_KEYS.includes(key);
}

/** The keys `scopeFactsDroppedByAdoption` asks about: every scope fact, the root's and the organization's. */
export function scopeFactKeys(orgKeyPrefix: string): string[] {
  return SCOPE_FACT_KEYS.flatMap((k) => [k, orgKeyPrefix + k]);
}

/**
 * THE ADOPTION RULE FOR A SCOPE FACT. Answers the organization's fact keys the adoption must DELETE,
 * given which of `scopeFactKeys` the store holds.
 *
 * The root's fact is not moved: it speaks for the root's data, never for the organization's (carried,
 * an organization holding a thread from before owner records read that thread as new, and a stranger
 * became its owner — measured on every store). The organization's own fact survives only when the root
 * held it too: two scopes whose every thread has its record are one such scope together, and a root
 * without the fact hands over threads the organization's fact says nothing about. Dropping a fact is
 * always safe — without it the gate reads the thread's runs, and `thread-records` reports the
 * organization pending until it writes the fact again.
 */
export function scopeFactsDroppedByAdoption(orgKeyPrefix: string, held: ReadonlySet<string>): string[] {
  return SCOPE_FACT_KEYS.filter((k) => held.has(orgKeyPrefix + k) && !held.has(k)).map((k) => orgKeyPrefix + k);
}

/**
 * Whether a root key stays where it is under adoption, and so can collide with nothing: the platform's
 * (`isPlatformKey`), the engine's own meta rows (`ENGINE_META_KEYS`), a scope fact.
 */
export function staysAtRoot(key: string): boolean {
  return isScopeFact(key) || isPlatformKey(key) || ENGINE_META_KEYS.includes(key);
}

/**
 * What a store keeps under an adopted id, for the one question adoption asks of it:
 *  - `counter` — an increment-only total (`Journal.incrBy`: usage, metrics, a run's counters). Its value
 *    is the sum of what was added, wherever it was added;
 *  - `content-addressed` — a cache entry whose key names its content (`CacheStore`): two entries under
 *    one key hold the same thing;
 *  - `record` — everything else: a journal record (a thread's owner record among them), a run, a
 *    thread, its messages, a working memory, a meta row.
 */
export type AdoptedKind = 'record' | 'counter' | 'content-addressed';

/**
 * THE ADOPTION RULE FOR A COLLISION — a root entry whose organization twin already exists:
 *  - a counter is SUMMED into the organization's, in the same transaction as the move;
 *  - a content-addressed entry is the organization's already: the root's copy is dropped;
 *  - a record REFUSES the adoption, before anything moves (`adoptionConflict`). Adoption never replaces
 *    what the organization holds — a thread's owner moved by an adoption is an owner nobody chose —
 *    and neither copy may silently win.
 */
export function onAdoptionCollision(kind: AdoptedKind): 'sum' | 'keep-organization' | 'refuse' {
  return kind === 'counter' ? 'sum' : kind === 'content-addressed' ? 'keep-organization' : 'refuse';
}

/** How many colliding ids an `AdoptionConflictError` names (`count` says how many there are). */
export const ADOPTION_CONFLICT_LIST = 20;

/** The refusal for records the organization already holds — see `onAdoptionCollision`. */
export function adoptionConflict(orgId: string, orgKeys: Iterable<string>): AdoptionConflictError {
  const all = [...new Set(orgKeys)].sort();
  const keys = all.slice(0, ADOPTION_CONFLICT_LIST);
  return new AdoptionConflictError(
    `@gnldev/durable: adoptIntoOrg would move ${all.length} root entr${all.length === 1 ? 'y' : 'ies'} onto ids the organization '${orgId}' `
      + `already holds (${keys.join(', ')}${all.length > keys.length ? ', …' : ''}). Adoption never replaces what the organization holds — `
      + 'a thread\'s owner record least of all. Nothing was moved. Delete or rename one side of each, then adopt again.',
    { orgId, keys, count: all.length },
  );
}
