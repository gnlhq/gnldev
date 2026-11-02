import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Microscope } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, useCapabilities, useLabCatalog, useLabPlan, useLabScenarios, useLabFormPlan, useLabCapsuleBase, useLabExperiments, errMessage, isScopeRefused, ApiError, type LabExplanation, type LabPart, type LabPlan, type LabBestForm, type LabForm, type LabProgress, type LabCapsuleBase, type LabCapsule, type LabCapsuleBody, type LabTracedCall, type LabExperiment, type LabExpectation, type LabThreadDiagnosis, type LabSaveScenarioBody, type LabFormTool } from '../api';
import { Spinner, Empty, EmptyState, ErrorBox, Btn, cn, PageHeader, ScopeRefusedState } from '../components';
import { toast, ConfirmDialog } from '../ui';
import { formatUsd } from './Optimizer';
import { ThreadResult } from './lab-thread';
import { Improve } from './lab-improve';
import { Scenarios } from './lab-scenarios';
import { Playground } from './lab-playground';
import { NOISE_BAND, withinNoise } from './lab-charts';
import '../i18n';

// ── Pure logic (tested) ─────────────────────────────────────────────────────────────────────────────
/** A share with its sign, two decimals; "—" when there is no number (NaN arrives as null). */
export function formatSigned(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  // Rounded by magnitude: Math.round(-21.5) is -21, so a negative share would round towards zero.
  const r = Math.round(Math.abs(v) * 100) / 100;
  return `${r > 0 ? (v > 0 ? '+' : '−') : ''}${r.toFixed(2)}`;
}
/** Bar width for a share, as a percentage of the largest |share| (0 when nothing moved). */
export function barWidth(share: number, largest: number): number {
  return largest > 0 ? Math.round((Math.abs(share) / largest) * 100) : 0;
}
/** Below this, two runs of the same experiment moved a share (measured at 3 and 6 trials). */
export { NOISE_BAND, withinNoise };

/** A pass rate as a percentage, "—" when there is none. */
export function formatRate(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${Math.round(v * 100)}%`;
}
/** What a form costs, in money when priced, in tokens otherwise. */
export function formCost(f: Pick<LabForm, 'priced' | 'costUsd' | 'tokens'>, unpricedTokens: (n: string) => string): string {
  return f.priced ? formatUsd(f.costUsd) : unpricedTokens(Math.round(f.tokens).toLocaleString());
}
/** Forms whose 95% interval reaches the best form's: the data does not tell them apart from it. */
export function overlapping(best: Pick<LabForm, 'passRate' | 'components'>, forms: ReadonlyArray<Pick<LabForm, 'passRate' | 'components'>>): number {
  const low = best.passRate.low ?? 0;
  return forms.filter((f) => f.components.join() !== best.components.join() && (f.passRate.high ?? 1) >= low).length;
}
/** Every confirmation says the same things in the same order: how many plays, tokens, price, the provider, that nothing runs or changes. */
export function confirmText(t: (k: string, o?: Record<string, unknown>) => string, o: { plays: number; model: string; tokens?: { n: number; most?: boolean }; cost: string }): string {
  const tokens = o.tokens ? t(o.tokens.most ? 'confirmTokensMost' : 'confirmTokensAbout', { n: Math.round(o.tokens.n).toLocaleString() }) : t('confirmTokensUnknown');
  return t('confirmPlays', { plays: o.plays, model: o.model, tokens, cost: o.cost });
}
/** A difference in points, signed: +50, −20. */
const points = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v * 100))}`);
/** What an explanation's replays are expected to take in all (an older server: replays × the recorded run). */
export function planTokens(p: Pick<LabPlan, 'replays' | 'tokensPerReplay' | 'estimatedTokens'>): number {
  return p.estimatedTokens ?? p.replays * p.tokensPerReplay;
}
/** Plays a capsule request takes: its trials, and as many of the run unchanged when it changes anything (as the server does). */
export function playsOf(body: LabCapsuleBody): number {
  const changes = body.system !== undefined || body.tools !== undefined || body.history === false || body.memory === false || !!body.overrides?.length;
  return (body.trials ?? 3) * (changes ? 2 : 1);
}
/** The scenarios ticked by default: the first six — every form runs each, so the bill grows with them. */
export const DEFAULT_SCENARIOS = 6;

// ── Capsule (pure, tested) ──────────────────────────────────────────────────────────────────────────
/** A tool in the capsule as the page edits it. */
export interface CapsuleToolRow { name: string; description: string; keep: boolean; added: boolean; parameters?: unknown; recordedOnly?: true }
/** What the person typed for a call the recording never made: the call, and the tool's result as JSON text. */
export interface CapsuleAnswerDraft { toolName: string; args: unknown; text: string }

/** A call as one line: `refund({"orderId":"42"})`. */
export function callLabel(c: { toolName: string; args: unknown }): string {
  return `${c.toolName}(${c.args === undefined ? '' : JSON.stringify(c.args)})`;
}
/** The key an answer is kept under in the page: the tool and its arguments, key order aside. */
export function answerKey(c: { toolName: string; args: unknown }): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)])) : v;
  return `${c.toolName}:${JSON.stringify(sort(c.args))}`;
}
/**
 * The play request: only what changed is sent (the server keeps the run's own prompt, tools and history
 * otherwise), and every answer typed. An answer that is not JSON is the person's to fix, named.
 */
export function capsuleBody(
  base: Pick<LabCapsuleBase, 'runId' | 'system' | 'tools'>,
  edits: { model: string; trials: number; system: string; tools: CapsuleToolRow[]; history: boolean; memory?: boolean; expect?: LabExpectation },
  answers: Record<string, CapsuleAnswerDraft>,
): { body: LabCapsuleBody } | { error: string } {
  const body: LabCapsuleBody = { runId: base.runId, model: edits.model, trials: edits.trials };
  if (edits.system !== base.system) body.system = edits.system;
  const own = new Map(base.tools.map((t) => [t.name, t.description]));
  if (edits.tools.some((t) => !t.keep || t.added || own.get(t.name) !== t.description)) {
    body.tools = edits.tools.filter((t) => t.keep).map((t) => ({ name: t.name, description: t.description, ...(t.added ? { parameters: t.parameters } : {}) }));
  }
  if (!edits.history) body.history = false;
  if (edits.memory === false) body.memory = false;
  if (edits.expect) body.expect = edits.expect;
  const typed = Object.values(answers).filter((a) => a.text.trim() !== '');
  const parsed: NonNullable<LabCapsuleBody['answers']> = [];
  for (const a of typed) {
    try { parsed.push({ toolName: a.toolName, args: a.args, output: JSON.parse(a.text) }); }
    catch { return { error: callLabel(a) }; }
  }
  if (parsed.length) body.answers = parsed;
  return { body };
}

/** What the person typed for "what a right answer does", one field per kind. */
export interface ExpectDraft { calls: string; forbidden: string; answer: string }
/**
 * The draft as an expectation: a call per line (a tool name, optionally its arguments as a JSON object),
 * forbidden tools comma-separated, an answer text per line (alternatives split by `|`). Nothing typed is
 * no expectation; a line whose arguments are not a JSON object is the person's to fix, named.
 */
