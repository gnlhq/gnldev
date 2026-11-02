// The Lab's New agent tab: a playground. An agent is written on the page — from nothing, or from an agent
// the host's code defines — with its prompt, its tools and what each tool returns; it is talked to, and
// measured against what a right answer does, side by side with an earlier definition ("A"). Nothing runs:
// every tool call is answered from the page. Nothing is kept either, unless the conversation is kept as
// a scenario of an agent the Lab offers. Below it, the older search over the code's prompt sections.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, errMessage, useLabSavedScenarios, type LabScenarioRuns, type LabMessage, type LabPlaygroundAgent, type LabPlay, type LabMeasure, type LabPlaygroundMeasure, type LabPlaygroundCall } from '../api';
import { Btn, cn } from '../components';
import { ConfirmDialog, toast } from '../ui';
import { formatUsd } from './Optimizer';
import { useLabCall, Progress, JobError, selectCls, confirmText, callLabel, ExpectBox, expectationOf, NewAgent, type ExpectDraft } from './Lab';
import '../i18n';

// ── Pure (tested) ───────────────────────────────────────────────────────────────────────────────────

/** A tool as the page edits it: every field text, read back by definitionOf. */
export interface ToolDraft { name: string; description: string; parameters: string; answers: Array<{ args: string; output: string }>; otherwise: string }
export const emptyTool = (): ToolDraft => ({ name: '', description: '', parameters: '{"type":"object","properties":{}}', answers: [], otherwise: '' });

/** The page's drafts as a definition; a field that is not JSON is named, not sent. */
export function definitionOf(system: string, tools: readonly ToolDraft[]): { agent: LabPlaygroundAgent } | { bad: string } {
  const out: LabPlaygroundAgent['tools'] = [];
  for (const t of tools) {
    const name = t.name.trim();
    if (!name) return { bad: '(tool name)' };
    let parameters: unknown;
    try { parameters = JSON.parse(t.parameters); } catch { return { bad: `${name}: parameters` }; }
    const answers: Array<{ args: unknown; output: unknown }> = [];
    for (const a of t.answers) {
      try { answers.push({ args: JSON.parse(a.args || '{}'), output: JSON.parse(a.output) }); } catch { return { bad: `${name}(${a.args})` }; }
    }
    let otherwise: { output: unknown } | undefined;
    if (t.otherwise.trim()) { try { otherwise = { output: JSON.parse(t.otherwise) }; } catch { return { bad: `${name}: otherwise` }; } }
    out.push({ name, description: t.description, parameters, ...(answers.length ? { answers } : {}), ...(otherwise ? { otherwise } : {}) });
  }
  return { agent: { system, tools: out } };
}

/** The conversation up to and including its last user message: what a measure plays again. */
export function lastTurnOf(messages: readonly LabMessage[]): LabMessage[] {
  const at = messages.map((m) => m.role).lastIndexOf('user');
  return at < 0 ? [] : messages.slice(0, at + 1);
}

