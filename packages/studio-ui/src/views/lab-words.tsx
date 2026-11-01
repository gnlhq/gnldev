// "Which words decided it?" — the run's last message cut into groups of words, every subset of them
// asked, and each group's share of the chance that the agent's next call is the tool chosen. A provider
// that gives the probability is asked once per subset; any other (OpenAI's API gives none for a tool
// call) is asked `samples` times, the share of tries is the value, and each word's share comes with how
// far chance can move it. It is about one decision — the next call — not the whole run.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, useLabWordsPlan, type LabWords } from '../api';
import { Spinner, Btn, cn } from '../components';
import { ConfirmDialog } from '../ui';
import { formatUsd } from './Optimizer';
import { useLabCall, LabRefused, Progress, JobError, selectCls, confirmText, formatSigned, barWidth } from './Lab';
import '../i18n';

/** The groups of words a draft holds: one a line, blank lines left out. */
export function groupsOf(draft: string): string[] {
  return draft.split('\n').map((x) => x.trim()).filter(Boolean);
}

/** A share chance alone could make: within two standard deviations of zero. */
export function byChance(s: { share: number; sd?: number }): boolean {
  return s.sd !== undefined && Math.abs(s.share) <= 2 * s.sd;
}

const MAX_GROUPS = 10;

export function Words({ runId, models }: { runId: string; models: string[] }) {
  const { t } = useTranslation('lab');
  const [model, setModel] = useState(models[0] ?? '');
  const [samples, setSamples] = useState(5);
  const [draft, setDraft] = useState<string | undefined>();
  const [tool, setTool] = useState<string | undefined>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<LabWords | undefined>();
  useEffect(() => { setDraft(undefined); setTool(undefined); setResult(undefined); }, [runId]);
  const edited = draft !== undefined ? groupsOf(draft) : undefined;
  const tooMany = (edited?.length ?? 0) > MAX_GROUPS;
  const plan = useLabWordsPlan({ runId, model, samples, ...(edited?.length && !tooMany ? { words: edited } : {}) });
  const p = plan.data;
  const words = edited ?? p?.words ?? [];
  const target = tool ?? p?.tool ?? p?.tools[0];
  const job = useLabCall<LabWords>('wordsError');
  const cost = p ? (p.estimatedCostUsd !== undefined ? `≈ ${formatUsd(p.estimatedCostUsd)}` : t('priceUnknown')) : '';
  const run = async () => {
    if (!target) return;
    const r = await job.call((onProgress, signal) => api.labWords({ runId, model, tool: target, words, samples }, onProgress, signal));
    if (r) setResult(r);
  };
  return (
    <section className="mt-4 rounded-md border border-border bg-card p-3" aria-labelledby="lab-words" data-testid="lab-words">
      <h3 id="lab-words" className="text-sm font-medium">{t('wordsTitle')}</h3>
      <p className="mt-1 text-muted-foreground">{t('wordsHelp')}</p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-0.5">{t('modelLabel')}
          <select className={selectCls} value={model} onChange={(e) => setModel(e.target.value)}>{models.map((m) => <option key={m} value={m}>{m}</option>)}</select>
        </label>
        <label className="flex flex-col gap-0.5">{t('wordsTool')}
          <select className={selectCls} value={target ?? ''} onChange={(e) => setTool(e.target.value)} data-testid="words-tool">
            {(p?.tools ?? []).map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        {p?.method !== 'logprobs' && (
          <label className="flex flex-col gap-0.5">{t('wordsSamples')}
            <input type="number" min={1} max={20} value={samples} onChange={(e) => setSamples(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} className={cn(selectCls, 'w-20')} />
          </label>
        )}
        <Btn size="xs" busy={job.busy} disabled={!p || !target || job.busy || tooMany || words.length === 0} onClick={() => setConfirmOpen(true)}>{t('wordsButton')}</Btn>
      </div>
      <label className="mt-3 flex flex-col gap-0.5">{t('wordsGroups')}
        <textarea className={cn(selectCls, 'min-h-[90px] font-mono')} value={draft ?? (p?.words ?? []).join('\n')} onChange={(e) => setDraft(e.target.value)} data-testid="words-groups" />
      </label>
      <p className="mt-1 text-[11px] text-muted-foreground">{t('wordsGroupsHelp', { max: MAX_GROUPS })}</p>
      {tooMany && <p role="alert" className="text-warning">{t('wordsTooMany', { n: edited!.length, max: MAX_GROUPS })}</p>}
      {plan.isLoading && <Spinner />}
      {plan.error && <LabRefused error={plan.error} />}
      {p && !tooMany && (
        <p className="mt-2 tabular-nums" data-testid="words-plan">
          {p.method === 'logprobs'
            ? t('wordsPlanLogprobs', { subsets: p.subsets, calls: p.calls, tokens: p.estimatedTokens.toLocaleString(), cost })
            : t('wordsPlanSampled', { subsets: p.subsets, samples: p.samples, calls: p.calls, tokens: p.estimatedTokens.toLocaleString(), cost })}
        </p>
      )}
      {p?.method === 'sampled' && <p className="mt-1 text-[11px] text-muted-foreground">{t('wordsSampledNote')}</p>}
      <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen} title={t('wordsTitle')}
        description={p ? confirmText(t, { plays: p.calls, model, tokens: { n: p.estimatedTokens }, cost }) : ''} confirmLabel={t('wordsButton')} onConfirm={() => void run()} />
      {job.busy && <Progress p={job.progress} unit="progressSubsets" onStop={job.stop} />}
      {!job.busy && job.error && <JobError message={job.error} />}
      {result && <WordsResult r={result} />}
    </section>
  );
}

function WordsResult({ r }: { r: LabWords }) {
  const { t } = useTranslation('lab');
  const largest = Math.max(0, ...r.shares.map((s) => Math.abs(s.share)));
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <div className="mt-4 space-y-2" data-testid="words-result">
      <p className="font-medium">{t('wordsResultLine', { tool: r.tool, full: pct(r.full), none: pct(r.none) })}</p>
      <ul className="space-y-1.5">
        {r.shares.map((s, i) => (
          <li key={i} className="rounded-md border border-border p-2" data-testid="words-share">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{s.word}</span>
              <span className={cn('ml-auto tabular-nums font-semibold', s.share > 0 ? 'text-success' : s.share < 0 ? 'text-destructive' : 'text-muted-foreground')}>{formatSigned(s.share)}</span>
              {s.sd !== undefined && <span className="tabular-nums text-muted-foreground">± {formatSigned(2 * s.sd).replace('+', '')}</span>}
              {byChance(s) && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground" data-testid="words-chance">{t('wordsChance')}</span>}
            </div>
            <div className="mt-1 h-1.5 w-full rounded bg-muted"><div className={cn('h-1.5 rounded', s.share >= 0 ? 'bg-success' : 'bg-destructive')} style={{ width: `${barWidth(s.share, largest)}%` }} /></div>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground">{r.method === 'sampled' ? t('wordsSampledFooter', { samples: r.samples }) : t('wordsLogprobsFooter')}</p>
      <p className="text-[11px] tabular-nums text-muted-foreground">
        {t('wordsFooter', { calls: r.calls, model: r.model, tokens: (r.inputTokens + r.outputTokens).toLocaleString() })}{' · '}{r.priced ? formatUsd(r.costUsd) : t('unpriced')}
      </p>
    </div>
  );
}
