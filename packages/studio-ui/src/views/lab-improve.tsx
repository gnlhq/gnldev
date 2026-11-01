// The Lab's Improve tab: one screen for a run and for a thread. A thread's turns sit on a strip above
// (folded away by whoever wants the turn alone); the turn chosen — a run sent from the Inspector (with its
// thread, so nothing is asked to find it), or the thread's failed turn — is explained, proven and changed below, against one written expectation. Only
// that turn is played again: the turns after it are not changed. A run of no thread has no strip.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { LabThreadTurn } from '../api';
import { Spinner, ErrorBox, Btn } from '../components';
import { Explain, Capsule, ExpectBox, expectationOf, type ExpectDraft } from './Lab';
import { useHypotheses, useThreadTurns, ThreadStrip, TurnDiagnosis, defaultTurn } from './lab-thread';
import { Words } from './lab-words';
import { Prune } from './lab-prune';
import '../i18n';

/** Where the Improve tab is: a run, a thread, or both (a run of that thread) — as the Inspector sent it. */
export interface ImproveTarget { runId?: string; threadId?: string }

export function Improve({ target, models }: { target: ImproveTarget; models: string[] }) {
  const { t } = useTranslation('lab');
  const navigate = useNavigate();
  const threadId = target.threadId;
  const [model, setModel] = useState(models[0] ?? '');
  const [trials, setTrials] = useState<number | undefined>();
  const [offset, setOffset] = useState(0);
  const [picked, setPicked] = useState<string | undefined>(target.runId);
  useEffect(() => { setPicked(target.runId); setOffset(0); }, [target.runId, target.threadId]);
  const [draft, setDraft] = useState<ExpectDraft>({ calls: '', forbidden: '', answer: '' });
  const turns0 = useHypotheses(picked);
  const plan = useThreadTurns({ threadId, model, ...(trials !== undefined ? { trials } : {}), offset, h: turns0 });
  const turns = plan.data?.turns ?? [];
  // The run asked for, else the thread's failed turn (defaultTurn); a run of no thread is its own turn.
  const turnId = threadId ? (picked && turns.some((x) => x.runId === picked) ? picked : defaultTurn(turns)) : target.runId;
  const turn: LabThreadTurn | undefined = turns.find((x) => x.runId === turnId);
  const want = expectationOf(draft);
  const expect = 'expect' in want ? want.expect : undefined;

  return (
    <div className="space-y-4 text-xs" data-testid="lab-improve">
      {!target.runId && !target.threadId ? (
        <div className="flex flex-col items-start gap-2" data-testid="lab-pick-run">
          <p className="text-muted-foreground">{t('pickAnything')}</p>
          <Btn variant="outline" size="xs" onClick={() => navigate('/inspector')}>{t('openInspector')}</Btn>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2" data-testid="lab-selected">
          {/* What the Inspector sent: a run (its thread's turns, if any, shown around it) or a thread. */}
          <span className={target.runId ? 'rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium uppercase text-primary' : 'rounded bg-info/15 px-1.5 py-0.5 text-[10px] font-medium uppercase text-info'} data-testid="lab-selected-kind">
            {t(target.runId ? 'selectedRun' : 'selectedThread')}
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">{target.runId ?? threadId}</span>
          {target.runId && threadId && <span className="text-[11px] text-muted-foreground">{t('selectedInThread', { thread: threadId })}</span>}
          {turnId && <Btn variant="outline" size="xs" onClick={() => navigate(`/inspector?run=${encodeURIComponent(turnId)}`)}>{t('backToRun')}</Btn>}
        </div>
      )}
      {threadId && plan.isLoading && <Spinner />}
      {threadId && plan.error && <ErrorBox error={plan.error} />}
      {threadId && plan.data && <ThreadStrip plan={plan.data} selectedId={turnId} onSelect={setPicked} onPage={(o) => { setOffset(o); setPicked(undefined); }} />}
      {turnId && (
        <>
          <p role="note" className="rounded-md border border-info/40 bg-info/10 px-2 py-1.5 text-info" data-testid="only-this-turn">
            {threadId ? t('onlyThisTurn', { turn: turn?.turn ?? '?' }) : t('onlyThisRun')}
          </p>
          <ExpectBox draft={draft} onChange={setDraft} help={t('expectShared')} />
          <section className="space-y-3 rounded-md border border-border p-3" aria-labelledby="step-why" data-testid="step-why">
            <h2 id="step-why" className="text-sm font-medium">{t('stepWhy')}</h2>
            <p className="text-muted-foreground">{t('stepWhyHelp')}</p>
            <Explain key={`x-${turnId}`} runId={turnId} models={models} />
            <Words key={`w-${turnId}`} runId={turnId} models={models} />
            {threadId ? (turn
              ? <TurnDiagnosis key={`d-${turnId}`} turn={turn} models={models} model={model} setModel={setModel} trials={trials} setTrials={setTrials} expect={expect} h={turns0} />
              : null)
              : <p className="text-muted-foreground" data-testid="no-thread-proof">{t('proofNeedsThread')}</p>}
          </section>
          <section className="space-y-3 rounded-md border border-border p-3" aria-labelledby="step-change" data-testid="step-change">
            <h2 id="step-change" className="text-sm font-medium">{t('stepChange')}</h2>
            <Capsule key={`c-${turnId}`} runId={turnId} models={models} expectDraft={draft} />
            <Prune key={`p-${turnId}`} runId={turnId} models={models} />
          </section>
        </>
      )}
    </div>
  );
}
