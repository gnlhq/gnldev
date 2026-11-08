/**
 * WHO MAY ANSWER A QUESTION — one module, one rule.
 *
 * A human gate asks one of two different questions, and they are answered by different people:
 *
 *   CONFIRM  ("are you sure?")  — consent. The person who asked for the work answers it; an authorised
 *                                 person (staff, the application server) may answer it too.
 *   APPROVE  ("may this happen?") — permission. Only an authorised person says yes. The requester's yes
 *                                 is refused with `ApprovalNotPermittedError` and nothing is journaled.
 *
 * Anybody's NO goes through: declining the work is within the requester's own `run:cancel`, and a no only
 * ever prevents a side effect.
 *
 * The rule has ONE owner, `resolveApprovals` (run.ts), where every answer from every door enters the
 * journal. A door does not decide who may answer: it says WHO answered (`Answerer`) and the engine
 * decides, so a new door cannot forget the check and there is no second copy to drift. This module holds
 * the vocabulary and the decision; run.ts calls it.
 */
import type { Caller } from './identity-types.js';
import { ApprovalNotPermittedError } from './errors.js';

/** Which of the two questions a gate asks. */
export type QuestionNeeds = 'confirm' | 'approve';

/** What a yes can be: staff (an operator, the application server) or the person the work is for. */
export type AnsweredAs = 'staff' | 'requester';

/**
 * WHO answered, as a door knows it. `answeredBy` is the verified identity in the one naming every identity
 * comparison already uses (@gnldev/auth `actorIdOf`: an end user's own id, `operator:<id>`, `application:<id>`);
 * `answeredAs` is the class the decision reads. A door builds this with @gnldev/auth `answererOf(principal)`.
 */
export interface Answerer {
  answeredBy?: string;
  answeredAs: AnsweredAs;
  /** @internal — set by the engine for a caller nobody named (a direct call with no `caller`): treated as staff, and said once. */
  unattributed?: true;
}

/** What `approvers` is called with: who answers, which question, and for whose work. */
export interface ApproverContext {
  answeredBy?: string;
  answeredAs: AnsweredAs;
  /** Who started the run (the end user, or the operator that began it) — what a four-eyes rule compares against. */
  startedBy?: string;
  runId: string;
  toolCallId: string;
  toolName?: string;
  args?: unknown;
}

/**
 * The createGnl `approvers` rule: may THIS answerer say yes to THIS approve question? When it is set it
 * REPLACES the default (staff only): whoever it names is authorised — an end-user token included — and it
 * may narrow the default as well as widen it.
 */
export type Approvers = (ctx: ApproverContext) => boolean | Promise<boolean>;

/**
 * Four eyes: an authorised person may approve only work somebody ELSE started. Staff answer; the one who
 * started the run (an operator who began it, or the end user it is for) does not.
 */
export function fourEyes(): Approvers {
  return ({ answeredAs, answeredBy, startedBy }) =>
    answeredAs === 'staff' && (answeredBy === undefined || startedBy === undefined || answeredBy !== startedBy);
}

/**
 * The answerer a direct engine call stands for when no door said otherwise, from the `caller` it declared:
 * `user` → the requester; `staff` → staff; nobody named (no `caller`, or `unknown`) → staff, and unattributed,
 * which `assertMayAnswer` says out loud once when it matters.
 */
export function answererOfCaller(caller: Caller | undefined): Answerer {
  if (caller?.kind === 'user') return { answeredBy: caller.id, answeredAs: 'requester' };
  if (caller?.kind === 'staff') return { answeredAs: 'staff' };
  return { answeredAs: 'staff', unattributed: true };
}

/** Who started a run, by the name an answer is attributed with: the door's named answerer, else the user the call declared. */
export function startedByOf(answerer: Answerer | undefined, caller: Caller | undefined): string | undefined {
  return answerer?.answeredBy ?? (caller?.kind === 'user' ? caller.id : undefined);
}

/** An open question, as the journal holds it. */
export interface OpenQuestion {
  toolCallId: string;
  needs: QuestionNeeds;
  toolName?: string;
  args?: unknown;
}

