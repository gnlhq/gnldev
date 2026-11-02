// The Lab's thread diagnosis, in pieces the Improve tab composes: a thread's turns on a strip, one turn chosen, what a right answer does
// written down, the plan read before anything is spent — then the diagnosis (@gnldev/lab diagnoseTurn
// through the host's lab): elimination, fresh plays of each candidate changed beside the turn unchanged,
// and a verdict by rules written before any play. Nothing is changed anywhere: the run, its thread and
// its memory are only read, no tool runs, and the result is a report and a kept experiment.
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, useLabThreadPlan, type LabUntestable, type LabArm, type LabExpectation, type LabThreadBody, type LabThreadDiagnosis, type LabThreadTurn } from '../api';
import { Btn, cn } from '../components';
import { ConfirmDialog } from '../ui';
import { formatUsd } from './Optimizer';
import { useLabCall, Progress, JobError, KeptExperiments, selectCls, confirmText, callLabel, layoutReasonText } from './Lab';
import { TimelineChart, CompositionChart, ShapleyChart, ForestChart, PathsChart, shareOf, ranOf } from './lab-charts';
import '../i18n';

type T = (k: string, o?: Record<string, unknown>) => string;
const pct = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${Math.round(x * 100)}%`);

// ── Pure (tested) ───────────────────────────────────────────────────────────────────────────────────

/** The turn shown first: the last one judged wrong, else the last that failed, else the last that can be diagnosed. */
export function defaultTurn(turns: readonly LabThreadTurn[]): string | undefined {
  const ok = turns.filter((x) => x.diagnosable);
  return (ok.filter((x) => x.expected && !x.expected.pass).at(-1) ?? ok.filter((x) => x.class === 'failed').at(-1) ?? ok.at(-1) ?? turns.at(-1))?.runId;
}

/** The tool results the person replaces, written as a JSON list of { toolName, args, output }; empty text is none. */
/** A candidate that cannot be tested, in the reader's language when the server gave its codes; its words otherwise. */
export function untestableText(t: (k: string, o?: Record<string, unknown>) => string, u: LabUntestable): string {
  if (!u.kind) return t('untestableLine', { candidate: u.candidate, reason: u.reason });
  const reason = u.layoutReason !== undefined ? layoutReasonText(t, { reason: u.layoutReason, detail: u.reason })
    : u.wmStatus !== undefined ? t('untestableWmPlace', { status: u.wmStatus })
    : u.rows !== undefined ? t('untestableRows', { n: u.rows }) : u.reason;
  return t('untestableLine', { candidate: t(`untestable_${u.kind}`), reason });
}

export function overridesOf(text: string): { overrides: NonNullable<LabThreadBody['overrides']> } | { error: string } {
  if (!text.trim()) return { overrides: [] };
  try {
    const v = JSON.parse(text);
    const list = Array.isArray(v) ? v : [v];
    if (!list.every((o) => o && typeof o === 'object' && typeof o.toolName === 'string' && 'output' in o)) return { error: 'shape' };
    return { overrides: list.map((o) => ({ toolName: o.toolName, args: o.args ?? {}, output: o.output })) };
  } catch { return { error: 'json' }; }
}

const labelOf = (d: Pick<LabThreadDiagnosis, 'arms' | 'joint'>, id: string) => [...d.arms, ...(d.joint ? [d.joint] : [])].find((a) => a.id === id)?.label ?? id;

/** The verdict in one sentence, in the page's language, from the verdict's kind and the arms' labels. */
export function verdictText(d: Pick<LabThreadDiagnosis, 'verdict' | 'arms' | 'joint'>, t: T): string {
  const v = d.verdict, base = d.arms[0];
  switch (v.kind) {
    case 'chance': return t('verdictChance', { passed: base?.passed ?? 0, judged: base ? ranOf(base) : 0 });
    case 'cause': {
      const a = d.arms.find((x) => x.id === v.arm);
      return t('verdictCause', { arm: labelOf(d, v.arm), from: `${base?.passed ?? 0}/${base ? ranOf(base) : 0}`, to: a ? `${a.passed}/${ranOf(a)}` : '—' })
        + (v.also.length ? ` ${t('verdictAlso', { arms: v.also.map((x) => labelOf(d, x)).join('; ') })}` : '');
    }
    case 'indistinct': return t('verdictIndistinct', { a: labelOf(d, v.arms[0]), b: labelOf(d, v.arms[1]) });
    case 'joint': return t('verdictJoint', { a: labelOf(d, v.arms[0]), b: labelOf(d, v.arms[1]), to: d.joint ? `${d.joint.passed}/${ranOf(d.joint)}` : '—' });
    case 'not-found': return v.uncorrected?.length ? t('verdictNotFoundUncorrected', { parts: v.uncorrected.join('; ') }) : t('verdictNotFound');
    case 'untested': return v.untested.length ? t('verdictUntestedArms', { arms: v.untested.map((x) => labelOf(d, x)).join('; ') }) : t('verdictUntestedNone');
    case 'undecided': return t('verdictUndecided');
  }
}

/** The forest plot's finding: the arm that moved the rate most, against the turn unchanged. */
export function forestFinding(arms: readonly LabArm[], t: T): string {
  const base = arms[0];
  const best = arms.slice(1).filter((a) => a.difference?.value !== null && a.difference?.value !== undefined).sort((a, b) => (b.difference!.value ?? 0) - (a.difference!.value ?? 0))[0];
  if (!base) return '';
  if (!best) return t('figForestBaseOnly', { passed: base.passed, judged: ranOf(base) });
  const helped = best.difference!.low !== null && best.difference!.low > 0;
  return t(helped ? 'figForestHelped' : 'figForestNot', { arm: best.label, to: `${best.passed}/${ranOf(best)}`, from: `${base.passed}/${ranOf(base)}` });
}

/** The diagnosis as a Markdown report: verdict, what a right answer is, the arms, the shares, the input, the ways the plays went, the limits, and the request that reproduces it. */
export function threadReport(d: LabThreadDiagnosis, t: T, request?: LabThreadBody): string {
  const lines: string[] = [];
  const row = (cells: Array<string | number>) => `| ${cells.map((c) => String(c).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`;
  lines.push(`# ${t('reportTitle', { turn: d.turn ?? '?', run: d.runId })}`, '');
  lines.push(`**${t('reportVerdict')}:** ${verdictText(d, t)}`, '');
  lines.push(`## ${t('reportSuccess')}`, '', '```json', JSON.stringify(d.expect, null, 2), '```', '');
  const dt = (x?: { value: number | null; low: number | null; high: number | null }) => (x ? `${pct(x.value)} (${pct(x.low)} … ${pct(x.high)})` : '—');
  // One denominator (the plays that ran), the worst case first; the judged-only figures last, named as such.
  lines.push(`## ${t('reportArms')}`, '', row([t('colArm'), t('colRight'), t('colBounds'), t('colDifference'), t('colUndetermined'), t('colErrors'), t('colJudgedOnly'), t('colObserved')]), row(['---', '---', '---', '---', '---', '---', '---', '---']));
  for (const a of [...d.arms, ...(d.joint ? [d.joint] : [])]) {
    lines.push(row([a.label, `${a.passed}/${ranOf(a)}`, a.bounds ? `${pct(a.bounds.low.value)}–${pct(a.bounds.high.value)}` : '—', a.untested ? t('figUntested') : dt(a.difference), a.undetermined, a.failed, `${a.passed}/${a.judged} (${pct(a.rate.value)})`, dt(a.observedDifference)]));
  }
  lines.push('', t('reportLevel', { m: d.comparisons, z: d.z.toFixed(2) }), '', t('reportBounds'), '');
  for (const a of [...d.arms, ...(d.joint ? [d.joint] : [])]) {
    if (a.untested) lines.push(`- ${t('armUntested', { arm: a.label, n: a.undetermined, of: a.judged + a.undetermined, calls: (a.pending ?? []).map(callLabel).join(', ') || '—' })}`);
  }
  lines.push(`## ${t('reportShapley')}`, '');
  if (d.elimination.error) lines.push(t('reportEliminationError', { error: d.elimination.error }), '');
  else {
    lines.push(row([t('colPart'), t('colBlame'), t('colNoise')]), row(['---', '---', '---']));
    for (const s of d.elimination.shares) lines.push(row([s.part, s.blame.toFixed(2), s.noise === null ? '—' : s.noise.toFixed(2)]));
    lines.push('', t('reportShapleyNote', { plays: d.elimination.plays }), '');
  }
  lines.push(`## ${t('reportComposition')}`, '');
  const shares = shareOf(d.composition);
  if (!shares.length) lines.push(t('figNoLayout'), '');
  else {
    lines.push(row([t('colSource'), t('colChars'), t('colShare')]), row(['---', '---', '---']));
    for (const s of shares) lines.push(row([t(`src_${s.source}`), s.chars, pct(s.share)]));
    lines.push('', t('figCharShare'), '');
  }
  lines.push(`## ${t('reportPaths')}`, '');
  for (const a of d.arms) {
    lines.push(`- **${a.label}**`);
    for (const p of a.paths) lines.push(`  - ${p.count}× ${p.calls.length ? p.calls.map(callLabel).join(' → ') : t('noCalls')}${p.passed ? ` (✓ ${p.passed})` : ''}`);
  }
  lines.push('', `## ${t('reportLimits')}`, '');
  lines.push(`- ${t('reportLimitTools')}`, `- ${t('reportLimitHuman')}`, `- ${t('reportLimitNoise')}`, `- ${t('reportLimitN', { n: d.plan.trials, d: pct(d.plan.worstCaseDetectableDifference ?? d.plan.detectableDifference) })}`);
  for (const u of d.untestable) lines.push(`- ${untestableText(t, u)}`);
  for (const n of d.notes) lines.push(`- ${n}`);
  const body = request ?? { runId: d.runId, model: d.model, expect: d.expect, trials: d.plan.trials };
  lines.push('', `## ${t('reportReproduce')}`, '', '```json', JSON.stringify(body, null, 2), '```', '');
  return lines.join('\n');
}

/** Downloads text as a file (browser side effect — kept separate from the report, not tested). */
function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── The result ──────────────────────────────────────────────────────────────────────────────────────

/**
 * What each part should have said, to diagnose again with: the parts the model proposed a correction for
 * (filled with it, marked) and those elimination blamed but only left out (empty). The text stays here.
 */
function Corrections({ d, onCorrect }: { d: LabThreadDiagnosis; onCorrect: (c: Record<string, string>) => void }) {
  const { t } = useTranslation('lab');
  const suggested = new Map((d.suggestions ?? []).map((x) => [x.part, x.text]));
  const parts = [...new Set([...suggested.keys(), ...(d.verdict.kind === 'not-found' ? d.verdict.uncorrected ?? [] : [])])];
  const [text, setText] = useState<Record<string, string>>(() => Object.fromEntries(parts.map((p) => [p, suggested.get(p) ?? ''])));
  if (parts.length === 0) return null;
  const filled = Object.fromEntries(Object.entries(text).filter(([, v]) => v.trim() !== ''));
  return (
    <div className="space-y-2 rounded-md border border-border bg-card p-3" data-testid="thread-corrections">
      <h3 className="font-medium">{t('correctionsTitle')}</h3>
      <p className="text-muted-foreground">{t('correctionsHelp')}</p>
      {parts.map((part) => (
        <label key={part} className="flex flex-col gap-1">
          <span className="flex items-center gap-2"><span className="font-medium">{part}</span>{suggested.has(part) && <span className="rounded bg-info/15 px-1.5 py-0.5 text-[10px] text-info">{t('correctionSuggested')}</span>}</span>
          <textarea aria-label={t('correctionFor', { part })} className="w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none" rows={3}
            value={text[part] ?? ''} onChange={(e) => setText({ ...text, [part]: e.target.value })} />
        </label>
      ))}
      <Btn size="xs" disabled={Object.keys(filled).length === 0} onClick={() => onCorrect(filled)}>{t('correctionsRun')}</Btn>
    </div>
  );
}

/** What the model guessed first, and whether the plays bore it out — a guess is never the verdict by itself. */
function GuessLine({ g, skipped }: { g: NonNullable<LabThreadDiagnosis['guess']>; skipped: boolean }) {
  const { t } = useTranslation('lab');
  const parts = g.parts.map((p) => p.part).join(', ') || '—';
  return (
    <div className={cn('rounded-md border p-2', g.verified ? 'border-success/40 bg-success/10' : 'border-border bg-muted/40')} data-testid="thread-guess-line">
      <p>{g.verified ? t('guessVerified', { parts }) : g.parts.length ? t('guessNotBorne', { parts }) : t('guessNone')}</p>
      {g.parts.filter((p) => p.correction).map((p) => <p key={p.part} className="mt-1 text-muted-foreground">{t('guessCorrection', { part: p.part })} <span className="font-mono">{p.correction}</span></p>)}
      {skipped && <p className="mt-1 text-[11px] text-muted-foreground">{t('guessSkippedNote')}</p>}
    </div>
  );
}

export function ThreadResult({ d, request, onCorrect }: { d: LabThreadDiagnosis; request?: LabThreadBody; onCorrect?: (c: Record<string, string>) => void }) {
  const { t } = useTranslation('lab');
  const arms = [...d.arms, ...(d.joint ? [d.joint] : [])];
  const tone = d.verdict.kind === 'cause' || d.verdict.kind === 'joint' ? 'border-success/40 bg-success/10'
    : d.verdict.kind === 'chance' ? 'border-info/40 bg-info/10'
    : d.verdict.kind === 'untested' || d.verdict.kind === 'undecided' ? 'border-warning/40 bg-warning/10' : 'border-border bg-muted/40';
  return (
    <section className="mt-4 space-y-4 text-xs" data-testid="thread-result">
      <div role="status" className={cn('rounded-md border p-3', tone)} data-testid="thread-verdict">
        <p className="text-[11px] uppercase text-muted-foreground">{t(`verdictKind_${d.verdict.kind}`)}</p>
        <p className="mt-1 text-sm font-medium">{verdictText(d, t)}</p>
        {d.untestable.length > 0 && (
          <ul className="mt-2 list-disc pl-4 text-muted-foreground" data-testid="thread-untestable">
            {d.untestable.map((u, i) => <li key={i}>{untestableText(t, u)}</li>)}
          </ul>
        )}
      </div>
      {d.guess && <GuessLine g={d.guess} skipped={!!d.elimination.skipped} />}
      {arms.some((a) => a.untested) && (
        <ul role="status" className="list-disc rounded-md border border-warning/40 bg-warning/10 p-2 pl-6 text-warning" data-testid="thread-untested-arms">
          {arms.filter((a) => a.untested).map((a) => <li key={a.id}>{t('armUntested', { arm: a.label, n: a.undetermined, of: a.judged + a.undetermined, calls: (a.pending ?? []).map(callLabel).join(', ') || '—' })}</li>)}
        </ul>
      )}
      {onCorrect && <Corrections key={d.runId + (d.suggestions ?? []).map((x) => x.part).join()} d={d} onCorrect={onCorrect} />}
      {d.notes.length > 0 && <ul className="list-disc pl-4 text-muted-foreground">{d.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      <div className="rounded-md border border-border bg-card p-3">
        {d.elimination.skipped ? <p className="text-muted-foreground" data-testid="elimination-skipped">{t('eliminationSkipped')}</p> : d.elimination.error ? <p className="text-muted-foreground">{t('eliminationError', { error: d.elimination.error })}</p> : <ShapleyChart shares={d.elimination.shares} />}
      </div>
      <div className="rounded-md border border-border bg-card p-3"><ForestChart arms={arms} finding={forestFinding(arms, t)} /></div>
      <div className="rounded-md border border-border bg-card p-3"><PathsChart arms={arms} /></div>
      <div className="flex flex-wrap items-center gap-3">
        <Btn variant="outline" size="xs" onClick={() => downloadText(`gnl-thread-diagnosis-${d.runId}.md`, threadReport(d, t, request), 'text/markdown;charset=utf-8;')}>{t('downloadReport')}</Btn>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {t('threadFooter', { plays: d.plays, failed: d.failed, model: d.model, tokens: (d.inputTokens + d.outputTokens).toLocaleString() })}
          {' · '}{d.priced ? formatUsd(d.costUsd) : t('unpriced')}
          {d.plan && <>{' · '}{t('spentOfPlanMost', { plays: d.plan.totalPlays, tokens: d.plan.tokens.toLocaleString() })}</>}
        </span>
      </div>
    </section>
  );
}

// ── The page ────────────────────────────────────────────────────────────────────────────────────────

function TurnPanel({ turn }: { turn: LabThreadTurn }) {
  const { t } = useTranslation('lab');
  const x = turn.experiments;
  return (
    <div className="space-y-3" data-testid="thread-turn">
      <p>
        <span className="font-medium">{t('turnHeading', { turn: turn.turn })}</span>{' '}
        <span className="font-mono text-[11px] text-muted-foreground">{turn.runId}</span>{' · '}{t(`class_${turn.class}`)}
        {turn.classReason ? ` (${turn.classReason})` : ''}
      </p>
      {turn.layout.status === 'absent' && <p role="status" className="rounded-md border border-border bg-muted/40 px-2 py-1.5 text-muted-foreground">{t('capsuleNoLayout')} {layoutReasonText(t, turn.layout)}</p>}
      <CompositionChart composition={turn.composition} turn={turn.turn} />
      {!turn.diagnosable && <p role="status" className="text-muted-foreground" data-testid="thread-not-diagnosable">{t('notDiagnosable', { why: turn.whyNot ?? '' })}</p>}
      {x && (
        <div className="space-y-1">
          <h3 className="font-medium">{t('candidatesTitle')}</h3>
          <ul className="space-y-0.5">
            {x.suspects.map((s) => <li key={s.id} className="flex items-baseline gap-2"><span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{t(`kind_${s.kind}`)}</span><span className="font-medium">{s.id}</span><span className="truncate text-muted-foreground">{s.preview}</span></li>)}
            {x.absences.map((a) => <li key={a.id} className="flex items-baseline gap-2"><span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] uppercase text-warning">{t(`absence_${a.kind}`)}</span><span className="font-medium">{t('absenceTurns', { turns: a.turns.join(', ') })}</span><span className="truncate text-muted-foreground">{a.preview}</span></li>)}
          </ul>
          {x.untestable.length > 0 && <ul className="list-disc pl-4 text-muted-foreground">{x.untestable.map((u, i) => <li key={i}>{untestableText(t, u)}</li>)}</ul>}
        </div>
      )}
    </div>
  );
}

/** The hypotheses the person brings to a turn's diagnosis — the plan counts them, so they live above it. */
export interface Hypotheses {
  wmOn: boolean; setWmOn: (v: boolean) => void; wm: string; setWm: (v: string) => void;
  overridesText: string; setOverridesText: (v: string) => void; parsedOverrides: ReturnType<typeof overridesOf>; overrideTools: string[];
  suggest: boolean; setSuggest: (v: boolean) => void; guess: boolean; setGuess: (v: boolean) => void; corrections: Record<string, string>; setCorrections: (v: Record<string, string>) => void;
}
/** A fresh set of hypotheses for each turn chosen (`turnId`). */
export function useHypotheses(turnId: string | undefined): Hypotheses {
  const [wmOn, setWmOn] = useState(false);
  const [wm, setWm] = useState('');
  const [overridesText, setOverridesText] = useState('');
  // A model proposes what the blamed parts should have said; the person's own corrections replace them.
  const [suggest, setSuggest] = useState(true);
  const [guess, setGuess] = useState(true);
  const [corrections, setCorrections] = useState<Record<string, string>>({});
  useEffect(() => { setCorrections({}); setSuggest(true); }, [turnId]);
  const parsedOverrides = useMemo(() => overridesOf(overridesText), [overridesText]);
  const overrideTools = 'overrides' in parsedOverrides ? [...new Set(parsedOverrides.overrides.map((o) => o.toolName))] : [];
  return { wmOn, setWmOn, wm, setWm, overridesText, setOverridesText, parsedOverrides, overrideTools, suggest, setSuggest, guess, setGuess, corrections, setCorrections };
}

/** A thread's turns as the Lab reads them, with the plan of each counting the hypotheses brought. */
export function useThreadTurns(q: { threadId: string | undefined; model: string; trials?: number; offset: number; h: Hypotheses }) {
  return useLabThreadPlan({ threadId: q.threadId, model: q.model, ...(q.trials !== undefined ? { trials: q.trials } : {}), offset: q.offset, workingMemory: q.h.wmOn, overrides: q.h.overrideTools, corrections: Object.keys(q.h.corrections), suggest: q.h.suggest, guess: q.h.guess });
}

/** The thread's turns on a timeline, folded away when the person only wants the turn; a page at a time. */
export function ThreadStrip({ plan, selectedId, onSelect, onPage }: { plan: NonNullable<ReturnType<typeof useLabThreadPlan>['data']>; selectedId: string | undefined; onSelect: (runId: string) => void; onPage: (offset: number) => void }) {
  const { t } = useTranslation('lab');
  return (
    <details open className="rounded-md border border-border bg-card p-3 text-xs" data-testid="thread-strip">
      <summary className="cursor-pointer font-medium">{t('stripTitle', { n: plan.total })}</summary>
      <div className="mt-2">
        <TimelineChart turns={plan.turns} {...(selectedId ? { selected: selectedId } : {})} onSelect={onSelect} />
        {(plan.offset > 0 || plan.nextOffset !== undefined) && (
          <div className="mt-2 flex items-center gap-2">
            <Btn variant="outline" size="xs" disabled={plan.offset === 0} onClick={() => onPage(Math.max(0, plan.offset - 50))}>{t('pagePrev')}</Btn>
            <span className="tabular-nums text-muted-foreground">{t('pageLine', { from: plan.offset + 1, to: plan.offset + plan.turns.length, total: plan.total })}</span>
            <Btn variant="outline" size="xs" disabled={plan.nextOffset === undefined} onClick={() => onPage(plan.nextOffset!)}>{t('pageNext')}</Btn>
          </div>
        )}
      </div>
    </details>
  );
}

/**
 * One turn of a thread proven against what a right answer does: its candidates, the hypotheses brought,
 * the plan read before anything is spent, then the diagnosis. `expect` is the page's, shared with the
 * capsule beside it.
 */
export function TurnDiagnosis({ turn, models, model, setModel, trials, setTrials, expect, h }: {
  turn: LabThreadTurn; models: string[]; model: string; setModel: (m: string) => void;
  trials: number | undefined; setTrials: (n: number | undefined) => void; expect: LabExpectation | undefined; h: Hypotheses;
}) {
  const { t } = useTranslation('lab');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<{ d: LabThreadDiagnosis; body: LabThreadBody } | undefined>();
  const job = useLabCall<LabThreadDiagnosis>('threadError');
  useEffect(() => { setResult(undefined); }, [turn.runId]);
  const p = turn.experiments?.plan;
  const canRun = turn.diagnosable && !!expect && 'overrides' in h.parsedOverrides && !job.busy;
  const run = async () => {
    if (!expect || !('overrides' in h.parsedOverrides)) return;
    const body: LabThreadBody = {
      runId: turn.runId, model, expect, ...(trials !== undefined ? { trials } : {}),
      ...(h.wmOn ? { workingMemory: h.wm } : {}), ...(h.parsedOverrides.overrides.length ? { overrides: h.parsedOverrides.overrides } : {}),
      ...(Object.keys(h.corrections).length ? { corrections: h.corrections } : {}), ...(h.suggest ? { suggest: true } : {}), ...(h.guess ? { guess: true } : {}),
    };
    const d = await job.call((onProgress, signal) => api.labThread(body, onProgress, signal));
    if (d) setResult({ d, body });
  };
  const textArea = 'w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none';
  const cost = p ? (p.estimatedCostUsd !== undefined ? `≈ ${formatUsd(p.estimatedCostUsd)}` : t('priceUnknown')) : '';
  return (
    <div className="space-y-3 text-xs" data-testid="turn-diagnosis">
      <div className="rounded-md border border-border bg-card p-3"><TurnPanel turn={turn} /></div>
      {turn.diagnosable && (
        <>
          <div className="space-y-2 rounded-md border border-border bg-card p-3">
            <h3 className="font-medium">{t('threadHypotheses')}</h3>
            {turn.experiments?.suspects.some((s) => s.kind === 'wm') && (
              <>
                <label className="flex items-center gap-2"><input type="checkbox" checked={h.wmOn} onChange={(e) => { h.setWmOn(e.target.checked); if (e.target.checked && !h.wm) h.setWm(turn.experiments!.suspects.find((s) => s.kind === 'wm')!.preview); }} /><span>{t('threadWm')}</span></label>
                {h.wmOn && <textarea aria-label={t('threadWm')} className={textArea} rows={3} value={h.wm} onChange={(e) => h.setWm(e.target.value)} />}
              </>
            )}
            <label className="flex flex-col gap-1">{t('threadOverrides')}
              <textarea aria-label={t('threadOverrides')} className={textArea} rows={2} placeholder='[{"toolName":"lookup","args":{},"output":{"address":"…"}}]' value={h.overridesText} onChange={(e) => h.setOverridesText(e.target.value)} />
            </label>
            {'error' in h.parsedOverrides && <p role="alert" className="text-destructive">{t('threadBadOverrides')}</p>}
            <label className="flex items-start gap-2" data-testid="thread-guess"><input type="checkbox" checked={h.guess} onChange={(e) => h.setGuess(e.target.checked)} /><span>{t('threadGuess')}</span></label>
            <label className="flex items-start gap-2" data-testid="thread-suggest"><input type="checkbox" checked={h.suggest} onChange={(e) => h.setSuggest(e.target.checked)} /><span>{t('threadSuggest')}</span></label>
            {Object.keys(h.corrections).length > 0 && (
              <p className="text-muted-foreground" data-testid="thread-corrections-pending">
                {t('threadCorrectionsPending', { parts: Object.keys(h.corrections).join('; ') })}{' '}
                <Btn variant="ghost" size="xs" onClick={() => h.setCorrections({})}>{t('reset')}</Btn>
              </p>
            )}
          </div>
          <div className="space-y-2 rounded-md border border-border bg-card p-3" data-testid="thread-planner">
            <h3 className="font-medium">{t('plannerTitle')}</h3>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-0.5">{t('modelLabel')}
                <select className={selectCls} value={model} onChange={(e) => setModel(e.target.value)}>{models.map((m) => <option key={m} value={m}>{m}</option>)}</select>
              </label>
              <label className="flex flex-col gap-0.5">{t('plannerTrials')}
                <input type="number" min={1} max={100} value={trials ?? p?.plannedTrials ?? ''} onChange={(e) => setTrials(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} className={cn(selectCls, 'w-20')} />
              </label>
              {trials !== undefined && <Btn variant="ghost" size="xs" onClick={() => setTrials(undefined)}>{t('plannerUsePlanned')}</Btn>}
              <Btn size="xs" busy={job.busy} disabled={!canRun || !p} onClick={() => setConfirmOpen(true)}>{t('threadRun')}</Btn>
            </div>
            {!expect && <p className="text-muted-foreground" data-testid="thread-needs-expect">{t('threadNeedsExpect')}</p>}
            {p && (
              <>
                <p className="tabular-nums" data-testid="thread-plan-line">{t('plannerLine', { arms: p.arms, n: p.trials, planned: p.plannedTrials, d: pct(p.targetDifference), alpha: p.alpha.toFixed(4), plays: p.totalPlays, tokens: p.tokens.toLocaleString(), cost })}</p>
                <p className="text-muted-foreground">{t('plannerStages', { elimination: p.eliminationPlays, verification: p.verificationPlays, joint: p.jointPlays })}</p>
                {p.undetermined !== undefined && <p className="text-muted-foreground" data-testid="thread-plan-worst">{t('plannerWorstCase', { u: pct(p.undetermined), d: pct(p.worstCaseDetectableDifference ?? p.detectableDifference), clean: pct(p.detectableDifference) })}</p>}
                {p.underpowered && <p role="status" className="rounded-md border border-warning/40 bg-warning/10 p-2 text-warning" data-testid="thread-underpowered">{t('plannerUnderpowered', { n: p.trials, d: pct(p.worstCaseDetectableDifference ?? p.detectableDifference) })}</p>}
              </>
            )}
          </div>
          <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen} title={t('threadTitle')}
            description={p ? `${confirmText(t, { plays: p.totalPlays, model, tokens: { n: p.tokens, most: true }, cost })} ${t('threadConfirmMemory')}` : ''} confirmLabel={t('threadRun')} onConfirm={() => void run()} />
          {job.busy && <Progress p={job.progress} unit="progressPlays" onStop={job.stop} />}
          {!job.busy && job.error && <JobError message={job.error} />}
          {result && result.d.runId === turn.runId && <ThreadResult d={result.d} request={result.body} onCorrect={(c) => { h.setCorrections(c); h.setSuggest(false); setConfirmOpen(true); }} />}
          <KeptExperiments kind="thread" target={turn.runId} />
        </>
      )}
    </div>
  );
}
