// The Lab's Scenarios tab. Kept scenarios first — turns kept from Improve, each a copy of its conversation,
// what a right answer does and what every tool returned — played together against the agent as the host
// defines it now, every call answered from the copy. Below them, the set the host's code defines, which
// the New agent tab tries its forms on. A kept scenario that copies a person's conversation goes with
// their erasure; a play of the set is shown here and kept nowhere.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, errMessage, useLabScenarios, useLabSavedScenarios, type LabScenarioRuns, type LabSavedScenario } from '../api';
import { Spinner, ErrorBox, Btn, Empty, cn } from '../components';
import { ConfirmDialog, toast } from '../ui';
import { formatUsd } from './Optimizer';
import { useLabCall, Progress, JobError, selectCls, confirmText, callLabel, ExpectBox, draftOf, expectationOf, type ExpectDraft } from './Lab';
import '../i18n';

/** A tool result as the page edits it: the call, and what it returns as JSON text. */
interface ResultDraft { toolName: string; args: string; output: string }
const draftOfResult = (r: { toolName: string; args: unknown; output: unknown }): ResultDraft => ({ toolName: r.toolName, args: JSON.stringify(r.args ?? {}), output: JSON.stringify(r.output, null, 2) });
/** The drafts read back: a line that is not JSON is the person's to fix, named. */
export function resultsOf(drafts: readonly ResultDraft[]): { results: LabSavedScenario['results'] } | { bad: string } {
  const out: LabSavedScenario['results'] = [];
  for (const d of drafts) {
    if (!d.toolName.trim()) return { bad: '(tool name)' };
    try { out.push({ toolName: d.toolName.trim(), args: JSON.parse(d.args || '{}'), output: JSON.parse(d.output) }); }
    catch { return { bad: `${d.toolName}(${d.args})` }; }
  }
  return { results: out };
}

/**
 * A kept scenario edited on the page: its title, what a right answer does, what each tool returns (the
 * recording's results and the answers written). Whose conversation it copies does not change.
 */
