import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PiggyBank } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, useCapabilities, useOptimizerCatalog, useOptimizerDiagnosis, useOptimizerHistory, errMessage, isScopeRefused, type OptimizerReplay } from '../api';
import { Spinner, Empty, EmptyState, ErrorBox, Btn, cn, PageHeader, ScopeRefusedState } from '../components';
import { toast, ConfirmDialog } from '../ui';
import { Stagger, StaggerItem } from '../motion';
import '../i18n';

// ── Pure logic (tested) ─────────────────────────────────────────────────────────────────────────────
/** USD with enough digits for per-run costs; "—" when there is no number (unpriced, NaN sent as null). */
export function formatUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
}
/** A 0..1 share as a percentage; "—" when there is none. */
export function formatShare(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${Math.round(v * 100)}%`;
}

function Card({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="h-full min-w-0 rounded-md border border-border bg-card p-3">
      <div className="microlabel text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

const selectCls = 'rounded-md border border-input bg-background px-2 py-1 text-xs outline-none';

function Diagnosis({ agent }: { agent: string }) {
  const { t } = useTranslation('optimizer');
  const d = useOptimizerDiagnosis(agent);
  if (d.isLoading) return <Spinner />;
  if (d.error) return <ErrorBox error={d.error} />;
  if (!d.data) return null;
  const x = d.data;
  const priced = Object.values(x.byModel).every((m) => m.costUsd > 0) || x.costUsd > 0;
  return (
    <section className="mt-4" aria-labelledby="opt-findings">
      <Stagger className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StaggerItem><Card label={t('runsLabel')} value={String(x.runs)} hint={t('stepsHint', { count: x.modelSteps })} /></StaggerItem>
        <StaggerItem><Card label={t('costLabel')} value={priced ? formatUsd(x.costUsd) : t('unpriced')} /></StaggerItem>
        <StaggerItem><Card label={t('inputLabel')} value={x.inputTokens.toLocaleString()} hint={`${t('cachedLabel')}: ${x.cachedTokens.toLocaleString()}`} /></StaggerItem>
        <StaggerItem><Card label={t('repeatedLabel')} value={formatShare(x.repeatedPrefix.share)} hint={t('tokensHint', { tokens: x.repeatedPrefix.tokens.toLocaleString() })} /></StaggerItem>
        <StaggerItem><Card label={t('oldOutputLabel')} value={formatShare(x.oldToolOutput.share)} hint={t('tokensHint', { tokens: x.oldToolOutput.estimatedTokens.toLocaleString() })} /></StaggerItem>
      </Stagger>
      <h2 id="opt-findings" className="mt-5 text-sm font-medium">{t('findingsTitle')}</h2>
      {x.findings.length === 0 ? (
        <div className="mt-2"><Empty>{t('noFindings')}</Empty></div>
      ) : (
        <ul className="mt-2 space-y-2">
          {x.findings.map((f) => (
            <li key={f.lever} className="rounded-md border border-border bg-card p-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{t(`lever_${f.lever}`)}</span>
                <span className="tabular-nums text-success">
                  {f.estimatedSavingUsd !== undefined ? t('saving', { usd: formatUsd(f.estimatedSavingUsd) }) : t('savingUnpriced', { tokens: f.tokens.toLocaleString() })}
                </span>
                {f.needsReplay && <span className="rounded bg-warning/15 px-1.5 py-0.5 text-warning">{t('needsReplay')}</span>}
              </div>
              <p className="mt-1 text-muted-foreground">{f.why}</p>
            </li>
          ))}
        </ul>
      )}
      {x.notes.length > 0 && (
        <>
          <h3 className="mt-4 text-xs font-medium text-muted-foreground">{t('notesTitle')}</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {x.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        </>
      )}
    </section>
  );
}

function Replay({ agent, models }: { agent: string; models: string[] }) {
  const { t } = useTranslation('optimizer');
  const [model, setModel] = useState(models[0] ?? '');
  const [limit, setLimit] = useState(10);
  const [keepLast, setKeepLast] = useState<number | ''>('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OptimizerReplay | undefined>();
  const qc = useQueryClient();
  useEffect(() => setResult(undefined), [agent]);

  const run = async () => {
    setBusy(true);
    try {
      setResult(await api.optimizerReplay({ agent, model, limit, ...(keepLast !== '' ? { keepLast } : {}) }));
      void qc.invalidateQueries({ queryKey: ['optimizer-history', agent] });
    } catch (e) {
      toast.error(t('replayError', { error: errMessage(e) }));
    } finally {
      setBusy(false);
    }
  };

  const s = result?.summary;
  return (
    <section className="mt-6 rounded-md border border-border bg-card p-3" aria-labelledby="opt-replay">
      <h2 id="opt-replay" className="text-sm font-medium">{t('replayTitle')}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t('replayHelp')}</p>
      <div className="mt-3 flex flex-wrap items-end gap-3 text-xs">
        <label className="flex flex-col gap-0.5">{t('modelLabel')}
          <select className={selectCls} value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">{t('limitLabel')}
          <input type="number" min={1} max={50} value={limit} onChange={(e) => setLimit(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} className={cn(selectCls, 'w-20')} />
        </label>
        <label className="flex flex-col gap-0.5">{t('maskLabel')}
          <select className={selectCls} value={keepLast === '' ? '' : String(keepLast)} onChange={(e) => setKeepLast(e.target.value === '' ? '' : Number(e.target.value))}>
            <option value="">{t('maskOff')}</option>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} {t('steps')}</option>)}
          </select>
        </label>
        <Btn size="xs" busy={busy} disabled={!model} onClick={() => setConfirmOpen(true)}>{busy ? t('replaying') : t('replayButton')}</Btn>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('replayTitle')}
        description={t('replayHelp')}
        confirmLabel={t('replayButton')}
        onConfirm={() => void run()}
      />
      {s && (
        <div className="mt-4" data-testid="replay-result">
          <Stagger className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StaggerItem><Card label={t('replayedLabel')} value={String(s.replayed)} /></StaggerItem>
            <StaggerItem><Card label={t('divergedLabel')} value={`${s.diverged} (${formatShare(s.divergenceRate)})`} /></StaggerItem>
            <StaggerItem><Card label={t('missedLabel')} value={String(s.missedCallRuns)} /></StaggerItem>
            <StaggerItem><Card label={t('reorderedLabel')} value={String(s.reorderedRuns)} /></StaggerItem>
          </Stagger>
          <p className="mt-3 text-xs tabular-nums">
            {s.priced
              ? <>{t('costCompare', { recorded: formatUsd(s.recordedCostUsd), candidate: formatUsd(s.candidateCostUsd) })} — {t('ratio', { pct: formatShare(s.costRatio) })}</>
              : t('tokensCompare', { recorded: s.recordedTokens.toLocaleString(), candidate: s.candidateTokens.toLocaleString() })}
          </p>
          <ul className="mt-2 space-y-1 font-mono text-[11px]">
            {result!.runs.map((r) => (
              <li key={r.runId} className={cn(r.divergence ? 'text-warning' : 'text-muted-foreground')}>
                {t('run')} {r.runId}: {r.divergence ? t('divergedAt', { at: r.divergence.at + 1, tool: r.divergence.call.toolName }) : t('same')}
              </li>
            ))}
          </ul>
          {result!.errors.length > 0 && (
            <>
              <h3 className="mt-3 text-xs font-medium text-destructive">{t('errorsTitle')}</h3>
              <ul className="mt-1 space-y-1 font-mono text-[11px] text-destructive">
                {result!.errors.map((e) => <li key={e.runId}>{e.runId}: {e.error}</li>)}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** Saves `text` as a file named `name` (a Markdown report). */
export function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function History({ agent }: { agent: string }) {
  const { t } = useTranslation('optimizer');
  const h = useOptimizerHistory(agent);
  const [busy, setBusy] = useState(false);
  const report = async () => {
    setBusy(true);
    try {
      download(`optimizer-report-${agent}.md`, (await api.optimizerReport(agent)).markdown);
    } catch (e) {
      toast.error(t('reportError', { error: errMessage(e) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mt-6" aria-labelledby="opt-history">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="opt-history" className="text-sm font-medium">{t('historyTitle')}</h2>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">{t('reportHelp')}</span>
          <Btn size="xs" variant="outline" busy={busy} onClick={() => void report()}>{t('downloadReport')}</Btn>
        </div>
      </div>
      {h.isLoading ? <Spinner /> : h.error ? <ErrorBox error={h.error} /> : (h.data?.items?.length ?? 0) === 0 ? (
        <div className="mt-2"><Empty>{t('noHistory')}</Empty></div>
      ) : (
        <table className="mt-2 w-full text-left text-xs tabular-nums">
          <thead className="text-muted-foreground">
            <tr><th className="py-1 font-normal">{t('when')}</th><th className="font-normal">{t('candidate')}</th><th className="font-normal">{t('runs')}</th><th className="font-normal">{t('divergedLabel')}</th><th className="font-normal">{t('costVsRecorded')}</th></tr>
          </thead>
          <tbody>
            {h.data!.items.map((e) => (
              <tr key={`${e.at}-${e.model}`} className="border-t border-border">
                <td className="py-1">{new Date(e.at).toISOString().slice(0, 16).replace('T', ' ')}</td>
                <td>{e.model}{e.keepLast !== undefined ? ` ${t('maskAfter', { n: e.keepLast })}` : ''}</td>
                <td>{e.summary.replayed}</td>
                <td>{e.summary.diverged} ({formatShare(e.summary.divergenceRate)})</td>
                <td>{e.summary.priced ? formatShare(e.summary.costRatio) : `${e.summary.candidateTokens.toLocaleString()} / ${e.summary.recordedTokens.toLocaleString()}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// Optimizer: @gnldev/optimizer through the host's `optimizer` option — a diagnosis per agent and a
// replay of its latest runs with a cheaper model. Every call reads the caller's organization only.
export function Optimizer() {
  const { t } = useTranslation('optimizer');
  const caps = useCapabilities();
  const on = !!caps.data?.optimizer;
  const catalog = useOptimizerCatalog(on);
  const [agent, setAgent] = useState<string | undefined>();
  useEffect(() => { if (!agent && catalog.data?.agents[0]) setAgent(catalog.data.agents[0]); }, [agent, catalog.data]);

  if (caps.isLoading) return <Spinner />;
  if (caps.error) return <ErrorBox error={caps.error} />;
  if (isScopeRefused(caps.data, 'optimizer')) return <ScopeRefusedState icon={PiggyBank} what="optimizer" />;
  if (!on) return <EmptyState icon={PiggyBank} title={t('disabledTitle')} description={t('disabledDescription')} />;
  if (catalog.isLoading) return <Spinner />;
  if (catalog.error) return <ErrorBox error={catalog.error} />;
  const agents = catalog.data?.agents ?? [];

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0"><PageHeader title={t('title')} description={t('description')} /></div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {agents.length === 0 ? (
          <Empty>{t('noAgents')}</Empty>
        ) : (
          <>
            <label className="flex items-center gap-2 text-xs">{t('agentLabel')}
              <select className={selectCls} value={agent ?? ''} onChange={(e) => setAgent(e.target.value)}>
                {agents.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
            {agent && <Diagnosis agent={agent} />}
            {agent && (catalog.data?.models.length ?? 0) > 0 && <Replay agent={agent} models={catalog.data!.models} />}
            {agent && <History agent={agent} />}
          </>
        )}
      </div>
    </div>
  );
}