export function expectationOf(d: ExpectDraft): { expect?: LabExpectation } | { badLine: string } {
  const lines = (x: string) => x.split('\n').map((l) => l.trim()).filter(Boolean);
  const calls: NonNullable<LabExpectation['calls']> = [];
  for (const line of lines(d.calls)) {
    const at = line.search(/[\s{]/);
    const toolName = at < 0 ? line : line.slice(0, at);
    const rest = at < 0 ? '' : line.slice(at).trim();
    if (!rest) { calls.push({ toolName }); continue; }
    try {
      const args = JSON.parse(rest);
      if (typeof args !== 'object' || args === null || Array.isArray(args)) return { badLine: line };
      calls.push({ toolName, args });
    } catch { return { badLine: line }; }
  }
  const forbidden = d.forbidden.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  const answerIncludes = lines(d.answer).map((l) => { const alts = l.split('|').map((x) => x.trim()).filter(Boolean); return alts.length === 1 ? alts[0]! : alts; });
  const expect: LabExpectation = { ...(calls.length ? { calls } : {}), ...(forbidden.length ? { forbidden } : {}), ...(answerIncludes.length ? { answerIncludes } : {}) };
  return Object.keys(expect).length ? { expect } : {};
}

/** An expectation as the page writes it — expectationOf's inverse: a call a line, forbidden tools by comma, an answer's spellings by '|'. */
export function draftOf(e: LabExpectation): ExpectDraft {
  return {
    calls: (e.calls ?? []).map((c) => (c.args === undefined ? c.toolName : `${c.toolName} ${JSON.stringify(c.args)}`)).join('\n'),
    forbidden: (e.forbidden ?? []).join(', '),
    answer: (e.answerIncludes ?? []).map((a) => (Array.isArray(a) ? a.join(' | ') : a)).join('\n'),
  };
}

/** What a right answer does, written once for the page: the capsule and the diagnosis both read it. */
export function ExpectBox({ draft, onChange, help }: { draft: ExpectDraft; onChange: (d: ExpectDraft) => void; help?: string }) {
  const { t } = useTranslation('lab');
  const want = expectationOf(draft);
  const textArea = 'w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none';
  return (
    <div className="space-y-2 rounded-md border border-border bg-card p-3 text-xs" data-testid="capsule-expect">
      <h3 className="font-medium">{t('capsuleExpect')}</h3>
      {help && <p className="text-muted-foreground">{help}</p>}
      <textarea aria-label={t('capsuleExpectCalls')} placeholder={t('capsuleExpectCalls')} className={textArea} rows={2} value={draft.calls} onChange={(e) => onChange({ ...draft, calls: e.target.value })} />
      <input aria-label={t('capsuleExpectForbidden')} placeholder={t('capsuleExpectForbidden')} className={textArea} value={draft.forbidden} onChange={(e) => onChange({ ...draft, forbidden: e.target.value })} />
      <textarea aria-label={t('capsuleExpectAnswer')} placeholder={t('capsuleExpectAnswer')} className={textArea} rows={2} value={draft.answer} onChange={(e) => onChange({ ...draft, answer: e.target.value })} />
      {'badLine' in want && <p role="alert" className="text-destructive">{t('capsuleBadExpect', { line: want.badLine })}</p>}
    </div>
  );
}

/** Half or more of at least four finished jobs failed: worth saying before the rest is spent. */
export function mostlyFailing(p: Pick<LabProgress, 'done' | 'failed'>): boolean {
  return p.done >= 4 && p.failed * 2 >= p.done;
}

/**
 * A long lab call: progress as it comes, the stop button, and what to say when it ends. `start` is handed
 * the progress setter and the abort signal; a stopped call is reported as stopped, not as an error.
 */
export function useLabCall<T>(errorKey: 'explainError' | 'formError' | 'capsuleError' | 'threadError' | 'scenariosError' | 'measureError' | 'wordsError' | 'pruneError') {
  const { t } = useTranslation('lab');
  const [progress, setProgress] = useState<LabProgress | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const qc = useQueryClient();
  const stop = useRef<AbortController | undefined>();
  useEffect(() => () => stop.current?.abort(), []);
  const call = async (start: (onProgress: (p: LabProgress) => void, signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
    const c = new AbortController();
    stop.current = c;
    setBusy(true); setProgress(undefined); setError(undefined);
    let last: LabProgress | undefined;
    // A retry notice stays until a job ends: the next event of the same job would otherwise wipe it.
    const onProgress = (p: LabProgress) => { last = p; setProgress((prev) => (p.retrying || !prev || prev.done !== p.done ? p : { ...p, ...(prev.retrying ? { retrying: prev.retrying } : {}) })); };
    try { const r = await start(onProgress, c.signal); void qc.invalidateQueries({ queryKey: ['lab-experiments'] }); return r; }
    catch (e) {
      if (c.signal.aborted) toast.info(t('stopped', { done: last?.done ?? 0, total: last?.total ?? 0 }));
      else { const m = t(errorKey, { error: errMessage(e) }); setError(m); toast.error(m); }
      return undefined;
    } finally { setBusy(false); stop.current = undefined; }
  };
  return { busy, progress, error, call, stop: () => stop.current?.abort() };
}

/** m:ss since `from`, ticking every second. */
function useElapsed(): string {
  const [from] = useState(() => Date.now());
  const [now, setNow] = useState(from);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const s = Math.floor((now - from) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function Progress({ p, unit, onStop }: { p: LabProgress | undefined; unit: 'progressReplays' | 'progressForms' | 'progressPlays' | 'progressSubsets'; onStop: () => void }) {
  const { t } = useTranslation('lab');
  const elapsed = useElapsed();
  const pct = p && p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  return (
    <div className="mt-3 space-y-1.5 text-xs" data-testid="lab-progress" role="status">
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 rounded bg-muted"><div className="h-1.5 rounded bg-primary transition-all" style={{ width: `${pct}%` }} /></div>
        <Btn variant="outline" size="xs" onClick={onStop}>{t('stop')}</Btn>
      </div>
      <p className="tabular-nums text-muted-foreground">
        {p ? t(unit, { done: p.done, total: p.total }) : t('progressStarting')}
        {p?.running ? ` · ${t('progressRunning', { n: p.running })}` : ''} · {elapsed}
      </p>
      {p?.retrying && (
        <p className="text-warning" data-testid="lab-retrying">
          {t('progressRetrying', { reason: p.retrying.reason, attempt: p.retrying.attempt, seconds: Math.round(p.retrying.waitMs / 100) / 10 })}
        </p>
      )}
      {p?.throttled && (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-warning" data-testid="lab-throttled">
          {t('throttled', { seconds: Math.round(p.throttled.waitMs / 1000), attempt: p.throttled.attempt, max: p.throttled.maxWaits })}
        </p>
      )}
      {p && p.failed > 0 && <p className="text-warning">{t('progressFailed', { failed: p.failed, error: p.lastError ?? '' })}</p>}
      {p && mostlyFailing(p) && <p role="alert" className="rounded-md border border-warning/40 bg-warning/10 p-2 text-warning">{t('progressMostlyFailing')}</p>}
    </div>
  );
}

/** Why the last call ended without a result — stays on the screen, unlike the toast. */
/** Why a run's memory layout is not known, in the reader's language when the code is one we know; the server's words otherwise. */
export function layoutReasonText(t: (k: string, o?: Record<string, unknown>) => string, layout: { reason: string; detail: string }): string {
  const key = `layoutReason_${layout.reason}`;
  const said = t(key);
  return said === key ? layout.detail : said;
}

export function JobError({ message }: { message: string }) {
  return <div role="alert" data-testid="lab-error" className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">{message}</div>;
}

/**
 * Why the Lab will not take this run, in the reader's language when the server named the reason (a run
 * of an agent the host did not give the lab: a scheduler or workflow run, or an agent left out); the
 * server's own message otherwise.
 */
export function LabRefused({ error }: { error: unknown }) {
  const { t } = useTranslation('lab');
  if (error instanceof ApiError && error.code === 'agent-not-offered') {
    const agent = typeof error.body?.agent === 'string' ? error.body.agent : undefined;
    return <div role="alert" data-testid="lab-refused" className="mt-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">{agent ? t('refusedAgentNotOffered', { agent }) : t('refusedNoAgent')}</div>;
  }
  return <ErrorBox error={error} />;
}

export const selectCls = 'rounded-md border border-input bg-background px-2 py-1 text-xs outline-none';

function PartBadge({ kind }: { kind: LabPart['kind'] }) {
  const { t } = useTranslation('lab');
  return <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{t(`kind_${kind}`)}</span>;
}

function Result({ r, planned }: { r: LabExplanation; planned?: number }) {
  const { t } = useTranslation('lab');
  const largest = Math.max(0, ...r.shares.map((s) => Math.abs(s.share)));
  const detail = new Map(r.partsDetail.map((p) => [p.id, p]));
  return (
    <section className="mt-4 space-y-3" data-testid="lab-result" aria-labelledby="lab-result-title">
      <h2 id="lab-result-title" className="text-sm font-medium">{t('resultTitle', { calls: r.recordedCalls.map((c) => c.toolName).join(' → ') || t('noCalls') })}</h2>
      {!r.representative.ok && (
        <div role="alert" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
          {t('notRepresentative', { pct: Math.round(r.representative.value * 100), n: r.representative.n })}
        </div>
      )}
      {!r.dependsOnParts && (
        <div role="status" className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">{t('independent')}</div>
      )}
      <ul className="space-y-2">
        {r.shares.map((s) => {
          const p = detail.get(s.part);
          const noisy = withinNoise(s.share, s.noise);
          return (
            <li key={s.part} className="rounded-md border border-border bg-card p-3 text-xs" data-testid="lab-share">
              <div className="flex flex-wrap items-center gap-2">
                {p && <PartBadge kind={p.kind} />}
                <span className="font-medium">{s.part}</span>
                <span className={cn('ml-auto tabular-nums font-semibold', s.share > 0 ? 'text-success' : s.share < 0 ? 'text-destructive' : 'text-muted-foreground')}>{formatSigned(s.share)}</span>
                <span className="tabular-nums text-muted-foreground">± {formatSigned(s.noise).replace('+', '')}</span>
                {noisy && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{t('noise')}</span>}
              </div>
              <div className="mt-1.5 h-1.5 w-full rounded bg-muted">
                <div className={cn('h-1.5 rounded', s.share >= 0 ? 'bg-success' : 'bg-destructive')} style={{ width: `${barWidth(s.share, largest)}%` }} />
              </div>
              {p && <p className="mt-1.5 text-muted-foreground">{p.preview}</p>}
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-muted-foreground">{t('noiseNote')}</p>
      <p className="text-[11px] tabular-nums text-muted-foreground">
        {t('footer', { replays: r.replays, failed: r.failed, model: r.model, tokens: (r.inputTokens + r.outputTokens).toLocaleString() })}
        {' · '}{r.priced ? formatUsd(r.costUsd) : t('unpriced')}
        {planned !== undefined && <>{' · '}{t('spentOfPlan', { tokens: Math.round(planned).toLocaleString() })}</>}
      </p>
    </section>
  );
}

export function Explain({ runId, models }: { runId: string; models: string[] }) {
  const { t } = useTranslation('lab');
  const [model, setModel] = useState(models[0] ?? '');
  const [trials, setTrials] = useState(3);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<{ r: LabExplanation; planned?: number } | undefined>();
  useEffect(() => setResult(undefined), [runId]);
  const plan = useLabPlan(runId, model, trials);
  const job = useLabCall<LabExplanation>('explainError');
  const busy = job.busy;

  const run = async () => {
    const planned = plan.data && planTokens(plan.data);
    const r = await job.call((onProgress, signal) => api.labExplain({ runId, model, trials }, onProgress, signal));
    if (r) setResult({ r, ...(planned !== undefined ? { planned } : {}) });
  };
  const p = plan.data;
  const cost = p ? (p.estimatedCostUsd !== undefined ? `≈ ${formatUsd(p.estimatedCostUsd)}` : t('priceUnknown')) : '';
  return (
    <section className="mt-4 rounded-md border border-border bg-card p-3" aria-labelledby="lab-explain">
      <h2 id="lab-explain" className="text-sm font-medium">{t('explainTitle')}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t('explainHelp')}</p>
      <div className="mt-3 flex flex-wrap items-end gap-3 text-xs">
        <label className="flex flex-col gap-0.5">{t('modelLabel')}
          <select className={selectCls} value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">{t('trialsLabel')}
          <input type="number" min={1} max={10} value={trials} onChange={(e) => setTrials(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} className={cn(selectCls, 'w-20')} />
        </label>
        <Btn size="xs" busy={busy} disabled={!p || busy} onClick={() => setConfirmOpen(true)}>{busy ? t('explaining') : t('explainButton')}</Btn>
      </div>
      {plan.isLoading && <Spinner />}
      {plan.error && <LabRefused error={plan.error} />}
      {p && (
        <div className="mt-3" data-testid="lab-plan">
          <p className="text-xs tabular-nums">{t('planLine', { parts: p.parts.length, replays: p.replays, tokens: Math.round(planTokens(p)).toLocaleString(), cost })}</p>
          <ul className="mt-2 space-y-1 text-xs">
            {p.parts.map((x) => <li key={x.id} className="flex items-baseline gap-2"><PartBadge kind={x.kind} /><span className="font-medium">{x.id}</span><span className="truncate text-muted-foreground">{x.preview}</span></li>)}
          </ul>
        </div>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('explainTitle')}
        description={p ? confirmText(t, { plays: p.replays, model, tokens: { n: planTokens(p) }, cost }) : ''}
        confirmLabel={t('explainButton')}
        onConfirm={() => void run()}
      />
      {busy && <Progress p={job.progress} unit="progressReplays" onStop={job.stop} />}
      {!busy && job.error && <JobError message={job.error} />}
      {result && <Result r={result.r} {...(result.planned !== undefined ? { planned: result.planned } : {})} />}
      <KeptExperiments kind="explain" target={runId} />
    </section>
  );
}

function FormsResult({ r }: { r: LabBestForm }) {
  const { t } = useTranslation('lab');
  const name = (f: LabForm) => (f.components.length ? f.components.join(' + ') : t('noComponents'));
  const tokens = (n: string) => t('tokens', { n });
  const shares = Object.entries(r.shares).sort((a, b) => b[1] - a[1]);
  const largest = Math.max(0, ...shares.map(([, v]) => Math.abs(v)));
  const detail = new Map(r.componentsDetail.map((p) => [p.id, p]));
  return (
    <section className="mt-4 space-y-3" data-testid="form-result">
      {r.best ? (
        <div className="rounded-md border border-success/40 bg-success/10 p-3 text-xs" data-testid="best-form">
          <div className="font-medium">{t('bestForm', { form: name(r.best) })}</div>
          <div className="mt-1 tabular-nums text-muted-foreground">{t('bestLine', { rate: formatRate(r.best.passRate.value), low: formatRate(r.best.passRate.low), high: formatRate(r.best.passRate.high), cost: formCost(r.best, tokens) })}</div>
          <div className="mt-1 text-muted-foreground">{t('bestNote')}</div>
        </div>
      ) : (
        <div role="status" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning" data-testid="no-best-form">
          <div className="font-medium">{t('noBestForm')}</div>
          <div className="mt-1">{t('noBestFormNote')}</div>
        </div>
      )}
      {r.best && overlapping(r.best, r.forms) > 0 && (
        <div role="status" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning" data-testid="forms-overlap">
          {t('overlap', { count: overlapping(r.best!, r.forms), total: r.forms.length - 1 })}
        </div>
      )}
      <h3 className="text-xs font-medium">{t('sharesTitle')}</h3>
      <ul className="space-y-2">
        {shares.map(([id, v]) => (
          <li key={id} className="rounded-md border border-border bg-card p-3 text-xs" data-testid="form-share">
            <div className="flex items-center gap-2">
              <span className="font-medium">{id}</span>
              <span className={cn('ml-auto tabular-nums font-semibold', v > 0 ? 'text-success' : v < 0 ? 'text-destructive' : 'text-muted-foreground')}>{formatSigned(v)}</span>
            </div>
            <div className="mt-1.5 h-1.5 w-full rounded bg-muted"><div className={cn('h-1.5 rounded', v >= 0 ? 'bg-success' : 'bg-destructive')} style={{ width: `${barWidth(v, largest)}%` }} /></div>
            {detail.get(id) && <p className="mt-1.5 text-muted-foreground">{detail.get(id)!.preview}</p>}
          </li>
        ))}
      </ul>
      <h3 className="text-xs font-medium">{t('formsTitle')}</h3>
      <table className="w-full text-left text-xs tabular-nums">
        <thead className="text-muted-foreground"><tr><th className="py-1 font-normal">{t('form')}</th><th className="font-normal">{t('passRate')}</th><th className="font-normal">{t('interval')}</th><th className="font-normal">{t('cost')}</th></tr></thead>
        <tbody>
          {r.forms.map((f) => (
            <tr key={name(f)} className={cn('border-t border-border', r.best && (f === r.best || name(f) === name(r.best)) ? 'bg-success/10 font-medium' : '')}>
              <td className="py-1">{name(f)}</td><td>{formatRate(f.passRate.value)}</td><td>{formatRate(f.passRate.low)}–{formatRate(f.passRate.high)}</td><td>{formCost(f, tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-muted-foreground">{t('formsFooter', { scenarios: r.scenarios.length, model: r.model })}</p>
    </section>
  );
}

export function NewAgent({ agent, models }: { agent: string; models: string[] }) {
  const { t } = useTranslation('lab');
  const [model, setModel] = useState(models[0] ?? '');
  const [trials, setTrials] = useState(2);
  const [picked, setPicked] = useState<string[] | undefined>();
  const [without, setWithout] = useState<string[]>([]);
  const [added, setAdded] = useState<LabFormTool[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<LabBestForm | undefined>();
  const sc = useLabScenarios(agent);
  useEffect(() => { setPicked(undefined); setWithout([]); setAdded([]); setResult(undefined); }, [agent]);
  const all = sc.data?.items ?? [];
  const chosen = picked ?? all.slice(0, DEFAULT_SCENARIOS).map((s) => s.id);
  const tools = { ...(without.length ? { withoutTools: without } : {}), ...(added.length ? { addTools: added } : {}) };
  const plan = useLabFormPlan(agent, trials, chosen, tools);
  const toggle = (id: string) => setPicked(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
  const job = useLabCall<LabBestForm>('formError');
  const busy = job.busy;
  const run = async () => {
    const r = await job.call((onProgress, signal) => api.labBestForm({ agent, model, trials, scenarios: chosen, ...tools }, onProgress, signal));
    if (r) setResult(r);
  };
  const p = plan.data;
  return (
    <section className="mt-4 rounded-md border border-border bg-card p-3" aria-labelledby="lab-form">
      <h2 id="lab-form" className="text-sm font-medium">{t('formTitle')}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t('formHelp')}</p>
      <div className="mt-3 flex flex-wrap items-end gap-3 text-xs">
        <label className="flex flex-col gap-0.5">{t('modelLabel')}
          <select className={selectCls} value={model} onChange={(e) => setModel(e.target.value)}>{models.map((m) => <option key={m} value={m}>{m}</option>)}</select>
        </label>
        <label className="flex flex-col gap-0.5">{t('formTrialsLabel')}
          <input type="number" min={1} max={5} value={trials} onChange={(e) => setTrials(Math.max(1, Math.min(5, Number(e.target.value) || 1)))} className={cn(selectCls, 'w-20')} />
        </label>
        <Btn size="xs" busy={busy} disabled={!p || busy} onClick={() => setConfirmOpen(true)}>{busy ? t('forming') : t('formButton')}</Btn>
      </div>
      {plan.error && <LabRefused error={plan.error} />}
      {p && (
        <div className="mt-3" data-testid="form-plan">
          <p className="text-xs tabular-nums">{t('formPlanLine', { components: p.components.length, forms: p.forms, scenarios: p.scenarios, runs: p.runs })}</p>
          <ul className="mt-2 space-y-1 text-xs">
            {p.components.map((x) => <li key={x.id} className="flex items-baseline gap-2"><PartBadge kind={x.kind} /><span className="font-medium">{x.id}</span><span className="truncate text-muted-foreground">{x.preview}</span></li>)}
          </ul>
        </div>
      )}
      <FormTools offered={p?.tools ?? []} without={without} setWithout={setWithout} added={added} setAdded={setAdded} />
      <details className="mt-3 text-xs" open={false}>
        <summary className="cursor-pointer text-muted-foreground">{t('scenariosTitle', { chosen: chosen.length, all: all.length })}</summary>
        <ul className="mt-2 grid gap-1 sm:grid-cols-2">
          {all.map((x) => (
            <li key={x.id}><label className="flex items-start gap-2"><input type="checkbox" checked={chosen.includes(x.id)} onChange={() => toggle(x.id)} /><span><span className="font-mono">{x.id}</span> <span className="text-muted-foreground">{x.prompt}</span></span></label></li>
          ))}
        </ul>
      </details>
      <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen} title={t('formTitle')} description={p ? `${confirmText(t, { plays: p.runs, model, cost: t('costNotEstimated') })} ${t('confirmFakeTools')}` : ''} confirmLabel={t('formButton')} onConfirm={() => void run()} />
      {busy && <Progress p={job.progress} unit="progressForms" onStop={job.stop} />}
      {!busy && job.error && <JobError message={job.error} />}
      {result && <FormsResult r={result} />}
      <KeptExperiments kind="best-form" target={agent} />
    </section>
  );
}

/** A tool written on the page as a draft: its JSON fields still text. */
interface FormToolDraft { name: string; description: string; parameters: string; output: string }
/** A drafted tool, checked: a name a provider takes, its parameters an object schema, its answer JSON. */
export function formToolOf(d: FormToolDraft, taken: readonly string[]): { tool: LabFormTool } | { error: 'name' | 'taken' | 'parameters' | 'output' } {
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(d.name)) return { error: 'name' };
  if (taken.includes(d.name)) return { error: 'taken' };
  let parameters: unknown, output: unknown;
  try { parameters = JSON.parse(d.parameters || '{"type":"object"}'); } catch { return { error: 'parameters' }; }
  if (typeof parameters !== 'object' || parameters === null || (parameters as { type?: unknown }).type !== 'object') return { error: 'parameters' };
  try { output = JSON.parse(d.output || 'null'); } catch { return { error: 'output' }; }
  return { tool: { name: d.name, description: d.description, parameters: parameters as Record<string, unknown>, output } };
}

/** The tools a best-form search takes away (each the scenarios offer) or adds (written here), each a component. */
function FormTools({ offered, without, setWithout, added, setAdded }: { offered: string[]; without: string[]; setWithout: (x: string[]) => void; added: LabFormTool[]; setAdded: (x: LabFormTool[]) => void }) {
  const { t } = useTranslation('lab');
  const empty: FormToolDraft = { name: '', description: '', parameters: '{"type":"object","properties":{}}', output: '{"ok":true}' };
  const [draft, setDraft] = useState<FormToolDraft>(empty);
  const [error, setError] = useState<string | undefined>();
  const add = () => {
    const r = formToolOf(draft, [...offered, ...added.map((x) => x.name)]);
    if ('error' in r) { setError(t(`formToolBad_${r.error}`)); return; }
    setAdded([...added, r.tool]); setDraft(empty); setError(undefined);
  };
  return (
    <details className="mt-3 text-xs" data-testid="form-tools">
      <summary className="cursor-pointer text-muted-foreground">{t('formToolsTitle', { without: without.length, added: added.length })}</summary>
      <p className="mt-2 text-muted-foreground">{t('formToolsHelp')}</p>
      {offered.length > 0 && (
        <div className="mt-2">
          <p className="font-medium">{t('formToolsWithout')}</p>
          <ul className="mt-1 grid gap-1 sm:grid-cols-3">
            {offered.map((name) => (
              <li key={name}><label className="flex items-center gap-2"><input type="checkbox" checked={without.includes(name)} onChange={() => setWithout(without.includes(name) ? without.filter((x) => x !== name) : [...without, name])} data-testid="form-without" /><span className="font-mono">{name}</span></label></li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-3 space-y-1">
        <p className="font-medium">{t('formToolsAdd')}</p>
        {added.map((x) => (
          <div key={x.name} className="flex items-center gap-2" data-testid="form-added">
            <span className="font-mono">{x.name}</span><span className="truncate text-muted-foreground">{x.description}</span>
            <Btn variant="ghost" size="xs" onClick={() => setAdded(added.filter((y) => y.name !== x.name))}>{t('savedRemove')}</Btn>
          </div>
        ))}
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-0.5">{t('formToolName')}<input className={selectCls} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} data-testid="form-tool-name" /></label>
          <label className="flex flex-col gap-0.5">{t('formToolDescription')}<input className={selectCls} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
          <label className="flex flex-col gap-0.5">{t('formToolParameters')}<textarea className={cn(selectCls, 'min-h-[50px] font-mono')} value={draft.parameters} onChange={(e) => setDraft({ ...draft, parameters: e.target.value })} /></label>
          <label className="flex flex-col gap-0.5">{t('formToolOutput')}<textarea className={cn(selectCls, 'min-h-[50px] font-mono')} value={draft.output} onChange={(e) => setDraft({ ...draft, output: e.target.value })} /></label>
        </div>
        {error && <p role="alert" className="text-destructive">{error}</p>}
        <Btn variant="outline" size="xs" disabled={!draft.name.trim()} onClick={add}>{t('formToolAddButton')}</Btn>
      </div>
    </details>
  );
}

function SourceBadge({ source }: { source: LabTracedCall['source'] }) {
  const { t } = useTranslation('lab');
  const tone = source === 'recorded' ? 'bg-muted text-muted-foreground' : source === 'answer' ? 'bg-info/15 text-info' : 'bg-destructive/15 text-destructive';
  return <span className={cn('rounded px-1.5 py-0.5 text-[10px]', tone)}>{t(`source_${source}`)}</span>;
}

/** The change beside the run as it was: both counts, the difference with its interval, and whether it is more than chance. */
function CapsuleCompare({ r }: { r: LabCapsule }) {
  const { t } = useTranslation('lab');
  const u = r.unchanged, d = r.difference;
  if (!u || !d) return null;
  const ran = (paths: LabCapsule['paths']) => paths.reduce((n, p) => n + p.count, 0);
  const passes = (paths: LabCapsule['paths']) => paths.reduce((n, p) => n + (p.passed ?? 0), 0);
  const same = (paths: LabCapsule['paths']) => paths.filter((p) => p.sameAsRecorded).reduce((n, p) => n + p.count, 0);
  const expected = d.of === 'expected';
  const line = t(expected ? 'capsuleCompare' : 'capsuleCompareSame', {
    base: expected ? passes(u.paths) : same(u.paths), baseN: ran(u.paths),
    changed: expected ? passes(r.paths) : same(r.paths), changedN: ran(r.paths),
  });
  const { low, high } = d.interval;
  const known = low !== null && high !== null && Number.isFinite(low) && Number.isFinite(high);
  const noise = !known || (low! <= 0 && high! >= 0);
  // Green and red only for right answers; without `expect` a difference says the calls moved, not that it got better.
  const tone = noise ? 'border-border bg-muted/40' : !expected ? 'border-info/40 bg-info/10' : low! > 0 ? 'border-success/40 bg-success/10' : 'border-destructive/40 bg-destructive/10';
  const undetermined = (r.expected?.undetermined ?? 0) + (u.expected?.undetermined ?? 0);
  return (
    <div role="status" className={cn('rounded-md border p-3', tone)} data-testid="capsule-compare">
      <p className="text-sm font-medium tabular-nums">{line}</p>
      <p className="mt-1 tabular-nums">{t('capsuleDiff', { d: points(d.interval.value), low: points(low), high: points(high) })}</p>
      <p className="mt-1 font-medium" data-testid="capsule-compare-verdict">{t(noise ? 'capsuleDiffNoise' : !expected ? 'capsuleDiffMoved' : low! > 0 ? 'capsuleDiffHelped' : 'capsuleDiffHurt')}</p>
      {expected && undetermined > 0 && <p className="mt-1 text-muted-foreground">{t('capsuleDiffWorst')}</p>}
      {u.failed > 0 && <p className="mt-1 text-muted-foreground">{t('capsuleUnchangedFailed', { failed: u.failed })}</p>}
    </div>
  );
}

function CapsuleResult({ r, planned }: { r: LabCapsule; planned?: number }) {
  const { t } = useTranslation('lab');
  return (
    <section className="mt-4 space-y-3 text-xs" data-testid="capsule-result">
      <CapsuleCompare r={r} />
      <p className="font-medium" data-testid="capsule-same">{t('capsuleSame', { same: Math.round(r.sameAsRecorded.value * r.sameAsRecorded.n), n: r.sameAsRecorded.n })}</p>
      {r.expected && (
        <p className="font-medium" data-testid="capsule-expected">
          {(() => {
            // One denominator, the plays that ran; with plays undetermined, the range first and the judged-only rate after it, named.
            const e = r.expected!, judged = e.passRate.n, pass = Math.round((e.passRate.value ?? 0) * judged), ran = judged + e.undetermined;
            if (e.undetermined === 0) return t('capsuleExpected', { pass, n: ran });
            return (
              <>
                <span data-testid="capsule-expected-bounds">{t('capsuleExpectedRange', { low: pass, high: pass + e.undetermined, n: ran, lowPct: formatRate(e.bounds?.low.value ?? pass / ran), highPct: formatRate(e.bounds?.high.value ?? (pass + e.undetermined) / ran), count: e.undetermined })}</span>
                <span className="block font-normal text-muted-foreground">{t('capsuleExpectedJudgedOnly', { pass, judged, pct: formatRate(e.passRate.value) })}</span>
              </>
            );
          })()}
        </p>
      )}
      {(r.notes ?? []).length > 0 && <ul className="list-disc pl-4 text-muted-foreground" data-testid="capsule-notes">{r.notes!.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-md border border-border bg-muted/30 p-3">
          <h3 className="font-medium">{t('capsuleRecorded')}</h3>
          <ol className="mt-1 list-decimal space-y-0.5 pl-4 font-mono">{r.recorded.calls.map((c, i) => <li key={i}>{callLabel(c)}</li>)}</ol>
          {r.recorded.text && <p className="mt-2 text-muted-foreground">“{r.recorded.text}”</p>}
        </div>
        <div className="space-y-2">
          {r.paths.map((p, i) => (
            <div key={i} className={cn('rounded-md border p-3', p.sameAsRecorded ? 'border-border bg-card' : 'border-primary/40 bg-primary/5')} data-testid="capsule-path">
              <h3 className="font-medium">{t('capsulePath', { count: p.count, n: r.trials - r.failed })}</h3>
              {p.calls.length === 0 ? <p className="mt-1 text-muted-foreground">{t('noCalls')}</p> : (
                <ol className="mt-1 list-decimal space-y-0.5 pl-4">{p.calls.map((c, j) => <li key={j}><span className="font-mono">{callLabel(c)}</span> <SourceBadge source={c.source} /></li>)}</ol>
              )}
              {p.text && <p className="mt-2 text-muted-foreground">“{p.text}”</p>}
              {p.passed !== undefined && <p className="mt-1">{t('capsulePathPassed', { passed: p.passed, count: p.count })}</p>}
              {p.failures && p.failures.length > 0 && <ul className="mt-1 list-disc pl-4 text-destructive">{p.failures.map((f, j) => <li key={j}>{f}</li>)}</ul>}
            </div>
          ))}
        </div>
      </div>
      <p className="text-[11px] tabular-nums text-muted-foreground">
        {t('capsuleFooter', { trials: r.trials + (r.unchanged?.trials ?? 0), failed: r.failed + (r.unchanged?.failed ?? 0), model: r.model, tokens: (r.inputTokens + r.outputTokens).toLocaleString() })}
        {' · '}{r.priced ? formatUsd(r.costUsd) : t('unpriced')}
        {planned !== undefined && <>{' · '}{t('spentOfPlan', { tokens: Math.round(planned).toLocaleString() })}</>}
      </p>
    </section>
  );
}

/**
 * The capsule: the run's copy, changed and played again. The run, its thread and its owner are only read;
 * the answers typed here live in this page and go with each play.
 */
export function Capsule({ runId, models, expectDraft: shared }: { runId: string; models: string[]; expectDraft?: ExpectDraft }) {
  const { t } = useTranslation('lab');
  const base = useLabCapsuleBase(runId);
  const [system, setSystem] = useState('');
  const [tools, setTools] = useState<CapsuleToolRow[]>([]);
  const [history, setHistory] = useState(true);
  const [memory, setMemory] = useState(true);
  const [ownDraft, setExpectDraft] = useState<ExpectDraft>({ calls: '', forbidden: '', answer: '' });
  // The page's expectation when it has one (the improve screen writes it once for every step).
  const expectDraft = shared ?? ownDraft;
  const [model, setModel] = useState(models[0] ?? '');
  const [trials, setTrials] = useState(3);
  const [answers, setAnswers] = useState<Record<string, CapsuleAnswerDraft>>({});
  const [draft, setDraft] = useState({ name: '', description: '', parameters: '{"type":"object","properties":{}}' });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<{ r: LabCapsule; planned: number } | undefined>();
  const job = useLabCall<LabCapsule>('capsuleError');
  const b = base.data;
  // The editable copy is filled from the recorded run after it loads; until then the editor is not drawn,
  // so it never shows an empty prompt marked "changed".
  const [filledFrom, setFilledFrom] = useState<typeof b>();
  useEffect(() => {
    if (!b) return;
    setSystem(b.system); setTools(b.tools.map((x) => ({ ...x, keep: true, added: false }))); setHistory(true); setMemory(true); setAnswers({}); setResult(undefined);
    setFilledFrom(b);
  }, [b]);
  if (base.isLoading) return <Spinner />;
  if (base.error) return <LabRefused error={base.error} />;
  if (!b) return null;
  if (filledFrom !== b) return <Spinner />;

  const setTool = (i: number, patch: Partial<CapsuleToolRow>) => setTools((ts) => ts.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const addTool = () => {
    let parameters: unknown;
    try { parameters = JSON.parse(draft.parameters); } catch { toast.error(t('capsuleBadSchema')); return; }
    if (!draft.name.trim() || tools.some((x) => x.name === draft.name.trim())) { toast.error(t('capsuleBadToolName')); return; }
    setTools((ts) => [...ts, { name: draft.name.trim(), description: draft.description, parameters, keep: true, added: true }]);
    setDraft({ name: '', description: '', parameters: '{"type":"object","properties":{}}' });
  };
  const play = async () => {
    const want = expectationOf(expectDraft);
    if ('badLine' in want) { toast.error(t('capsuleBadExpect', { line: want.badLine })); return; }
    const built = capsuleBody(b, { model, trials, system, tools, history, memory, ...(want.expect ? { expect: want.expect } : {}) }, answers);
    if ('error' in built) { toast.error(t('capsuleBadAnswer', { call: built.error })); return; }
    const planned = playsOf(built.body) * b.tokensPerPlay;
    const r = await job.call((onProgress, signal) => api.labCapsule(built.body, onProgress, signal));
    if (r) {
      setResult({ r, planned });
      // a call no one answered gets a box; what was typed before stays
      setAnswers((a) => ({ ...Object.fromEntries(r.pending.map((c) => [answerKey(c), { ...c, text: '' }])), ...a }));
    }
  };
  const open = result ? result.r.pending.map((c) => answers[answerKey(c)] ?? { ...c, text: '' }) : [];
  // What the confirmation counts: a change is played beside the run as it was, as many times.
  const draftBody = capsuleBody(b, { model, trials, system, tools, history, memory }, {});
  const plays = 'body' in draftBody ? playsOf(draftBody.body) : trials;
  const typed = Object.values(answers).filter((a) => a.text.trim() !== '');
  const textArea = 'w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none';

  return (
    <section className="mt-4 space-y-4 text-xs" aria-labelledby="lab-capsule">
      <div className="rounded-md border border-border bg-card p-3">
        <h2 id="lab-capsule" className="text-sm font-medium">{t('capsuleTitle')}</h2>
        <p className="mt-1 text-muted-foreground">{t('capsuleHelp')}</p>
        <p className="mt-2"><span className="text-muted-foreground">{t('capsuleLastMessage')}</span> “{b.lastMessage}”</p>
        <p className="mt-1"><span className="text-muted-foreground">{t('capsuleRecordedCalls')}</span> <span className="font-mono">{b.recordedCalls.map(callLabel).join(' → ') || t('noCalls')}</span></p>
        {/* Where the input came from, by the run's own layout — or, for a memory run without one, that it cannot be told. */}
        {b.layout?.status === 'absent' && (
          <p role="status" className="mt-2 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-muted-foreground" data-testid="capsule-no-layout">
            {t('capsuleNoLayout')} {layoutReasonText(t, b.layout)}
          </p>
        )}
        {b.layout?.status === 'present' && b.layout.notes.length > 0 && (
          <ul className="mt-2 list-disc pl-4 text-muted-foreground" data-testid="capsule-layout-notes">{b.layout.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        )}
      </div>

      <div className="rounded-md border border-border bg-card p-3">
        <div className="flex items-center gap-2">
          <h3 className="font-medium">{t('capsuleSystem')}</h3>
          {system !== b.system && <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">{t('changed')}</span>}
          {system !== b.system && <Btn variant="ghost" size="xs" onClick={() => setSystem(b.system)}>{t('reset')}</Btn>}
        </div>
        <textarea aria-label={t('capsuleSystem')} className={cn(textArea, 'mt-2 min-h-[8rem]')} value={system} onChange={(e) => setSystem(e.target.value)} />
        {b.workingMemory && 'text' in b.workingMemory && (
          <div className="mt-2" data-testid="capsule-working-memory">
            <p className="text-muted-foreground">{t('capsuleWorkingMemory')}</p>
            <pre className="mt-1 whitespace-pre-wrap rounded-md border border-border bg-muted/30 px-2 py-1 font-mono">{b.workingMemory.text}</pre>
          </div>
        )}
        {b.workingMemory && !('text' in b.workingMemory) && <p className="mt-2 text-muted-foreground">{t('capsuleWorkingMemoryUnplaced', { status: b.workingMemory.status })}</p>}
      </div>

      <div className="rounded-md border border-border bg-card p-3">
        <h3 className="font-medium">{t('capsuleTools')}</h3>
        <ul className="mt-2 space-y-2">
          {tools.map((x, i) => (
            <li key={x.name} className={cn('rounded-md border border-border p-2', !x.keep && 'opacity-50')}>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={x.keep} onChange={(e) => setTool(i, { keep: e.target.checked })} />
                <span className="font-mono font-medium">{x.name}</span>
                {x.added && <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">{t('capsuleNewTool')}</span>}
                {x.recordedOnly && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground" title={t('capsuleRecordedOnlyTitle')}>{t('capsuleRecordedOnly')}</span>}
              </label>
              <textarea aria-label={t('capsuleToolDescription', { name: x.name })} className={cn(textArea, 'mt-1')} rows={2} value={x.description} disabled={!x.keep} onChange={(e) => setTool(i, { description: e.target.value })} />
            </li>
          ))}
        </ul>
        <details className="mt-2">
          <summary className="cursor-pointer text-muted-foreground">{t('capsuleAddTool')}</summary>
          <div className="mt-2 grid gap-2">
            <input aria-label={t('capsuleToolName')} placeholder={t('capsuleToolName')} className={textArea} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <textarea aria-label={t('capsuleToolDescriptionNew')} placeholder={t('capsuleToolDescriptionNew')} className={textArea} rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            <textarea aria-label={t('capsuleToolSchema')} className={textArea} rows={3} value={draft.parameters} onChange={(e) => setDraft({ ...draft, parameters: e.target.value })} />
            <div><Btn size="xs" variant="outline" onClick={addTool}>{t('capsuleAdd')}</Btn></div>
          </div>
        </details>
      </div>

      <div className="space-y-2 rounded-md border border-border bg-card p-3">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} />
          <span>{t('capsuleHistory', { n: b.earlierMessages })}</span>
        </label>
        {/* Only what the run's memory layout proves memory put in — offered when the layout proves it. */}
        {b.memoryMessages !== null && (b.memoryMessages > 0 || (b.workingMemory !== undefined && 'text' in b.workingMemory)) && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={memory} onChange={(e) => setMemory(e.target.checked)} />
            <span>{b.workingMemory && 'text' in b.workingMemory ? t('capsuleMemoryWm', { n: b.memoryMessages }) : t('capsuleMemory', { n: b.memoryMessages })}</span>
          </label>
        )}
      </div>

      {!shared && <ExpectBox draft={expectDraft} onChange={setExpectDraft} />}

      <div className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-card p-3">
        <label className="flex flex-col gap-0.5">{t('modelLabel')}
          <select className={selectCls} value={model} onChange={(e) => setModel(e.target.value)}>{models.map((m) => <option key={m} value={m}>{m}</option>)}</select>
        </label>
        <label className="flex flex-col gap-0.5">{t('capsuleTrials')}
          <input type="number" min={1} max={10} value={trials} onChange={(e) => setTrials(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} className={cn(selectCls, 'w-20')} />
        </label>
        <Btn size="xs" busy={job.busy} disabled={job.busy} onClick={() => setConfirmOpen(true)}>{t('capsulePlay')}</Btn>
        {typed.length > 0 && <span className="text-muted-foreground">{t('capsuleAnswersGo', { n: typed.length })}</span>}
      </div>
      <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen} title={t('capsuleTitle')}
        description={`${confirmText(t, { plays, model, tokens: { n: plays * b.tokensPerPlay }, cost: t('costNotEstimated') })}${plays > trials ? ` ${t('confirmCapsuleUnchanged', { trials })}` : ''}`} confirmLabel={t('capsulePlay')} onConfirm={() => void play()} />
      {job.busy && <Progress p={job.progress} unit="progressPlays" onStop={job.stop} />}
      {!job.busy && job.error && <JobError message={job.error} />}

      {open.length > 0 && (
        <div className="rounded-md border border-[#ffc9c9] bg-destructive/5 p-3" data-testid="capsule-pending">
          <h3 className="font-medium">{t('capsulePendingTitle')}</h3>
          <p className="mt-1 text-muted-foreground">{t('capsulePendingHelp')}</p>
          <ul className="mt-2 space-y-2">
            {open.map((a) => (
              <li key={answerKey(a)}>
                <div className="font-mono">{callLabel(a)} →</div>
                <textarea aria-label={t('capsuleAnswerFor', { call: callLabel(a) })} className={cn(textArea, 'mt-1')} rows={2} placeholder='{"ok": true}'
                  value={a.text} onChange={(e) => setAnswers((s) => ({ ...s, [answerKey(a)]: { ...a, text: e.target.value } }))} />
              </li>
            ))}
          </ul>
          <div className="mt-2"><Btn size="xs" disabled={job.busy || !open.some((a) => a.text.trim())} onClick={() => setConfirmOpen(true)}>{t('capsulePlayAgain')}</Btn></div>
        </div>
      )}
      {result && <CapsuleResult r={result.r} planned={result.planned} />}
      <SaveAsScenario runId={runId} agent={b.agent} body={'body' in draftBody ? draftBody.body : undefined} draft={expectDraft} answers={typed} />
      <KeptExperiments kind="capsule" target={runId} />
    </section>
  );
}

/**
 * The turn kept as a scenario of its agent: its input as the model saw it, the expectation written above,
 * the prompt as edited here and the answers typed — a copy, kept under the person whose conversation it
 * is, so erasing them erases it.
 */
function SaveAsScenario({ runId, agent, body, draft, answers }: { runId: string; agent: string; body: LabCapsuleBody | undefined; draft: ExpectDraft; answers: CapsuleAnswerDraft[] }) {
  const { t } = useTranslation('lab');
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const want = expectationOf(draft);
  const expect = 'expect' in want ? want.expect : undefined;
  const save = async () => {
    if (!expect || !title.trim()) return;
    const parsed: NonNullable<LabSaveScenarioBody['answers']> = [];
    for (const a of answers) { try { parsed.push({ toolName: a.toolName, args: a.args, output: JSON.parse(a.text) }); } catch { toast.error(t('capsuleBadAnswer', { call: callLabel(a) })); return; } }
    setBusy(true);
    try {
      await api.labSaveScenario({ runId, title: title.trim(), expect, ...(body?.system !== undefined ? { system: body.system } : {}), ...(parsed.length ? { answers: parsed } : {}) });
      await qc.invalidateQueries({ queryKey: ['lab-saved-scenarios', agent] });
      toast.success(t('scenarioSaved', { title: title.trim() }));
      setTitle('');
    } catch (e) { toast.error(errMessage(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-card p-3 text-xs" data-testid="save-scenario">
      <label className="flex flex-col gap-0.5">{t('scenarioTitleLabel')}
        <input className={cn(selectCls, 'w-72')} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('scenarioTitlePlaceholder')} />
      </label>
      <Btn size="xs" variant="outline" busy={busy} disabled={!expect || !title.trim() || busy} onClick={() => void save()}>{t('scenarioSave')}</Btn>
      <p className="w-full text-muted-foreground">{expect ? t('scenarioSaveHelp') : t('scenarioNeedsExpect')}</p>
    </div>
  );
}

/** One line for a kept experiment: what was asked and what it found, before it is opened. */
export function experimentSummary(e: Pick<LabExperiment, 'kind' | 'request' | 'result'>, t: (k: string, o?: Record<string, unknown>) => string): string {
  const r = e.result as Record<string, any>;
  if (e.kind === 'capsule') {
    const changed = [e.request.system !== undefined && t('keptSystem'), e.request.tools && t('keptTools'), e.request.history === false && t('keptNoHistory'), e.request.memory === false && t('keptNoMemory'), e.request.answers && t('keptAnswers', { n: e.request.answers })].filter(Boolean).join(', ');
    return t('keptCapsule', { same: Math.round((r?.sameAsRecorded?.value ?? 0) * (r?.sameAsRecorded?.n ?? 0)), n: r?.sameAsRecorded?.n ?? 0, changed: changed || t('keptNothing') });
  }
  if (e.kind === 'thread') {
    const v = (r?.verdict ?? {}) as LabThreadDiagnosis['verdict'];
    return t('keptThread', { verdict: typeof v.sentence === 'string' ? v.sentence : '—' });
  }
  if (e.kind === 'explain') {
    const top = Array.isArray(r?.shares) && r.shares.length ? r.shares[0] : undefined;
    return top ? t('keptExplain', { part: top.part, share: formatSigned(top.share) }) : t('keptExplainNone');
  }
  return r?.best ? t('keptForm', { form: (r.best.components as string[]).join(' + ') || t('noComponents'), rate: formatRate(r.best.passRate?.value) }) : Array.isArray(r?.forms) ? t('keptFormNone') : '';
}

/**
 * The experiments the organization's admins kept on this run (or agent), newest first; one opens to the
 * result as it was shown when it finished.
 */
export function KeptExperiments({ kind, target }: { kind: LabExperiment['kind']; target: string }) {
  const { t } = useTranslation('lab');
  const q = useLabExperiments(kind, target);
  const [open, setOpen] = useState<string | undefined>();
  const items = q.data?.items ?? [];
  if (q.isLoading || q.error) return null;
  return (
    <details className="mt-4 rounded-md border border-border bg-card p-3 text-xs" data-testid="kept-experiments">
      <summary className="cursor-pointer font-medium">{t('keptTitle', { n: items.length })}</summary>
      {items.length === 0 ? <p className="mt-2 text-muted-foreground">{t('keptNone')}</p> : (
        <ul className="mt-2 space-y-1">
          {items.map((e) => (
            <li key={e.id} className="rounded-md border border-border">
              <button type="button" className="flex w-full flex-wrap items-baseline gap-2 px-2 py-1.5 text-left hover:bg-muted/50" onClick={() => setOpen(open === e.id ? undefined : e.id)}>
                <span className="tabular-nums text-muted-foreground">{new Date(e.at).toLocaleString()}</span>
                <span className="font-mono">{e.actor}</span>
                <span className="text-muted-foreground">{e.request.model}</span>
                <span>{experimentSummary(e, t)}</span>
              </button>
              {open === e.id && (
                <div className="border-t border-border p-2">
                  {e.kind === 'capsule' && e.request.system !== undefined && <details className="mb-2"><summary className="cursor-pointer text-muted-foreground">{t('capsuleSystem')}</summary><pre className="mt-1 whitespace-pre-wrap font-mono">{e.request.system}</pre></details>}
                  {e.kind === 'capsule' ? <CapsuleResult r={e.result as LabCapsule} /> : e.kind === 'explain' ? <Result r={e.result as LabExplanation} /> : e.kind === 'thread' ? <ThreadResult d={e.result as LabThreadDiagnosis} /> : <FormsResult r={e.result as LabBestForm} />}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

// Lab: @gnldev/lab through the host's `lab` option — what brought a recorded run's calls about, each part
// of it left out in turn and the run replayed (no tool runs). Every call reads the caller's organization only.
// It lists no runs of its own: a run is looked at in the Inspector first and sent here with ?runId=.
export function Lab() {
  const { t } = useTranslation('lab');
  const caps = useCapabilities();
  const on = !!caps.data?.lab;
  const catalog = useLabCatalog(on);
  const [params, setParams] = useSearchParams();
  const [agent, setAgent] = useState<string | undefined>();
  const runId = params.get('runId') ?? undefined;
  const threadId = params.get('threadId') ?? undefined;
  const asked = params.get('mode');
  // Three tabs: improve a run or a thread (the default), a new agent, the scenarios agents are tried on.
  const mode = asked === 'new' || asked === 'scenarios' ? asked : 'improve';
  const setMode = (m: 'improve' | 'new' | 'scenarios') => setParams((p) => { const n = new URLSearchParams(p); if (m === 'improve') n.delete('mode'); else n.set('mode', m); return n; });
  useEffect(() => { if (!agent && catalog.data?.agents[0]) setAgent(catalog.data.agents[0]); }, [agent, catalog.data]);

  if (caps.isLoading) return <Spinner />;
  if (caps.error) return <ErrorBox error={caps.error} />;
  if (isScopeRefused(caps.data, 'lab')) return <ScopeRefusedState icon={Microscope} what="lab" />;
  if (!on) return <EmptyState icon={Microscope} title={t('disabledTitle')} description={t('disabledDescription')} />;
  if (catalog.isLoading) return <Spinner />;
  if (catalog.error) return <ErrorBox error={catalog.error} />;
  const agents = catalog.data?.agents ?? [];
  const models = catalog.data?.models ?? [];
  const agentSelect = (
    <label className="mb-3 flex items-center gap-2 text-xs">{t('agentLabel')}
      <select className={selectCls} value={agent ?? ''} onChange={(e) => setAgent(e.target.value)}>{agents.map((a) => <option key={a} value={a}>{a}</option>)}</select>
    </label>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0"><PageHeader title={t('title')} description={t(`description_${mode}`)} meta={
        // New, measured on a small set, and its API still moving: said where the tab is, not only in the README.
        <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium uppercase text-warning" title={t('experimentalTitle')} aria-label={`${t('experimental')}: ${t('experimentalTitle')}`} data-testid="lab-experimental">{t('experimental')}</span>
      } /></div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {agents.length > 0 && (
          <div role="tablist" className="mb-4 inline-flex rounded-md border border-border p-0.5 text-xs">
            {(['improve', 'new', 'scenarios'] as const).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={cn('rounded px-3 py-1', mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/50')}>{t(`mode_${m}`)}</button>
            ))}
          </div>
        )}
        {agents.length === 0 ? <Empty>{t('noAgents')}</Empty> : models.length === 0 ? <Empty>{t('noModels')}</Empty> : mode === 'new' ? (
          <Playground agents={agents} models={models} />
        ) : mode === 'scenarios' ? (
          <div>{agentSelect}{agent && <Scenarios agent={agent} models={models} onTryForms={() => setMode('new')} />}</div>
        ) : (
          <Improve target={{ ...(runId ? { runId } : {}), ...(threadId ? { threadId } : {}) }} models={models} />
        )}
      </div>
    </div>
  );
}