/** A playground agent's name: what its scenarios are kept under (as @gnldev/lab checks it). */
export const isAgentName = (x: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(x);

/** A message's text, as the conversation shows it. */
const textOf = (m: LabMessage): string => typeof m.content === 'string' ? m.content
  : Array.isArray(m.content) ? (m.content as Array<{ type?: string; text?: string; toolName?: string }>).map((p) => (p.type === 'text' ? p.text : p.type === 'tool-call' ? `→ ${p.toolName}` : p.type === 'tool-result' ? `← ${p.toolName}` : '')).filter(Boolean).join(' ')
  : '';

// ── The page ────────────────────────────────────────────────────────────────────────────────────────

function SourceTag({ source }: { source: LabPlaygroundCall['source'] }) {
  const { t } = useTranslation('lab');
  const tone = source === 'answer' ? 'bg-info/15 text-info' : source === 'otherwise' ? 'bg-muted text-muted-foreground' : 'bg-destructive/15 text-destructive';
  return <span className={cn('rounded px-1.5 py-0.5 text-[10px]', tone)}>{t(`pgSource_${source}`)}</span>;
}

function MeasureBlock({ m, label }: { m: LabPlaygroundMeasure; label: string }) {
  const { t } = useTranslation('lab');
  const n = m.passed + m.failed + m.undetermined;
  return (
    <div className="rounded-md border border-border bg-card p-3" data-testid="pg-measure">
      <p className="font-medium tabular-nums">{label}: {t('pgPassed', { passed: m.passed, n })}</p>
      {m.undetermined > 0 && <p className="text-warning">{t('savedUndetermined', { n: m.undetermined, calls: m.pending.map(callLabel).join(', ') })}</p>}
      <ul className="mt-1 space-y-1">
        {m.paths.map((p, i) => (
          <li key={i} className="text-muted-foreground">
            <span className="tabular-nums">{p.count}×</span> {p.calls.map(callLabel).join(' → ') || t('noCalls')}{p.text ? ` · “${p.text}”` : ''}
            {p.failures && p.failures.length > 0 && <span className="text-destructive"> · {p.failures.join('; ')}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The conversations kept under this agent's name, played together against the definition as it is on the
 * page now: change the prompt or what a tool returns, and see which of them still go right.
 */
function OwnScenarios({ name, definition, models }: { name: string; definition: () => LabPlaygroundAgent | undefined; models: string[] }) {
  const { t } = useTranslation('lab');
  const qc = useQueryClient();
  const saved = useLabSavedScenarios(isAgentName(name) ? name : undefined);
  const [model, setModel] = useState(models[0] ?? '');
  const [trials, setTrials] = useState(3);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<LabScenarioRuns | undefined>();
  const [ticked, setTicked] = useState<string[]>([]);
  const job = useLabCall<LabScenarioRuns>('scenariosError');
  const items = saved.data?.items ?? [];
  const byId = new Map((result?.scenarios ?? []).map((x) => [x.id, x]));
  // Only the ticked are played; none ticked plays them all.
  const picked = ticked.filter((id) => items.some((s) => s.id === id));
  const toggle = (id: string) => setTicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  const runLabel = picked.length ? t('savedRunPicked', { n: picked.length }) : t('pgOwnRun');
  const run = async () => {
    const def = definition(); if (!def) return;
    const r = await job.call((onProgress, signal) => api.labRunPlaygroundScenarios({ agent: name, definition: def, model, trials, ...(picked.length ? { ids: picked } : {}) }, onProgress, signal));
    if (r) setResult(r);
  };
  const remove = async (id: string) => {
    try { await api.labDeleteScenario(name, id); await qc.invalidateQueries({ queryKey: ['lab-saved-scenarios', name] }); setResult(undefined); }
    catch (e) { toast.error(errMessage(e)); }
  };
  return (
    <div className="space-y-2 rounded-md border border-border bg-card p-3" data-testid="pg-own-scenarios">
      <h3 className="font-medium">{t('pgOwnTitle', { name: name || '…', n: items.length })}</h3>
      <p className="text-muted-foreground">{t('pgOwnHelp')}</p>
      {!isAgentName(name) ? <p className="text-muted-foreground">{t('pgNeedsName')}</p> : items.length === 0 ? <p className="text-muted-foreground">{t('pgOwnNone')}</p> : (
        <>
          <ul className="space-y-1">
            {items.map((s) => {
              const r = byId.get(s.id);
              const ok = r && r.failed === 0 && r.undetermined === 0 && r.passed > 0;
              return (
                <li key={s.id} className="flex flex-wrap items-baseline gap-2 border-t border-border pt-1" data-testid="pg-own-row">
                  <input type="checkbox" aria-label={t('savedTick', { title: s.title })} checked={picked.includes(s.id)} onChange={() => toggle(s.id)} data-testid="pg-own-tick" />
                  <span className="font-medium">{s.title}</span>
                  {r && <span className={cn('tabular-nums', ok ? 'text-success' : r.failed > 0 ? 'text-destructive' : 'text-warning')}>{t('savedPassed', { passed: r.passed, n: r.passed + r.failed + r.undetermined })}</span>}
                  {r && r.failures.length > 0 && <span className="text-destructive">· {r.failures.join('; ')}</span>}
                  {r && r.undetermined > 0 && <span className="text-warning">· {t('savedUndetermined', { n: r.undetermined, calls: r.pending.map(callLabel).join(', ') })}</span>}
                  <span className="ml-auto"><Btn variant="ghost" size="xs" onClick={() => void remove(s.id)}>{t('savedRemove')}</Btn></span>
                </li>
              );
            })}
          </ul>
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
            description={`${confirmText(t, { plays: (picked.length || items.length) * trials, model, cost: t('costNotEstimated') })} ${t('pgOwnConfirm')}`} confirmLabel={runLabel} onConfirm={() => void run()} />
          {job.busy && <Progress p={job.progress} unit="progressPlays" onStop={job.stop} />}
          {!job.busy && job.error && <JobError message={job.error} />}
          {result && <p className="font-medium tabular-nums" data-testid="pg-own-summary">{t('savedSummary', { passed: result.allPassed, n: result.scenarios.length })}</p>}
        </>
      )}
    </div>
  );
}

export function Playground({ agents, models }: { agents: readonly string[]; models: string[] }) {
  const { t } = useTranslation('lab');
  const qc = useQueryClient();
  const [from, setFrom] = useState('');
  const [name, setName] = useState('');
  const [system, setSystem] = useState('');
  const [tools, setTools] = useState<ToolDraft[]>([]);
  const [messages, setMessages] = useState<LabMessage[]>([]);
  const [lastCalls, setLastCalls] = useState<LabPlay | undefined>();
  const [input, setInput] = useState('');
  const [model, setModel] = useState(models[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<ExpectDraft>({ calls: '', forbidden: '', answer: '' });
  const [trials, setTrials] = useState(5);
  const [pinned, setPinned] = useState<LabPlaygroundAgent | undefined>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [measured, setMeasured] = useState<LabMeasure | undefined>();
  const [formsAgent, setFormsAgent] = useState(agents[0] ?? '');
  const [title, setTitle] = useState('');
  const job = useLabCall<LabMeasure>('measureError');
  const area = 'w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none';

  const start = async (agent: string) => {
    setFrom(agent); setName(agent); setMessages([]); setLastCalls(undefined); setMeasured(undefined); setPinned(undefined);
    if (!agent) { setSystem(''); setTools([]); return; }
    try {
      const b = await api.labPlaygroundBase(agent);
      setSystem(b.system);
      setTools(b.tools.map((x) => ({ name: x.name, description: x.description, parameters: JSON.stringify(x.parameters, null, 2), answers: [], otherwise: '' })));
      if (!b.systemFixed) toast(t('pgSystemNotFixed', { agent }));
    } catch (e) { toast.error(errMessage(e)); }
  };
  const setTool = (i: number, patch: Partial<ToolDraft>) => setTools((ts) => ts.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const def = () => { const d = definitionOf(system, tools); if ('bad' in d) { toast.error(t('editBadJson', { call: d.bad })); return undefined; } return d.agent; };

  const send = async () => {
    const agent = def(); if (!agent || !input.trim()) return;
    const next: LabMessage[] = [...messages, { role: 'user', content: input.trim() }];
    setBusy(true);
    try {
      const r = await api.labPlay({ agent, model, messages: next });
      setLastCalls(r);
      // Stopped at a call nothing answers: the message stays unsent, so it can be played again once answered.
      if (!r.stopped) { setMessages([...next, ...r.messages]); setInput(''); }
    } catch (e) { toast.error(errMessage(e)); }
    finally { setBusy(false); }
  };
  const answerStopped = () => {
    const s = lastCalls?.stopped; if (!s) return;
    const i = tools.findIndex((x) => x.name === s.toolName);
    if (i >= 0) setTool(i, { answers: [...tools[i]!.answers, { args: JSON.stringify(s.args ?? {}), output: '{}' }] });
  };
  const turn = lastTurnOf(messages.length ? messages : input.trim() ? [{ role: 'user', content: input.trim() }] : []);
  const want = expectationOf(draft);
  const expect = 'expect' in want ? want.expect : undefined;
  const measure = async () => {
    const agent = def(); if (!agent || !expect || turn.length === 0) return;
    const r = await job.call((onProgress, signal) => api.labMeasure({ agent, model, messages: turn, expect, trials, ...(pinned ? { compareTo: pinned } : {}) }, onProgress, signal));
    if (r) setMeasured(r);
  };
  const save = async () => {
    const agent = def(); if (!agent || !expect || turn.length === 0 || !title.trim() || !isAgentName(name)) return;
    try {
      await api.labSavePlaygroundScenario({ agent: name, title: title.trim(), definition: agent, messages: turn, expect });
      await qc.invalidateQueries({ queryKey: ['lab-saved-scenarios', name] });
      toast.success(t('scenarioSaved', { title: title.trim() })); setTitle('');
    } catch (e) { toast.error(errMessage(e)); }
  };
  const d = measured?.difference;
  const known = d && d.low !== null && d.high !== null;
  const noise = !known || (d!.low! <= 0 && d!.high! >= 0);
  const pts = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v * 100))}`);

  return (
    <section className="space-y-4 text-xs" data-testid="lab-playground">
      <div className="rounded-md border border-border bg-card p-3">
        <h2 className="text-sm font-medium">{t('pgTitle')}</h2>
        <p className="mt-1 text-muted-foreground">{t('pgHelp')}</p>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-0.5">{t('pgStartFrom')}
            <select className={selectCls} value={from} onChange={(e) => void start(e.target.value)} aria-label={t('pgStartFrom')}>
              <option value="">{t('pgBlank')}</option>
              {agents.map((a) => <option key={a} value={a}>{t('pgCopyOf', { agent: a })}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-0.5">{t('pgName')}
            <input aria-label={t('pgName')} placeholder={t('pgNamePlaceholder')} className={cn(selectCls, 'w-56 font-mono')} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>
        {name !== '' && !isAgentName(name) && <p role="alert" className="mt-1 text-destructive">{t('pgBadName')}</p>}
      </div>

      <div className="space-y-2 rounded-md border border-border bg-card p-3">
        <h3 className="font-medium">{t('capsuleSystem')}</h3>
        <textarea aria-label={t('capsuleSystem')} className={cn(area, 'min-h-[6rem]')} value={system} onChange={(e) => setSystem(e.target.value)} />
      </div>

      <div className="space-y-2 rounded-md border border-border bg-card p-3" data-testid="pg-tools">
        <h3 className="font-medium">{t('pgTools')}</h3>
        <p className="text-muted-foreground">{t('pgToolsHelp')}</p>
        {tools.map((x, i) => (
          <div key={i} className="space-y-1 rounded-md border border-border p-2" data-testid="pg-tool">
            <div className="flex flex-wrap gap-2">
              <input aria-label={t('editToolName')} placeholder={t('editToolName')} className={cn(selectCls, 'w-40 font-mono')} value={x.name} onChange={(e) => setTool(i, { name: e.target.value })} />
              <input aria-label={t('pgToolDescription', { name: x.name })} placeholder={t('capsuleToolDescriptionNew')} className={cn(selectCls, 'min-w-0 flex-1')} value={x.description} onChange={(e) => setTool(i, { description: e.target.value })} />
              <Btn variant="ghost" size="xs" onClick={() => setTools(tools.filter((_, j) => j !== i))}>{t('savedRemove')}</Btn>
            </div>
            <textarea aria-label={t('pgParameters', { name: x.name })} className={area} rows={3} value={x.parameters} onChange={(e) => setTool(i, { parameters: e.target.value })} />
            <p className="font-medium">{t('pgAnswers', { name: x.name || '…' })}</p>
            {x.answers.map((a, k) => (
              <div key={k} className="flex flex-wrap items-start gap-2">
                <input aria-label={t('pgAnswerArgs', { name: x.name })} className={cn(selectCls, 'w-48 font-mono')} value={a.args} onChange={(e) => setTool(i, { answers: x.answers.map((y, m) => (m === k ? { ...y, args: e.target.value } : y)) })} />
                <span className="pt-1">→</span>
                <textarea aria-label={t('pgAnswerOutput', { name: x.name, args: a.args })} className={cn(area, 'min-w-0 flex-1')} rows={2} value={a.output} onChange={(e) => setTool(i, { answers: x.answers.map((y, m) => (m === k ? { ...y, output: e.target.value } : y)) })} />
                <Btn variant="ghost" size="xs" onClick={() => setTool(i, { answers: x.answers.filter((_, m) => m !== k) })}>{t('savedRemove')}</Btn>
              </div>
            ))}
            <div><Btn variant="outline" size="xs" onClick={() => setTool(i, { answers: [...x.answers, { args: '{}', output: '{}' }] })}>{t('editAddAnswer')}</Btn></div>
            <label className="flex flex-col gap-0.5">{t('pgOtherwise')}
              <textarea aria-label={t('pgOtherwiseFor', { name: x.name })} className={area} rows={2} placeholder={t('pgOtherwisePlaceholder')} value={x.otherwise} onChange={(e) => setTool(i, { otherwise: e.target.value })} />
            </label>
          </div>
        ))}
        <div><Btn variant="outline" size="xs" onClick={() => setTools([...tools, emptyTool()])}>{t('pgAddTool')}</Btn></div>
      </div>

      <div className="space-y-2 rounded-md border border-border bg-card p-3" data-testid="pg-chat">
        <h3 className="font-medium">{t('pgChat')}</h3>
        {messages.length === 0 ? <p className="text-muted-foreground">{t('pgChatEmpty')}</p> : (
          <ol className="space-y-1">
            {messages.map((m, i) => (
              <li key={i} className={cn('rounded px-2 py-1', m.role === 'user' ? 'bg-primary/10' : m.role === 'tool' ? 'bg-muted/40 font-mono text-[11px]' : 'bg-muted/20')} data-testid="pg-message">
                <span className="mr-2 text-[10px] uppercase text-muted-foreground">{t(`pgRole_${m.role}`)}</span>{textOf(m)}
              </li>
            ))}
          </ol>
        )}
        {lastCalls && lastCalls.calls.length > 0 && (
          <ul className="space-y-0.5" data-testid="pg-calls">
            {lastCalls.calls.map((c, i) => <li key={i}><span className="font-mono">{callLabel(c)}</span> <SourceTag source={c.source} /></li>)}
          </ul>
        )}
        {lastCalls?.stopped && (
          <p role="alert" className="rounded-md border border-warning/40 bg-warning/10 p-2 text-warning" data-testid="pg-stopped">
            {t('pgStopped', { call: callLabel(lastCalls.stopped) })}{' '}
            <Btn variant="outline" size="xs" onClick={answerStopped}>{t('pgAnswerIt')}</Btn>
          </p>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-0.5">{t('modelLabel')}
            <select className={selectCls} value={model} onChange={(e) => setModel(e.target.value)}>{models.map((m) => <option key={m} value={m}>{m}</option>)}</select>
          </label>
          <input aria-label={t('pgMessage')} placeholder={t('pgMessagePlaceholder')} className={cn(selectCls, 'min-w-0 flex-1')} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void send(); }} />
          <Btn size="xs" busy={busy} disabled={busy || !input.trim()} onClick={() => void send()}>{t('pgSend')}</Btn>
          {messages.length > 0 && <Btn variant="ghost" size="xs" onClick={() => { setMessages([]); setLastCalls(undefined); }}>{t('pgClear')}</Btn>}
        </div>
        {lastCalls && <p className="text-[11px] tabular-nums text-muted-foreground">{t('tokens', { n: (lastCalls.inputTokens + lastCalls.outputTokens).toLocaleString() })} · {lastCalls.priced ? formatUsd(lastCalls.costUsd) : t('unpriced')}</p>}
      </div>

      <div className="space-y-2 rounded-md border border-border p-3" data-testid="pg-measure-step">
        <h3 className="font-medium">{t('pgMeasure')}</h3>
        <p className="text-muted-foreground">{t('pgMeasureHelp')}</p>
        <ExpectBox draft={draft} onChange={setDraft} />
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-0.5">{t('capsuleTrials')}
            <input type="number" min={1} max={10} value={trials} onChange={(e) => setTrials(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} className={cn(selectCls, 'w-20')} />
          </label>
          <Btn size="xs" busy={job.busy} disabled={job.busy || !expect || turn.length === 0} onClick={() => setConfirmOpen(true)}>{pinned ? t('pgMeasureVsA') : t('pgMeasureRun')}</Btn>
          <Btn variant="outline" size="xs" onClick={() => { const a = def(); if (a) { setPinned(a); toast.success(t('pgPinned')); } }}>{t('pgPin')}</Btn>
          {pinned && <Btn variant="ghost" size="xs" onClick={() => setPinned(undefined)}>{t('pgUnpin')}</Btn>}
        </div>
        {turn.length === 0 && <p className="text-muted-foreground">{t('pgNeedsTurn')}</p>}
        <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen} title={t('pgMeasure')}
          description={`${confirmText(t, { plays: trials * (pinned ? 2 : 1), model, cost: t('costNotEstimated') })}${pinned ? ` ${t('pgConfirmVsA', { trials })}` : ''}`} confirmLabel={t('pgMeasureRun')} onConfirm={() => void measure()} />
        {job.busy && <Progress p={job.progress} unit="progressPlays" onStop={job.stop} />}
        {!job.busy && job.error && <JobError message={job.error} />}
        {measured && (
          <div className="space-y-2" data-testid="pg-result">
            {measured.compared && measured.difference && (
              <div role="status" className={cn('rounded-md border p-3', noise ? 'border-border bg-muted/40' : d!.low! > 0 ? 'border-success/40 bg-success/10' : 'border-destructive/40 bg-destructive/10')} data-testid="pg-compare">
                <p className="text-sm font-medium tabular-nums">{t('pgCompare', { a: measured.compared.passed, an: measured.compared.passed + measured.compared.failed + measured.compared.undetermined, b: measured.measure.passed, bn: measured.measure.passed + measured.measure.failed + measured.measure.undetermined })}</p>
                <p className="tabular-nums">{t('capsuleDiff', { d: pts(d!.value), low: pts(d!.low), high: pts(d!.high) })}</p>
                <p className="font-medium">{t(noise ? 'capsuleDiffNoise' : d!.low! > 0 ? 'capsuleDiffHelped' : 'capsuleDiffHurt')}</p>
              </div>
            )}
            <div className="grid gap-2 md:grid-cols-2">
              {measured.compared && <MeasureBlock m={measured.compared} label={t('pgA')} />}
              <MeasureBlock m={measured.measure} label={t('pgNow')} />
            </div>
            <p className="text-[11px] tabular-nums text-muted-foreground">{t('tokens', { n: (measured.inputTokens + measured.outputTokens).toLocaleString() })} · {measured.priced ? formatUsd(measured.costUsd) : t('unpriced')}</p>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-card p-3" data-testid="pg-save">
        <label className="flex flex-col gap-0.5">{t('scenarioTitleLabel')}
          <input className={cn(selectCls, 'w-72')} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('scenarioTitlePlaceholder')} />
        </label>
        <Btn size="xs" variant="outline" disabled={!expect || turn.length === 0 || !title.trim() || !isAgentName(name)} onClick={() => void save()}>{t('scenarioSave')}</Btn>
        <p className="w-full text-muted-foreground">{!isAgentName(name) ? t('pgNeedsName') : !expect ? t('scenarioNeedsExpect') : t('pgSaveHelp', { name })}</p>
      </div>

      <OwnScenarios name={name} definition={def} models={models} />

      <details className="rounded-md border border-border p-3" data-testid="pg-forms">
        <summary className="cursor-pointer font-medium">{t('pgFormsTitle')}</summary>
        <div className="mt-2">
          <label className="flex items-center gap-2">{t('agentLabel')}
            <select className={selectCls} value={formsAgent} onChange={(e) => setFormsAgent(e.target.value)}>{agents.map((a) => <option key={a} value={a}>{a}</option>)}</select>
          </label>
          {formsAgent && <NewAgent agent={formsAgent} models={models} />}
        </div>
      </details>
    </section>
  );
}
