// ThreadDetail — the thread-level half of the Inspector (option B of the Threads-tab critique:
// "the folder view solved nothing"). Design intent, in the product's own vocabulary: a CONVERSATION
// LEDGER. Turns are a real sequence, so they get real mono numbers (the one place the design system
// allows numbering); the ledger stays quiet — the single bold element is the per-turn MEMORY CONTEXT
// panel, because "what did memory inject into this turn, and why" is the question no competing tool
// answers (trace-side tools see only the finished prompt).
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronDown, ChevronRight, BrainCircuit, Ghost } from 'lucide-react';
import { useMemoryContext, useThreadMessages, type Capabilities, type MemoryContextRecord, type MemoryContextResponse, type MetricsRun, type RecalledMessageRef, type RunSummary } from '../api';
import { StatusBadge, Empty, Btn, cn } from '../components';

/** Role tone for provenance refs — the SAME mapping the Inspector's chat bubbles use. */
const REF_ROLE_TONE: Record<string, string> = { user: 'text-info', assistant: 'text-success', tool: 'text-warning', system: 'text-muted-foreground' };

function refPreviewOf(m: any): string {
  const c = m?.content;
  if (typeof c === 'string') return c.replace(/\s+/g, ' ').trim();
  if (!Array.isArray(c)) return '';
  const short = (v: unknown) => { try { return typeof v === 'string' ? v : JSON.stringify(v); } catch { return String(v); } };
  const parts: string[] = [];
  for (const p of c) {
    if (typeof p?.text === 'string' && p.text) parts.push(p.text);
    else if (p?.type === 'tool-call') parts.push(`→ ${p.toolName ?? 'tool'}(${short(p.input ?? p.args)})`);
    else if (p?.type === 'tool-result') parts.push(`${p.toolName ?? 'tool'} → ${short(p.output ?? p.result)}`);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** Mirrors RunDetail's duration formatting (short mono forms — the ledger column stays narrow). */
function fmtDur(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

const LOSS_REASONS = ['messages-dropped', 'boundary-lost', 'turn-dropped'] as const;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
const refsOf = (x: unknown): RecalledMessageRef[] =>
  Array.isArray(x)
    ? x.filter(isObj).map((r) => ({ threadId: String(r.threadId ?? ''), seq: num(r.seq) ?? -1, role: String(r.role ?? ''), preview: typeof r.preview === 'string' ? r.preview : '', ...(num(r.score) !== undefined ? { score: num(r.score) } : {}) }))
    : [];

/**
 * The memory record as this panel reads it. It is the journal's own record, of whatever shape a
 * release once wrote or a store returns — every field is checked before use, and a record that is not
 * an object at all is `null` (shown as unreadable, never thrown on).
 */
export function readMemoryRecord(raw: unknown): (Omit<MemoryContextRecord, 'recentCount' | 'incomingCount' | 'v' | 'threadId'> & { recentCount?: number }) | null {
  if (!isObj(raw)) return null;
  const loss = LOSS_REASONS.find((r) => r === raw.incomingUnrecoverable);
  return {
    recalled: refsOf(raw.recalled),
    ...(num(raw.recentCount) !== undefined ? { recentCount: num(raw.recentCount) } : {}),
    ...(Array.isArray(raw.recent) ? { recent: refsOf(raw.recent) } : {}),
    ...(num(raw.observationCount) !== undefined ? { observationCount: num(raw.observationCount) } : {}),
    ...(num(raw.workingMemoryChars) !== undefined ? { workingMemoryChars: num(raw.workingMemoryChars) } : {}),
    echoTrimmed: num(raw.echoTrimmed) ?? 0,
    ...(loss ? { incomingUnrecoverable: loss } : {}),
    ...(raw.incomingDedupedByShape === true ? { incomingDedupedByShape: true as const } : {}),
  };
}

/**
 * What the layout says, in the panel's three numbers: rows memory GAVE (what it returned), rows of
 * memory's that were SENT to the model, and what the input processors changed between the two. From the
 * server's reading (durable readRunMemoryLayout), never from the counts: `absent` says why there is none.
 */
export function layoutSummary(reading: MemoryContextResponse['layout'] | unknown):
  | { kind: 'absent'; reason: string }
  | { kind: 'undiagnosable'; status: string }
  | { kind: 'present'; gave: number; sent: number; dropped: number; foreign: number; rewritten: number; ambiguous: number } {
  if (!isObj(reading) || reading.status !== 'present' || !isObj(reading.layout)) {
    return { kind: 'absent', reason: isObj(reading) && typeof reading.reason === 'string' ? reading.reason : 'no-layout' };
  }
  const L = reading.layout;
  if (L.status !== 'exact' && L.status !== 'changed') return { kind: 'undiagnosable', status: String(L.status) };
  const n = num(L.n) ?? 0;
  const incoming = Array.isArray(L.incoming) ? num(L.incoming[0]) : undefined;
  const histEnd = incoming ?? n;
  const len = (x: unknown) => (Array.isArray(x) ? x.length : 0);
  const foreign = len(L.foreign), dropped = num(L.droppedByChain) ?? 0;
  const sent = Math.max(0, histEnd - foreign);
  return { kind: 'present', gave: sent + dropped, sent, dropped, foreign, rewritten: len(L.rewritten), ambiguous: len(L.ambiguous) };
}

/**
 * Per-turn memory provenance: served lazily (only when the turn's Memory row is expanded).
 * Rows use the journal vocabulary as mono eyebrows (RECALL / RECENT / WM / OM / TRIM) — these are
 * SDK terms, deliberately untranslated (the surrounding sentences are). An honest empty state for
 * runs without a record — never an error. The LAYOUT line first: what memory gave, what reached the
 * model, and what an input processor changed — or, without a layout, that this turn cannot be
 * diagnosed by position and the counts are memory's own pre-processor report.
 */
export function MemoryContextPanel({ runId, threadId, threadMessages }: {
  runId: string;
  /** For backfilling empty previews: refs whose record predates structural previews (old "—" rows). */
  threadId?: string;
  threadMessages?: any[];
}) {
  const { t } = useTranslation('inspector');
  const q = useMemoryContext(runId);
  // Frozen records can't be rewritten — but their refs carry seq, and the thread messages are already
  // loaded by the ledger: derive the preview live when the frozen one is empty (same-thread refs only;
  // cross-thread recall refs can't be resolved from this thread's list).
  const fill = (r: { threadId: string; seq: number; preview: string }): string =>
    r.preview || (threadId && r.threadId === threadId && threadMessages?.[r.seq] ? refPreviewOf(threadMessages[r.seq]) : '');
  if (q.isLoading) return <div className="px-3 py-2 text-[11px] text-muted-foreground">{t('memLoading')}</div>;
  const raw = q.data?.context ?? null;
  if (raw === null || raw === undefined) return <div className="px-3 py-2 text-[11px] text-muted-foreground">{t('memNoProvenance')}</div>;
  const ctx = readMemoryRecord(raw);
  if (!ctx) return <div role="status" className="px-3 py-2 text-[11px] text-muted-foreground">{t('memUnreadable')} {t('memNoLayout')} <span className="font-mono">malformed</span></div>;
  const lay = layoutSummary(q.data?.layout);
  return (
    <div className="space-y-1.5 px-3 py-2">
      {lay.kind === 'present' ? (
        <div className="flex items-baseline gap-2 text-[11px]">
          <span className="microlabel shrink-0 text-muted-foreground">layout</span>
          <span className="text-foreground">
            {t('memLayoutLine', { gave: lay.gave, sent: lay.sent })}
            {lay.dropped > 0 && <> · {t('memLayoutDropped', { count: lay.dropped })}</>}
            {lay.foreign > 0 && <> · {t('memLayoutForeign', { count: lay.foreign })}</>}
            {lay.rewritten > 0 && <> · {t('memLayoutRewritten', { count: lay.rewritten })}</>}
            {lay.ambiguous > 0 && <> · {t('memLayoutAmbiguous', { count: lay.ambiguous })}</>}
          </span>
        </div>
      ) : (
        <div data-testid="mem-no-layout" className="rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
          {lay.kind === 'undiagnosable' ? t('memLayoutUndiagnosable', { status: lay.status })
            : lay.reason === 'unresolved' ? t('memLayoutUnresolved')
            : <>{t('memNoLayout')} <span className="font-mono">{lay.reason}</span></>}
        </div>
      )}
      {ctx.recalled.map((r) => (
        <div key={`${r.threadId}:${r.seq}`} className="flex items-baseline gap-2 text-[11px]">
          <span className="microlabel shrink-0 text-info">recall</span>
          <span className="shrink-0 font-mono text-muted-foreground">#{r.seq}</span>
          {r.score !== undefined && (
            <span className="shrink-0 font-mono tabular-nums text-foreground" title={t('memSimilarityTitle')}>
              {r.score.toFixed(2)}
            </span>
          )}
          <span className="truncate text-muted-foreground">“{fill(r)}”</span>
        </div>
      ))}
      <div className="flex items-baseline gap-2 text-[11px]">
        <span className="microlabel shrink-0 text-muted-foreground">recent</span>
        <span className="text-muted-foreground">{ctx.recentCount !== undefined ? t('memRecentCount', { count: ctx.recentCount }) : '—'}</span>
      </div>
      {/* The window ITSELF — "what went to the model", ref by ref. Records written before the
          `recent` field existed fall back to the count line above alone. */}
      {ctx.recent?.map((r) => (
        <div key={`recent:${r.threadId}:${r.seq}`} className="flex items-baseline gap-2 pl-4 text-[11px]">
          <span className="shrink-0 font-mono text-muted-foreground">#{r.seq}</span>
          <span className={cn('microlabel shrink-0', REF_ROLE_TONE[r.role] ?? 'text-muted-foreground')}>{r.role}</span>
          <span className="truncate text-muted-foreground">{fill(r) ? `“${fill(r)}”` : '—'}</span>
        </div>
      ))}
      {ctx.recent && ctx.recentCount !== undefined && ctx.recentCount > ctx.recent.length && (
        <div className="pl-4 text-[11px] text-muted-foreground">{t('memRecentTruncated', { count: ctx.recentCount - ctx.recent.length })}</div>
      )}
      {ctx.observationCount !== undefined && ctx.observationCount > 0 && (
        <div className="flex items-baseline gap-2 text-[11px]">
          <span className="microlabel shrink-0 text-muted-foreground">om</span>
          <span className="text-muted-foreground">{t('memObservations', { count: ctx.observationCount })}</span>
        </div>
      )}
      {ctx.workingMemoryChars !== undefined && (
        <div className="flex items-baseline gap-2 text-[11px]">
          <span className="microlabel shrink-0 text-muted-foreground">wm</span>
          <span className="text-muted-foreground">{t('memWorkingMemory', { chars: ctx.workingMemoryChars })}</span>
        </div>
      )}
      {ctx.echoTrimmed > 0 && (
        <div className="flex items-baseline gap-2 text-[11px]">
          <span className="microlabel shrink-0 text-warning">trim</span>
          <span className="text-muted-foreground">{t('memEchoTrimmed', { count: ctx.echoTrimmed })}</span>
        </div>
      )}
      {/* The one row in this panel that is an ALARM rather than provenance: the input processors left
          no recoverable copy of the turn, so the thread holds this run's answer and no question. It
          gets a tinted box instead of a quiet eyebrow line because it is a silent loss — nothing else
          in the UI shows it, and the run itself looks perfectly successful. Double-coded: the tone is
          carried by the `lost` label and the sentence, not by color alone. */}
      {ctx.incomingUnrecoverable && (
        <div role="status" className="flex items-baseline gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px]">
          <span className="microlabel shrink-0 text-destructive">lost</span>
          <span className="min-w-0 text-foreground">
            {t('memIncomingUnrecoverable')}{' '}
            {/* The REASON stays untranslated: it is the SDK's own enum (see @gnldev/durable
                IncomingLossReason) and it is what an operator greps the logs for. */}
            <span className="font-mono text-destructive">{ctx.incomingUnrecoverable}</span>
            <span className="block text-muted-foreground">{t(`memLossReason.${ctx.incomingUnrecoverable}`)}</span>
          </span>
        </div>
      )}
      {/* Neutral by design: the dedupe compared MASKED shapes, so what it can have cost is the turn
          COUNT, never content. A note, not a warning. */}
      {ctx.incomingDedupedByShape && (
        <div className="flex items-baseline gap-2 text-[11px]">
          <span className="microlabel shrink-0 text-muted-foreground">dedupe</span>
          <span className="text-muted-foreground">{t('memDedupedByShape')}</span>
        </div>
      )}
    </div>
  );
}

/** One ledger row: mono turn number · status · duration · cost, plus the expandable Memory panel. */
function TurnRow({ index, run, metric, onOpenRun, threadId, threadMessages }: {
  index: number; run: RunSummary; metric?: MetricsRun; onOpenRun: (id: string) => void;
  threadId?: string; threadMessages?: any[];
}) {
  const { t } = useTranslation('inspector');
  const [memOpen, setMemOpen] = useState(false);
  return (
    <div className="border-b border-border/60">
      <div className="flex items-center gap-3 px-3 py-2">
        <span className="w-7 shrink-0 text-right font-mono text-[11px] text-muted-foreground">#{index + 1}</span>
        <button
          type="button"
          onClick={() => onOpenRun(run.runId)}
          title={t('openRunTitle')}
          className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-foreground hover:text-primary"
        >
          {run.runId}
        </button>
        <span className="hidden shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground sm:inline">{fmtDur(metric?.durationMs)}</span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {metric ? `$${metric.costUsd.toFixed(4)}` : '—'}
        </span>
        <span className="shrink-0"><StatusBadge status={run.status} /></span>
      </div>
      <button
        type="button"
        onClick={() => setMemOpen((o) => !o)}
        aria-expanded={memOpen}
        className="flex w-full items-center gap-1.5 px-3 pb-1.5 pl-[2.5rem] text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        {memOpen ? <ChevronDown size={11} className="shrink-0" /> : <ChevronRight size={11} className="shrink-0" />}
        <BrainCircuit size={11} className="shrink-0" />
        <span className="microlabel">{t('memoryContextToggle')}</span>
      </button>
      {memOpen && <div className="pl-[1.75rem]"><MemoryContextPanel runId={run.runId} threadId={threadId} threadMessages={threadMessages} /></div>}
    </div>
  );
}

/**
 * The thread-scoped detail pane. `runs` come in the left list's order (newest first) — the ledger
 * reads oldest→newest, so it reverses. Aggregates are one quiet line, not a card strip (Chanel rule:
 * this pane's single bold element is the provenance panel, nothing else competes).
 */
/** A ghost row: a question whose run died before its first token — no run exists, only the
    write-ahead'ed message. Faded + dashed on purpose: this is an ABSENCE made visible. */
function GhostRow({ preview }: { preview: string }) {
  const { t } = useTranslation('inspector');
  return (
    <div className="flex items-center gap-3 border-b border-dashed border-border/60 px-3 py-2 opacity-70" title={t('ghostTurnTitle')}>
      <span className="w-7 shrink-0 text-right font-mono text-[11px] text-muted-foreground">—</span>
      <Ghost size={12} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">“{preview}”</span>
      <span className="microlabel shrink-0 text-warning">{t('ghostTurnLabel')}</span>
    </div>
  );
}

/** The thread sent to the Lab's thread mode (offered only when the host has a lab). */
function LabThreadButton({ threadId }: { threadId: string }) {
  const { t } = useTranslation('inspector');
  const navigate = useNavigate();
  return (
    <span className="ml-auto shrink-0">
      <Btn variant="outline" size="xs" title={t('threadLabButtonTitle')} onClick={() => navigate(`/lab?threadId=${encodeURIComponent(threadId)}`)}>{t('threadLabButton')}</Btn>
    </span>
  );
}

type LedgerEntry = { kind: 'turn'; run: RunSummary } | { kind: 'ghost'; preview: string; key: string };

/**
 * Interleave completed turns (runs) with GHOST turns (unanswered questions — runs that died before
 * their first token are invisible to /runs, but their write-ahead'ed message survives in the
 * thread). Detection walks the thread messages: a user message immediately followed by another user
 * message never got its answer. Any structural mismatch (multi-message inputs, seeded transcripts)
 * falls back to the runs-only ledger — never guess an interleave that might lie.
 */
function buildLedger(messages: any[], orderedRuns: RunSummary[]): LedgerEntry[] {
  const runsOnly: LedgerEntry[] = orderedRuns.map((run) => ({ kind: 'turn', run }));
  if (!messages.length) return runsOnly;
  const queue = [...orderedRuns];
  const out: LedgerEntry[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const next = messages[i + 1];
    if (next?.role === 'user') { out.push({ kind: 'ghost', preview: refPreviewOf(m), key: `g${i}` }); continue; }
    const run = queue.shift();
    if (run) { out.push({ kind: 'turn', run }); continue; }
    if (!next) { out.push({ kind: 'ghost', preview: refPreviewOf(m), key: `g${i}` }); continue; } // trailing, runless
    return runsOnly; // answered cluster with no matching run → structure we don't understand
  }
  if (queue.length) return runsOnly; // leftover runs → same
  return out;
}

export function ThreadDetail({ threadId, title, runs, metricsById, caps, onOpenRun, onBack }: {
  threadId: string;
  title?: string;
  runs: RunSummary[];
  metricsById: Map<string, MetricsRun>;
  caps?: Capabilities;
  onOpenRun: (id: string) => void;
  onBack?: () => void;
}) {
  const { t } = useTranslation('inspector');
  const msgs = useThreadMessages(threadId);
  const ordered = useMemo(() => [...runs].reverse(), [runs]); // ledger order: turn #1 first
  const ledger = useMemo(() => buildLedger(msgs.data ?? [], ordered), [msgs.data, ordered]);
  const ghosts = ledger.filter((e) => e.kind === 'ghost').length;
  const totalCost = ordered.reduce((n, r) => n + (metricsById.get(r.runId)?.costUsd ?? 0), 0);
  const totalMs = ordered.reduce((n, r) => n + (metricsById.get(r.runId)?.durationMs ?? 0), 0);
  let turnNo = 0;
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          {onBack && (
            <button type="button" onClick={onBack} title={t('backToThreadsTitle')} className="shrink-0 text-muted-foreground hover:text-foreground md:hidden">
              <ChevronLeft size={16} />
            </button>
          )}
          <span className="microlabel shrink-0 text-muted-foreground">{t('threadEyebrow')}</span>
          <h2 className={cn('truncate text-sm', title ? 'font-semibold text-foreground' : 'font-mono text-muted-foreground')} title={threadId}>
            {title ?? threadId}
          </h2>
          {/* The thread's turns read in the Lab: why a turn went wrong, tried on copies — nothing here changes. */}
          {caps?.lab && ordered.length > 0 && <LabThreadButton threadId={threadId} />}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
          <span>{t('turnCount', { count: ordered.length })}</span>
          {ghosts > 0 && <span className="text-warning">{t('ghostCount', { count: ghosts })}</span>}
          <span className="font-mono tabular-nums">${totalCost.toFixed(4)}</span>
          <span className="font-mono tabular-nums">{fmtDur(totalMs)}</span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {ledger.length === 0
          ? <Empty>{t('threadNoTurns')}</Empty>
          : ledger.map((e) =>
              e.kind === 'ghost'
                ? <GhostRow key={e.key} preview={e.preview} />
                : <TurnRow key={e.run.runId} index={turnNo++} run={e.run} metric={metricsById.get(e.run.runId)} onOpenRun={onOpenRun} threadId={threadId} threadMessages={msgs.data} />,
            )}
      </div>
    </div>
  );
}