function ScenarioEditor({ s, onDone }: { s: LabSavedScenario; onDone: () => void }) {
  const { t } = useTranslation('lab');
  const qc = useQueryClient();
  const [title, setTitle] = useState(s.title);
  const [draft, setDraft] = useState<ExpectDraft>(() => draftOf(s.expect));
  const [results, setResults] = useState<ResultDraft[]>(() => s.results.map(draftOfResult));
  const [answers, setAnswers] = useState<ResultDraft[]>(() => s.answers.map(draftOfResult));
  const [busy, setBusy] = useState(false);
  const area = 'w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none';
  const save = async () => {
    const want = expectationOf(draft);
    if (!('expect' in want) || !want.expect) { toast.error(t('scenarioNeedsExpect')); return; }
    const r = resultsOf(results), a = resultsOf(answers);
    if ('bad' in r) { toast.error(t('editBadJson', { call: r.bad })); return; }
    if ('bad' in a) { toast.error(t('editBadJson', { call: a.bad })); return; }
    setBusy(true);
    try {
      await api.labUpdateScenario(s.agent, s.id, { title, expect: want.expect, results: r.results, answers: a.results });
      await qc.invalidateQueries({ queryKey: ['lab-saved-scenarios', s.agent] });
      toast.success(t('editSaved', { title }));
      onDone();
    } catch (e) { toast.error(errMessage(e)); }
    finally { setBusy(false); }
  };
  const row = (list: ResultDraft[], set: (l: ResultDraft[]) => void, i: number, editableCall: boolean) => {
    const d = list[i]!;
    const put = (patch: Partial<ResultDraft>) => set(list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    return (
      <li key={i} className="space-y-1 rounded-md border border-border p-2">
        {editableCall ? (
          <div className="flex flex-wrap gap-2">
            <input aria-label={t('editToolName')} placeholder={t('editToolName')} className={cn(selectCls, 'w-40')} value={d.toolName} onChange={(e) => put({ toolName: e.target.value })} />
            <input aria-label={t('editArgs')} placeholder='{"orderId":"42"}' className={cn(selectCls, 'min-w-0 flex-1 font-mono')} value={d.args} onChange={(e) => put({ args: e.target.value })} />
            <Btn variant="ghost" size="xs" onClick={() => set(list.filter((_, j) => j !== i))}>{t('savedRemove')}</Btn>
          </div>
        ) : <div className="font-mono">{d.toolName}({d.args}) →</div>}
        <textarea aria-label={t('editOutputFor', { call: `${d.toolName}(${d.args})` })} className={area} rows={3} value={d.output} onChange={(e) => put({ output: e.target.value })} />
      </li>
    );
  };
  return (
    <div className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-3" data-testid="scenario-editor">
      <label className="flex flex-col gap-0.5">{t('savedColTitle')}
        <input className={cn(selectCls, 'w-80')} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <ExpectBox draft={draft} onChange={setDraft} />
      <div>
        <h4 className="font-medium">{t('editResults')}</h4>
        <p className="text-muted-foreground">{t('editResultsHelp')}</p>
        {results.length === 0 ? <p className="text-muted-foreground">{t('editNoResults')}</p> : <ul className="mt-1 space-y-2">{results.map((_, i) => row(results, setResults, i, false))}</ul>}
      </div>
      <div>
        <h4 className="font-medium">{t('editAnswers')}</h4>
        <p className="text-muted-foreground">{t('editAnswersHelp')}</p>
        <ul className="mt-1 space-y-2">{answers.map((_, i) => row(answers, setAnswers, i, true))}</ul>
        <div className="mt-2"><Btn variant="outline" size="xs" onClick={() => setAnswers([...answers, { toolName: '', args: '{}', output: '{}' }])}>{t('editAddAnswer')}</Btn></div>
      </div>
      <div className="flex gap-2">
        <Btn size="xs" busy={busy} disabled={busy || !title.trim()} onClick={() => void save()}>{t('editSave')}</Btn>
        <Btn variant="ghost" size="xs" onClick={onDone}>{t('editCancel')}</Btn>
      </div>
    </div>
  );
}

function SavedScenarios({ agent, models }: { agent: string; models: string[] }) {
  const { t } = useTranslation('lab');
  const qc = useQueryClient();
  const saved = useLabSavedScenarios(agent);
  const [model, setModel] = useState(models[0] ?? '');
  const [trials, setTrials] = useState(3);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<LabScenarioRuns | undefined>();
  const [editing, setEditing] = useState<string | undefined>();
  const [ticked, setTicked] = useState<string[]>([]);
  const job = useLabCall<LabScenarioRuns>('scenariosError');
  const items = saved.data?.items ?? [];
  // Only the ticked are played; none ticked plays them all. A scenario removed since drops out.
  const picked = ticked.filter((id) => items.some((s) => s.id === id));
  const toggle = (id: string) => setTicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  const runLabel = picked.length ? t('savedRunPicked', { n: picked.length }) : t('savedRunAll');
  const run = async () => {
    const r = await job.call((onProgress, signal) => api.labRunScenarios({ agent, model, trials, ...(picked.length ? { ids: picked } : {}) }, onProgress, signal));
    if (r) setResult(r);
  };
  const remove = async (id: string) => {
    try { await api.labDeleteScenario(agent, id); await qc.invalidateQueries({ queryKey: ['lab-saved-scenarios', agent] }); setResult(undefined); }
    catch (e) { toast.error(errMessage(e)); }
  };
  const byId = new Map((result?.scenarios ?? []).map((x) => [x.id, x]));
  return (
    <section className="space-y-3 rounded-md border border-border bg-card p-3" aria-labelledby="saved-scenarios" data-testid="saved-scenarios">
      <h2 id="saved-scenarios" className="text-sm font-medium">{t('savedTitle', { n: items.length })}</h2>
      <p className="text-muted-foreground">{t('savedHelp')}</p>
      {saved.isLoading && <Spinner />}
      {saved.error && <ErrorBox error={saved.error} />}
      {saved.data && items.length === 0 && <Empty>{t('savedNone')}</Empty>}
      {items.length > 0 && (
        <>
          <table className="w-full text-left">
            <thead className="text-muted-foreground"><tr>
              <th className="w-6 py-1 font-normal"><input type="checkbox" aria-label={t('savedTickAll')} checked={picked.length === items.length} onChange={() => setTicked(picked.length === items.length ? [] : items.map((s) => s.id))} /></th>
              <th className="py-1 font-normal">{t('savedColTitle')}</th><th className="font-normal">{t('savedColFrom')}</th><th className="font-normal">{t('savedColResult')}</th><th /></tr></thead>
            <tbody>
              {items.map((s) => {
                const r = byId.get(s.id);
                const ok = r && r.failed === 0 && r.undetermined === 0 && r.passed > 0;
                return (
                  <tr key={s.id} className="border-t border-border align-top" data-testid="saved-row">
                    <td className="py-1"><input type="checkbox" aria-label={t('savedTick', { title: s.title })} checked={picked.includes(s.id)} onChange={() => toggle(s.id)} data-testid="saved-tick" /></td>
                    <td className="py-1">
                      <span className="font-medium">{s.title}</span>
                      {s.owner && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground" title={t('savedOwnedTitle')}>{t('savedOwned')}</span>}
                      <div className="text-[11px] text-muted-foreground">{t('savedBy', { by: s.by, at: new Date(s.at).toLocaleString() })}</div>
                    </td>
                    <td className="font-mono text-[11px] text-muted-foreground">{'runId' in s.from ? s.from.runId : t('savedFromPlayground')}</td>
                    <td data-testid="saved-result">
                      {!r ? <span className="text-muted-foreground">—</span> : (
                        <>
                          <span className={cn('font-medium tabular-nums', ok ? 'text-success' : r.failed > 0 ? 'text-destructive' : 'text-warning')}>{t('savedPassed', { passed: r.passed, n: r.passed + r.failed + r.undetermined })}</span>
                          {r.undetermined > 0 && <div className="text-warning">{t('savedUndetermined', { n: r.undetermined, calls: r.pending.map(callLabel).join(', ') })}</div>}
                          {r.failures.length > 0 && <ul className="list-disc pl-4 text-destructive">{r.failures.map((f, i) => <li key={i}>{f}</li>)}</ul>}
                        </>
                      )}
                    </td>
                    <td className="whitespace-nowrap text-right">
                      <Btn variant="ghost" size="xs" onClick={() => setEditing(editing === s.id ? undefined : s.id)}>{t('savedEdit')}</Btn>
                      <Btn variant="ghost" size="xs" onClick={() => void remove(s.id)}>{t('savedRemove')}</Btn>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {editing && items.find((s) => s.id === editing) && <ScenarioEditor key={editing} s={items.find((s) => s.id === editing)!} onDone={() => { setEditing(undefined); setResult(undefined); }} />}
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-0.5">{t('modelLabel')}
              <select className={selectCls} value={model} onChange={(e) => setModel(e.target.value)}>{models.map((m) => <option key={m} value={m}>{m}</option>)}</select>
            </label>
            <label className="flex flex-col gap-0.5">{t('savedTrials')}
              <input type="number" min={1} max={10} value={trials} onChange={(e) => setTrials(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} className={cn(selectCls, 'w-20')} />
            </label>
            <Btn size="xs" busy={job.busy} disabled={job.busy} onClick={() => setConfirmOpen(true)}>{runLabel}</Btn>
          </div>
          <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen} title={runLabel}
            description={`${confirmText(t, { plays: (picked.length || items.length) * trials, model, cost: t('costNotEstimated') })} ${t('savedConfirmNow')}`} confirmLabel={runLabel} onConfirm={() => void run()} />
          {job.busy && <Progress p={job.progress} unit="progressPlays" onStop={job.stop} />}
          {!job.busy && job.error && <JobError message={job.error} />}
          {result && (
            <p className="tabular-nums" data-testid="saved-summary">
              <span className="font-medium">{t('savedSummary', { passed: result.allPassed, n: result.scenarios.length })}</span>
              {' · '}{t('tokens', { n: (result.inputTokens + result.outputTokens).toLocaleString() })}{' · '}{result.priced ? formatUsd(result.costUsd) : t('unpriced')}
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function Scenarios({ agent, models, onTryForms }: { agent: string; models: string[]; onTryForms: () => void }) {
  const { t } = useTranslation('lab');
  const sc = useLabScenarios(agent);
  const items = sc.data?.items ?? [];
  return (
    <section className="space-y-3 text-xs" aria-labelledby="lab-scenarios" data-testid="lab-scenarios">
      <SavedScenarios agent={agent} models={models} />
      <div className="rounded-md border border-border bg-card p-3">
        <h2 id="lab-scenarios" className="text-sm font-medium">{t('scenariosTabTitle', { agent })}</h2>
        <p className="mt-1 text-muted-foreground">{t('scenariosTabHelp')}</p>
        <p role="note" className="mt-2 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-muted-foreground" data-testid="scenarios-from-code">{t('scenariosFromCode')}</p>
      </div>
      {sc.isLoading && <Spinner />}
      {sc.error && <ErrorBox error={sc.error} />}
      {sc.data && (items.length === 0 ? <Empty>{t('scenariosNone')}</Empty> : (
        <table className="w-full text-left">
          <thead className="text-muted-foreground"><tr><th className="py-1 font-normal">{t('scenarioId')}</th><th className="font-normal">{t('scenarioCategory')}</th><th className="font-normal">{t('scenarioPrompt')}</th></tr></thead>
          <tbody>
            {items.map((x) => (
              <tr key={x.id} className="border-t border-border" data-testid="scenario-row"><td className="py-1 font-mono">{x.id}</td><td>{x.category}</td><td className="text-muted-foreground">{x.prompt}</td></tr>
            ))}
          </tbody>
        </table>
      ))}
      {items.length > 0 && <Btn size="xs" variant="outline" onClick={onTryForms}>{t('scenariosTryForms')}</Btn>}
    </section>
  );
}