/**
 * @internal — engine plumbing (run.ts reads a stored sentinel with it); a host does not call it.
 *
 * The need a sentinel carries. A sentinel written before `needs` existed is read by its `kind`: the repeat
 * questions and the tool's own `confirm` are consent; every other kind — and one this build does not know —
 * is permission (the safe direction: an unknown question is never answered by the requester).
 */
export function needsOfSuspend(sus: { needs?: unknown; kind?: unknown } | undefined): QuestionNeeds {
  if (sus?.needs === 'confirm' || sus?.needs === 'approve') return sus.needs;
  return sus?.kind === 'confirm' || sus?.kind === 'duplicate' || sus?.kind === 'semantic' ? 'confirm' : 'approve';
}

/** An authorised yes covers BOTH questions (a staff member's yes is consent too); a requester's only the confirm. */
export type Grant = QuestionNeeds;

let warnedUnattributed = false;
/** @internal — test hook: the one-time warning is per process. */
export function resetUnattributedWarning(): void { warnedUnattributed = false; }

/**
 * May this answerer say YES to this question? Resolves to the level the yes grants: `'approve'` for an
 * authorised answerer, `'confirm'` for the requester answering a confirm question. Throws
 * `ApprovalNotPermittedError` for a yes the answerer may not give — the caller records nothing.
 *
 * Never called for a NO: a no is everybody's.
 */
export async function assertMayAnswer(
  q: OpenQuestion,
  who: { runId: string; answerer: Answerer; approvers?: Approvers; startedBy?: string },
): Promise<Grant> {
  const { answerer, approvers } = who;
  let authorised: boolean;
  if (approvers) {
    // The developer's rule replaces the default. It is asked about every yes, so the record can say whether
    // the answerer was authorised — but only an approve question is refused by it.
    authorised = (await approvers({
      ...(answerer.answeredBy !== undefined ? { answeredBy: answerer.answeredBy } : {}),
      answeredAs: answerer.answeredAs,
      ...(who.startedBy !== undefined ? { startedBy: who.startedBy } : {}),
      runId: who.runId, toolCallId: q.toolCallId,
      ...(q.toolName !== undefined ? { toolName: q.toolName } : {}),
      ...(q.args !== undefined ? { args: q.args } : {}),
    })) === true;
  } else {
    authorised = answerer.answeredAs === 'staff';
  }
  if (authorised) {
    if (!approvers && answerer.unattributed && q.needs === 'approve' && !warnedUnattributed) {
      warnedUnattributed = true;
      console.warn(
        `@gnldev/durable: an approve question ('${q.toolName ?? q.toolCallId}', run '${who.runId}') was answered by a caller nobody named, and counted as authorised. ` +
          'If the answer comes from a user, pass `resourceId` (the user is then refused); if it comes from staff, pass `caller: STAFF`.',
      );
    }
    return 'approve';
  }
  if (q.needs === 'confirm') return 'confirm';
  throw new ApprovalNotPermittedError({
    runId: who.runId, toolCallId: q.toolCallId, ...(q.toolName !== undefined ? { toolName: q.toolName } : {}),
    answeredAs: answerer.answeredAs, ...(approvers ? { rule: 'approvers' as const } : {}),
  });
}

/**
 * A call's own failed attempt whose claim is now held by a QUESTION is superseded by it. Under an idempotency
 * window several calls share one claim; once a later call of the same work asked "its effect MAY already have
 * happened" over the failed attempt, that open question is the only thing that can release the work — an
 * earlier yes (given for the call's first attempt) answered a different question and does not stand in for
 * it. The one rule behind two readers: the call, which replays its failure instead of retrying or asking
 * afresh, and the run's list of open questions, which does not offer the superseded call for an answer.
 */
export const isSupersededFailure = (
  own: { status?: string; sideEffect?: boolean } | undefined,
  claim: { status?: string } | undefined,
): boolean => own?.status === 'failed' && own.sideEffect === true && claim?.status === 'suspended';
