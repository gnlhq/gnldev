// "Would removing this section change what the agent does?" — answered on new messages the person
// writes, not on the run's own (an explanation already used those). The agent runs with its full prompt
// twice (what two runs of the same thing differ by: the noise), without the section, and — when a section
// known to matter is named — without that one, to show the check can tell. Its tools run here, so each is
// answered from the page; a call nothing answers gets an error back and is listed.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, useLabPrunePlan, type LabPrune } from '../api';
import { Spinner, Btn, cn } from '../components';
import { ConfirmDialog } from '../ui';
import { formatUsd } from './Optimizer';
import { useLabCall, LabRefused, Progress, JobError, selectCls, confirmText, callLabel } from './Lab';
import { groupsOf } from './lab-words';
import '../i18n';

/** Each tool's default answer as written: JSON, or the text as it is; blank means none. */
export function otherwiseOf(drafts: Record<string, string>): { otherwise: Record<string, unknown> } | { bad: string } {
  const out: Record<string, unknown> = {};
  for (const [name, text] of Object.entries(drafts)) {
    if (!text.trim()) continue;
    try { out[name] = JSON.parse(text); } catch { return { bad: name }; }
  }
  return { otherwise: out };
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function Prune({ runId, models }: { runId: string; models: string[] }) {
  const { t } = useTranslation('lab');
  const [model, setModel] = useState(models[0] ?? '');
  const [trials, setTrials] = useState(10);
  const [remove, setRemove] = useState<string | undefined>();
  const [control, setControl] = useState('');
  const [prompts, setPrompts] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<LabPrune | undefined>();
  useEffect(() => { setRemove(undefined); setControl(''); setAnswers({}); setResult(undefined); }, [runId]);
  const lines = groupsOf(prompts);
  const plan = useLabPrunePlan({ runId, model, prompts: Math.max(1, lines.length), trials, control: !!control });
  const p = plan.data;
  const sections = p?.sections ?? [];
  const removed = remove ?? sections.at(-1)?.id;
  const parsed = otherwiseOf(answers);
  const job = useLabCall<LabPrune>('pruneError');
  const cost = p ? (p.estimatedCostUsd !== undefined ? `≈ ${formatUsd(p.estimatedCostUsd)}` : t('priceUnknown')) : '';
  const ready = !!p && !!removed && lines.length > 0 && 'otherwise' in parsed && sections.length >= 2;
  const run = async () => {
    if (!removed || !('otherwise' in parsed)) return;
    const r = await job.call((onProgress, signal) => api.labPrune({
      runId, model, remove: removed, prompts: lines, trials,
      ...(control ? { control } : {}), ...(Object.keys(parsed.otherwise).length ? { otherwise: parsed.otherwise } : {}),
    }, onProgress, signal));
    if (r) setResult(r);
  };
  return (
    <section className="mt-4 rounded-md border border-border bg-card p-3" aria-labelledby="lab-prune" data-testid="lab-prune">
      <h3 id="lab-prune" className="text-sm font-medium">{t('pruneTitle')}</h3>
      <p className="mt-1 text-muted-foreground">{t('pruneHelp')}</p>
      {plan.isLoading && <Spinner />}
      {plan.error && <LabRefused error={plan.error} />}
      {p && sections.length < 2 && <p className="mt-2 text-muted-foreground" data-testid="prune-one-section">{t('pruneOneSection')}</p>}
      {p && sections.length >= 2 && (
        <>
          <fieldset className="mt-3 space-y-1">
            <legend className="font-medium">{t('pruneRemove')}</legend>
            {sections.map((s) => (
              <label key={s.id} className="flex items-baseline gap-2">
                <input type="radio" name={`prune-${runId}`} checked={removed === s.id} onChange={() => { setRemove(s.id); if (control === s.id) setControl(''); }} />
                <span className="font-medium">{s.id}</span><span className="truncate text-muted-foreground">{s.preview}</span>
              </label>
            ))}
          </fieldset>
          <label className="mt-3 flex flex-col gap-0.5">{t('pruneControl')}
            <select className={selectCls} value={control} onChange={(e) => setControl(e.target.value)} data-testid="prune-control">
              <option value="">{t('pruneNoControl')}</option>
              {sections.filter((s) => s.id !== removed).map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
            </select>
          </label>
          <p className="mt-1 text-[11px] text-muted-foreground">{t('pruneControlHelp')}</p>
          <label className="mt-3 flex flex-col gap-0.5">{t('prunePrompts')}
            <textarea className={cn(selectCls, 'min-h-[70px]')} value={prompts} onChange={(e) => setPrompts(e.target.value)} placeholder={t('prunePromptsPlaceholder')} data-testid="prune-prompts" />
          </label>
          <p className="mt-1 text-[11px] text-muted-foreground">{t('prunePromptsHelp')}</p>
          {p.tools.length > 0 && (
            <div className="mt-3 space-y-2">
              <p className="font-medium">{t('pruneTools')}</p>
              <p role="note" className="text-[11px] text-warning">{t('pruneToolsHelp')}</p>
              {p.tools.map((x) => (
                <label key={x.name} className="flex flex-col gap-0.5">
                  <span><span className="font-mono">{x.name}</span> <span className="text-muted-foreground">{x.description}</span></span>
                  <textarea className={cn(selectCls, 'min-h-[40px] font-mono', 'bad' in parsed && parsed.bad === x.name && 'border-destructive')} value={answers[x.name] ?? ''} onChange={(e) => setAnswers({ ...answers, [x.name]: e.target.value })} placeholder={t('pruneAnswerPlaceholder')} data-testid="prune-answer" />
                </label>
              ))}
              {'bad' in parsed && <p role="alert" className="text-destructive">{t('pruneBadAnswer', { tool: parsed.bad })}</p>}
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-0.5">{t('modelLabel')}
              <select className={selectCls} value={model} onChange={(e) => setModel(e.target.value)}>{models.map((m) => <option key={m} value={m}>{m}</option>)}</select>
            </label>
            <label className="flex flex-col gap-0.5">{t('pruneTrials')}
              <input type="number" min={1} max={45} value={trials} onChange={(e) => setTrials(Math.max(1, Math.min(45, Number(e.target.value) || 1)))} className={cn(selectCls, 'w-20')} />
            </label>
            <Btn size="xs" busy={job.busy} disabled={!ready || job.busy} onClick={() => setConfirmOpen(true)}>{t('pruneButton')}</Btn>
          </div>
          {lines.length > 0 && <p className="mt-2 tabular-nums" data-testid="prune-plan">{t('prunePlanLine', { arms: p.arms, prompts: lines.length, trials, runs: p.runs, tokens: p.estimatedTokens.toLocaleString(), cost })}</p>}
          <p className="mt-1 text-[11px] text-muted-foreground">{t('pruneTrialsHelp')}</p>
        </>
      )}
      <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen} title={t('pruneTitle')}
        description={p ? `${confirmText(t, { plays: p.runs, model, tokens: { n: p.estimatedTokens }, cost })} ${t('pruneConfirmTools')}` : ''} confirmLabel={t('pruneButton')} onConfirm={() => void run()} />
      {job.busy && <Progress p={job.progress} unit="progressPlays" onStop={job.stop} />}
      {!job.busy && job.error && <JobError message={job.error} />}
      {result && <PruneResult r={result} />}
    </section>
  );
}

function PruneResult({ r }: { r: LabPrune }) {
  const { t } = useTranslation('lab');
  return (
    <div className="mt-4 space-y-2" data-testid="prune-result">
      <div role="status" className={cn('rounded-md border p-3', r.harmless ? 'border-success/40 bg-success/10' : 'border-destructive/40 bg-destructive/10')} data-testid="prune-verdict">
        <div className="font-medium">{r.harmless ? t('pruneHarmless') : t('pruneMatters')}</div>
        <div className="mt-1 tabular-nums text-muted-foreground">{t('pruneNumbers', { removed: pct(r.removed.distance), noise: pct(r.noise) })}</div>
      </div>
      {r.control && (
        <p className={cn('rounded-md border p-2', r.controlSeparates ? 'border-border text-muted-foreground' : 'border-warning/40 bg-warning/10 text-warning')} data-testid="prune-control-line">
          {r.controlSeparates ? t('pruneControlSeparates', { d: pct(r.control.distance) }) : t('pruneControlBlind', { d: pct(r.control.distance) })}
        </p>
      )}
      {!r.control && <p className="text-[11px] text-muted-foreground">{t('pruneNoControlNote')}</p>}
      {r.unanswered.length > 0 && (
        <div role="alert" className="rounded-md border border-warning/40 bg-warning/10 p-2 text-warning" data-testid="prune-unanswered">
          {t('pruneUnanswered')}
          <ul className="mt-1 list-disc pl-4">{r.unanswered.map((u, i) => <li key={i}><span className="font-mono">{callLabel(u)}</span> × {u.count}</li>)}</ul>
        </div>
      )}
      <table className="w-full text-left tabular-nums">
        <thead className="text-muted-foreground"><tr><th className="py-1 font-normal">{t('prunePrompt')}</th><th className="font-normal">{t('pruneColRemoved')}</th>{r.control && <th className="font-normal">{t('pruneColControl')}</th>}</tr></thead>
        <tbody>
          {r.removed.perPrompt.map((x, i) => (
            <tr key={i} className="border-t border-border"><td className="py-1">{x.prompt}</td><td>{pct(x.distance)}</td>{r.control && <td>{pct(r.control.perPrompt[i]?.distance ?? 0)}</td>}</tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-muted-foreground">{t('pruneDistanceNote')}</p>
      <p className="text-[11px] tabular-nums text-muted-foreground">
        {t('pruneFooter', { runs: r.runs, failed: r.failed, model: r.model, tokens: (r.inputTokens + r.outputTokens).toLocaleString() })}{' · '}{r.priced ? formatUsd(r.costUsd) : t('unpriced')}
      </p>
    </div>
  );
}
