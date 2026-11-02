// The thread diagnosis charts, drawn by hand in SVG — five of them, each a <figure> whose <figcaption> is
// the one-sentence finding and whose numbers are also in an sr-only <table>. Colours are the theme's
// tokens (`hsl(var(--token))`), and no meaning is carried by colour alone: a source is named in the
// legend and the table, an infrastructure turn is hatched and labelled, a turn without a layout is grey
// and labelled, a wrong turn carries a ✗, a turn that ended in an error carries a !, a share inside the
// noise band is faded and says so.
import { useTranslation } from 'react-i18next';
import type { LabArm, LabThreadTurn, LabTurnComposition, LabTracedCall } from '../api';
import { cn } from '../components';

export type Source = keyof LabTurnComposition['bySource'];
/** The order sources are stacked and listed in. */
export const SOURCES: readonly Source[] = ['system', 'wm', 'om', 'recall', 'recent', 'turn', 'unlabelled'];
export const SOURCE_COLOR: Record<Source, string> = {
  system: 'hsl(var(--muted-foreground))',
  wm: 'hsl(var(--warning))',
  om: 'hsl(var(--accent))',
  recall: 'hsl(var(--info))',
  recent: 'hsl(var(--primary))',
  turn: 'hsl(var(--foreground) / 0.75)',
  unlabelled: 'hsl(var(--border))',
};
/** Shares within this band moved between two runs of the same experiment (measured at 3 and 6 trials). */
export const NOISE_BAND = 0.08;
/** A share whose sign the run cannot be trusted for: inside the measured noise band, or no larger than its own ± (split-half). */
export function withinNoise(share: number, noise: number | null | undefined): boolean {
  const a = Math.abs(share);
  return a < NOISE_BAND || (noise !== null && noise !== undefined && Number.isFinite(noise) && a <= noise);
}

/** Each source's share of a turn's characters, in the stacking order (zero sources left out). */
export function shareOf(c: LabTurnComposition | undefined): Array<{ source: Source; chars: number; share: number }> {
  if (!c || !c.labelled || !fin(c.total) || c.total <= 0) return [];
  return SOURCES.filter((s) => fin(c.bySource[s]) && c.bySource[s]! > 0).map((s) => ({ source: s, chars: c.bySource[s]!, share: c.bySource[s]! / c.total }));
}
/** A number that can be drawn: null, NaN and Infinity arrive from JSON and a degenerate result, and are not. */
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const pct = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${Math.round(x * 100)}%`);
const short = (c: { toolName: string; args: unknown }) => { const a = c.args === undefined ? '' : JSON.stringify(c.args); return `${c.toolName}(${a.length > 40 ? `${a.slice(0, 37)}…` : a})`; };

// ── 1. The thread's timeline ────────────────────────────────────────────────────────────────────────

/** A turn that ended in an error the agent's own (the run's status, as the thread's ledger shows it) — not one the provider caused. */
const endedFailed = (x: LabThreadTurn) => x.class === 'failed';

/**
 * The timeline's one-sentence finding: where the wrong, the failed and the broken turns are, and memory's
 * share where it was largest. Every state is read from the turn's own class and judgement, as the ledger
 * shows them; "none wrong" is said only when the turns were judged against a right answer.
 */
export function timelineFinding(turns: readonly LabThreadTurn[], t: (k: string, o?: Record<string, unknown>) => string): string {
  const wrong = turns.filter((x) => x.expected && !x.expected.pass).map((x) => x.turn);
  const failed = turns.filter((x) => endedFailed(x) && !(x.expected && !x.expected.pass)).map((x) => x.turn);
  const infra = turns.filter((x) => x.class === 'infrastructure').map((x) => x.turn);
  const memory = (x: LabThreadTurn) => shareOf(x.composition).filter((s) => s.source === 'wm' || s.source === 'om' || s.source === 'recall' || s.source === 'recent').reduce((a, s) => a + s.share, 0);
  const top = [...turns].filter((x) => x.composition?.labelled).sort((a, b) => memory(b) - memory(a))[0];
  return [
    wrong.length ? t('figTimelineWrong', { turns: wrong.join(', ') }) : '',
    failed.length ? t('figTimelineFailed', { turns: failed.join(', ') }) : '',
    infra.length ? t('figTimelineInfra', { turns: infra.join(', ') }) : '',
    top && memory(top) > 0 ? t('figTimelineMemory', { turn: top.turn, pct: pct(memory(top)) }) : '',
  ].filter(Boolean).join(' ') || t(turns.some((x) => x.expected) ? 'figTimelineNone' : 'figTimelineNoneUnjudged', { count: turns.length });
}

export function TimelineChart({ turns, selected, onSelect }: { turns: readonly LabThreadTurn[]; selected?: string; onSelect: (runId: string) => void }) {
  const { t } = useTranslation('lab');
  const tokensOf = (x: LabThreadTurn) => (fin(x.firstStepInputTokens) && x.firstStepInputTokens > 0 ? x.firstStepInputTokens : undefined);
  const max = Math.max(1, ...turns.map((x) => tokensOf(x) ?? 0));
  const used = SOURCES.filter((s) => turns.some((x) => (x.composition?.bySource[s] ?? 0) > 0 && x.composition?.labelled));
  const anyUnlabelled = turns.some((x) => x.class !== 'infrastructure' && shareOf(x.composition).length === 0);
  const anyInfra = turns.some((x) => x.class === 'infrastructure');
  // Columns, not text over bars: a turn's state is a mark under its number, so labels never overlap, at any
  // width. Past ~24 turns the columns keep a minimum width and the row scrolls sideways.
  const ticks = [1, 0.5, 0];
  return (
    <figure className="space-y-2" data-testid="chart-timeline">
      <figcaption className="text-xs font-medium">{timelineFinding(turns, t)}</figcaption>
      <p className="text-[11px] text-muted-foreground">{t('figTimelineAxis', { max: max.toLocaleString() })}</p>
      <div className="flex gap-2">
        <div className="relative h-40 w-12 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground" aria-hidden="true">
          {ticks.map((f) => (
            <span key={f} className="absolute right-0 -translate-y-1/2" style={{ top: `${(1 - f) * 100}%` }}>{Math.round(max * f).toLocaleString()}</span>
          ))}
        </div>
        <div className="min-w-0 flex-1 overflow-x-auto py-0.5" data-testid="chart-timeline-scroll">
          <div className="relative" style={{ minWidth: `${turns.length * 22}px` }}>
            <div className="pointer-events-none absolute inset-x-0 top-0 h-40" aria-hidden="true">
              {ticks.map((f) => <div key={f} className="absolute inset-x-0 border-t border-dashed border-border" style={{ top: `${(1 - f) * 100}%` }} />)}
            </div>
            <div className="relative flex h-40 items-end gap-1" role="group" aria-label={t('figTimelineLabel')}>
              {turns.map((x) => {
                const tok = tokensOf(x);
                const pctH = tok ? Math.max(3, (tok / max) * 100) : 3;
                const shares = shareOf(x.composition);
                const infra = x.class === 'infrastructure';
                const isSel = selected === x.runId;
                return (
                  <button key={x.runId} type="button" aria-pressed={isSel} aria-label={t('figTimelineTurn', { turn: x.turn })} onClick={() => onSelect(x.runId)}
                    title={`#${x.turn} · ${t(`class_${x.class}`)}${tok ? ` · ${tok.toLocaleString()} tok` : ''}${!infra && shares.length === 0 ? ` · ${t('figNoLayoutShort')}` : ''}`}
                    className={cn('flex h-full min-w-[18px] max-w-[56px] flex-1 flex-col justify-end rounded-sm p-0.5 outline-none ring-inset focus-visible:ring-2 focus-visible:ring-ring', isSel ? 'ring-2 ring-ring' : 'hover:bg-muted/40')}>
                    <div className="flex w-full flex-col-reverse overflow-hidden rounded-t-sm" style={{ height: infra ? '18%' : `${pctH}%` }}>
                      {infra ? (
                        <div className="h-full w-full" style={{ background: 'repeating-linear-gradient(45deg, hsl(var(--destructive) / 0.15) 0 4px, hsl(var(--destructive)) 4px 6px)' }} />
                      ) : shares.length === 0 ? (
                        <div className="h-full w-full" style={{ background: 'repeating-linear-gradient(135deg, hsl(var(--muted-foreground) / 0.18) 0 5px, hsl(var(--muted-foreground) / 0.32) 5px 7px)' }} />
                      ) : shares.map((sh) => <div key={sh.source} className="w-full" style={{ height: `${sh.share * 100}%`, background: SOURCE_COLOR[sh.source] }} />)}
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="mt-1 flex gap-1" aria-hidden="true">
              {turns.map((x) => {
                const wrong = x.expected && !x.expected.pass;
                return (
                  <div key={x.runId} className={cn('flex min-w-[18px] max-w-[56px] flex-1 flex-col items-center text-[10px] leading-tight tabular-nums', selected === x.runId ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
                    <span>{x.turn}</span>
                    <span className="h-3">{x.class === 'infrastructure' ? <span className="text-destructive">⚠</span> : wrong ? <span className="font-bold text-destructive">✗</span> : endedFailed(x) ? <span className="font-bold text-destructive">!</span> : ''}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground" aria-hidden="true">
        {used.map((src) => (
          <li key={src} className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: SOURCE_COLOR[src] }} />{t(`src_${src}`)}</li>
        ))}
        {anyUnlabelled && <li className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: 'repeating-linear-gradient(135deg, hsl(var(--muted-foreground) / 0.18) 0 2px, hsl(var(--muted-foreground) / 0.4) 2px 3px)' }} />{t('figLegendNoLayout')}</li>}
        {anyInfra && <li className="flex items-center gap-1"><span className="text-destructive">⚠</span>{t('figLegendInfra')}</li>}
        {turns.some((x) => x.expected && !x.expected.pass) && <li className="flex items-center gap-1"><span className="font-bold text-destructive">✗</span>{t('figLegendWrong')}</li>}
        {turns.some((x) => endedFailed(x) && !(x.expected && !x.expected.pass)) && <li className="flex items-center gap-1"><span className="font-bold text-destructive">!</span>{t('figLegendFailed')}</li>}
      </ul>
      {used.length > 0 && <p className="text-[11px] text-muted-foreground">{t('figCharShare')}</p>}
      <table className="sr-only">
        <caption>{t('figTimelineLabel')}</caption>
        <thead><tr><th>{t('colTurn')}</th><th>{t('colClass')}</th><th>{t('colInputTokens')}</th><th>{t('colSources')}</th><th>{t('colRight')}</th></tr></thead>
        <tbody>
          {turns.map((x) => (
            <tr key={x.runId}>
              <td>{x.turn}</td><td>{t(`class_${x.class}`)}</td><td>{tokensOf(x) ?? '—'}</td>
              <td>{x.composition?.labelled ? shareOf(x.composition).map((sh) => `${t(`src_${sh.source}`)} ${pct(sh.share)}`).join(', ') : t('figNoLayout')}</td>
              <td>{x.expected ? (x.expected.pass ? '✓' : '✗') : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

// ── 2. One turn's input by source ───────────────────────────────────────────────────────────────────

export function CompositionChart({ composition, turn }: { composition: LabTurnComposition | undefined; turn: number }) {
  const { t } = useTranslation('lab');
  const shares = shareOf(composition);
  if (!composition || !composition.labelled) {
    return (
      <figure data-testid="chart-composition">
        <figcaption className="text-xs font-medium">{t('figCompositionNone', { turn })}</figcaption>
        <table className="sr-only"><thead><tr><th>{t('colSource')}</th><th>{t('colChars')}</th></tr></thead><tbody><tr><td>{t('figNoLayout')}</td><td>{fin(composition?.total) ? composition!.total : '—'}</td></tr></tbody></table>
      </figure>
    );
  }
  const top = [...shares].sort((a, b) => b.share - a.share)[0];
  return (
    <figure className="space-y-2" data-testid="chart-composition">
      <figcaption className="text-xs font-medium">{top ? t('figComposition', { turn, source: t(`src_${top.source}`), pct: pct(top.share) }) : t('figCompositionEmpty', { turn })}</figcaption>
      <svg width="100%" height="18" viewBox="0 0 100 18" preserveAspectRatio="none" aria-hidden="true" className="block">
        {(() => { let x = 0; return shares.map((s) => { const w = s.share * 100; const r = <rect key={s.source} x={x} y={0} width={w} height={18} fill={SOURCE_COLOR[s.source]} />; x += w; return r; }); })()}
      </svg>
      <table className="w-full text-left text-[11px] tabular-nums" data-testid="composition-table">
        <thead className="text-muted-foreground"><tr><th className="font-normal">{t('colSource')}</th><th className="font-normal">{t('colChars')}</th><th className="font-normal">{t('colShare')}</th></tr></thead>
        <tbody>
          {shares.map((s) => (
            <tr key={s.source} className="border-t border-border">
              <td className="py-0.5"><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: SOURCE_COLOR[s.source] }} />{t(`src_${s.source}`)}</td>
              <td>{s.chars.toLocaleString()}</td><td>{pct(s.share)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-muted-foreground">{t('figCharShare')}</p>
    </figure>
  );
}

// ── 3. Elimination: what pulls a play away from the right answer ────────────────────────────────────

export function ShapleyChart({ shares: all }: { shares: ReadonlyArray<{ part: string; blame: number | null; noise: number | null }> }) {
  const { t } = useTranslation('lab');
  // Only a finite share is drawn; one that is not stays in the table as "—".
  const shares = all.filter((s): s is { part: string; blame: number; noise: number | null } => fin(s.blame));
  const noiseOf = (s: { noise: number | null }) => (fin(s.noise) && s.noise > 0 ? s.noise : 0);
  const scale = Math.max(0.1, ...shares.map((s) => Math.abs(s.blame) + noiseOf(s)));
  const ROW = 22, LABEL = 120, PLOT = 240, H = shares.length * ROW + 18;
  const x = (v: number) => LABEL + PLOT / 2 + (v / scale) * (PLOT / 2);
  const top = shares[0];
  const finding = !top || withinNoise(top.blame, top.noise) ? t('figShapleyNone') : t('figShapley', { part: top.part, blame: top.blame.toFixed(2) });
  return (
    <figure className="space-y-2" data-testid="chart-shapley">
      <figcaption className="text-xs font-medium">{finding}</figcaption>
      <svg width={LABEL + PLOT + 60} height={H} aria-hidden="true" className="block max-w-full">
        <rect x={x(-NOISE_BAND)} y={0} width={x(NOISE_BAND) - x(-NOISE_BAND)} height={H - 18} fill="hsl(var(--muted-foreground) / 0.12)" stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" strokeWidth="0.75" />
        <line x1={x(0)} x2={x(0)} y1={0} y2={H - 18} stroke="hsl(var(--foreground))" strokeWidth="1" />
        {shares.map((s, i) => {
          const y = i * ROW + 4, inBand = withinNoise(s.blame, s.noise);
          const fill = s.blame > 0 ? 'hsl(var(--destructive))' : 'hsl(var(--success))';
          return (
            <g key={s.part} opacity={inBand ? 0.4 : 1}>
              <text x={LABEL - 6} y={y + 11} textAnchor="end" fontSize="10" fill="hsl(var(--foreground))">{s.part.length > 20 ? `${s.part.slice(0, 19)}…` : s.part}</text>
              <rect x={Math.min(x(0), x(s.blame))} y={y} width={Math.abs(x(s.blame) - x(0))} height={14} fill={fill} />
              {noiseOf(s) > 0 && <line x1={x(s.blame - noiseOf(s))} x2={x(s.blame + noiseOf(s))} y1={y + 7} y2={y + 7} stroke="hsl(var(--foreground))" strokeWidth="1" />}
              <text x={LABEL + PLOT + 4} y={y + 11} fontSize="10" fill="hsl(var(--muted-foreground))">{`${s.blame >= 0 ? '+' : '−'}${Math.abs(s.blame).toFixed(2)}${inBand ? ` ${t('figWithinNoise')}` : ''}`}</text>
            </g>
          );
        })}
        <text x={x(-scale)} y={H - 4} fontSize="9" fill="hsl(var(--muted-foreground))">{t('figShapleyLeft')}</text>
        <text x={x(scale)} y={H - 4} textAnchor="end" fontSize="9" fill="hsl(var(--muted-foreground))">{t('figShapleyRight')}</text>
      </svg>
      <table className="sr-only">
        <caption>{t('figShapleyLabel')}</caption>
        <thead><tr><th>{t('colPart')}</th><th>{t('colBlame')}</th><th>{t('colNoise')}</th><th>{t('colReading')}</th></tr></thead>
        <tbody>{all.map((s) => <tr key={s.part}><td>{s.part}</td><td>{fin(s.blame) ? s.blame.toFixed(2) : '—'}</td><td>{fin(s.noise) ? s.noise.toFixed(2) : '—'}</td><td>{!fin(s.blame) ? '—' : withinNoise(s.blame, s.noise) ? t('figIndistinguishable') : s.blame > 0 ? t('figPullsAway') : t('figPullsToward')}</td></tr>)}</tbody>
      </table>
    </figure>
  );
}

// ── 4. Verification: each arm beside the turn unchanged ─────────────────────────────────────────────

export function ForestChart({ arms, finding }: { arms: readonly LabArm[]; finding: string }) {
  const { t } = useTranslation('lab');
  const ROW = 24, LABEL = 200, PLOT = 260, H = arms.length * ROW + 22;
  const x = (v: number) => LABEL + v * PLOT;
  const base = arms[0];
  return (
    <figure className="space-y-2" data-testid="chart-forest">
      <figcaption className="text-xs font-medium">{finding}</figcaption>
      <svg width={LABEL + PLOT + 110} height={H} aria-hidden="true" className="block max-w-full">
        {base && (() => { const b = base.bounds?.high ?? base.rate; return fin(b.low) && fin(b.high) && (
          <rect x={x(b.low)} y={0} width={Math.max(1, x(b.high) - x(b.low))} height={H - 22} fill="hsl(var(--muted-foreground) / 0.15)" />
        ); })()}
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line x1={x(v)} x2={x(v)} y1={H - 22} y2={H - 18} stroke="hsl(var(--muted-foreground))" />
            <text x={x(v)} y={H - 6} textAnchor="middle" fontSize="9" fill="hsl(var(--muted-foreground))">{`${v * 100}`}</text>
          </g>
        ))}
        <line x1={x(0)} x2={x(1)} y1={H - 22} y2={H - 22} stroke="hsl(var(--muted-foreground))" />
        {arms.map((a, i) => {
          const y = i * ROW + 12;
          const helped = !!a.difference && fin(a.difference.low) && a.difference.low > 0;
          const w = worstRate(a);
          return (
            <g key={a.id}>
              <text x={LABEL - 6} y={y + 4} textAnchor="end" fontSize="10" fontWeight={i === 0 ? 700 : 400} fill="hsl(var(--foreground))">{a.label.length > 34 ? `${a.label.slice(0, 33)}…` : a.label}</text>
              {a.bounds && fin(a.bounds.low.value) && fin(a.bounds.high.value) && a.bounds.high.value > a.bounds.low.value && (
                <line x1={x(a.bounds.low.value)} x2={x(a.bounds.high.value)} y1={y + 6} y2={y + 6} stroke="hsl(var(--warning))" strokeWidth="2" strokeDasharray="3 2" />
              )}
              {fin(w.low) && fin(w.high) && <line x1={x(w.low)} x2={x(w.high)} y1={y} y2={y} stroke="hsl(var(--foreground))" strokeWidth="1.5" />}
              {fin(w.value) && (helped
                ? <rect x={x(w.value) - 4} y={y - 4} width={8} height={8} fill="hsl(var(--success))" />
                : <circle cx={x(w.value)} cy={y} r={4} fill={i === 0 ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))'} />)}
              <text x={x(1) + 8} y={y + 4} fontSize="10" fill="hsl(var(--muted-foreground))">{`${a.passed}/${ranOf(a)}${a.undetermined ? ` ?${a.undetermined}` : ''}${a.failed ? ` +${a.failed} ${t('figErrors')}` : ''}${a.untested ? ` ${t('figUntested')}` : helped ? ' ▲' : ''}`}</text>
            </g>
          );
        })}
      </svg>
      <p className="text-[11px] text-muted-foreground">{t('figForestNote')}</p>
      <table className="sr-only">
        <caption>{t('figForestLabel')}</caption>
        <thead><tr><th>{t('colArm')}</th><th>{t('colRight')}</th><th>{t('colBounds')}</th><th>{t('colDifference')}</th><th>{t('colUndetermined')}</th><th>{t('colErrors')}</th><th>{t('colJudgedOnly')}</th><th>{t('colObserved')}</th></tr></thead>
        <tbody>{arms.map((a) => <tr key={a.id}><td>{a.label}</td><td>{`${a.passed}/${ranOf(a)}`}</td><td>{a.bounds ? `${pct(a.bounds.low.value)}–${pct(a.bounds.high.value)}` : '—'}</td><td>{a.untested ? t('figUntested') : a.difference ? diffText(a.difference) : '—'}</td><td>{a.undetermined}</td><td>{a.failed}</td><td>{`${a.passed}/${a.judged} (${pct(a.rate.value)})`}</td><td>{a.observedDifference ? diffText(a.observedDifference) : '—'}</td></tr>)}</tbody>
      </table>
    </figure>
  );
}

const diffText = (d: { value: number | null; low: number | null; high: number | null }) => `${pct(d.value)} (${pct(d.low)}…${pct(d.high)})`;

/** Plays that ran and were judged or stopped: the one denominator every count is shown over. */
export const ranOf = (a: Pick<LabArm, 'judged' | 'undetermined'>) => a.judged + a.undetermined;
/** An arm's rate at its worst (every undetermined play wrong) — the rate the verdict reads; the observed one for an older server. */
const worstRate = (a: LabArm) => a.bounds?.low ?? a.rate;

// ── 5. The ways the plays went, per arm ─────────────────────────────────────────────────────────────

/** The paths shown for an arm: the most frequent `keep`, the rest summed as "other". */
export function pathsShown(a: Pick<LabArm, 'paths'>, keep = 3): Array<{ label: string; count: number; passed: number; calls?: LabTracedCall[] }> {
  const sorted = [...a.paths].sort((x, y) => y.count - x.count);
  const out: Array<{ label: string; count: number; passed: number; calls?: LabTracedCall[] }> = sorted.slice(0, keep).map((p) => ({ label: p.calls.length ? p.calls.map(short).join(' → ') : '', count: p.count, passed: p.passed, calls: p.calls }));
  const rest = sorted.slice(keep);
  if (rest.length) out.push({ label: 'other', count: rest.reduce((n, p) => n + p.count, 0), passed: rest.reduce((n, p) => n + p.passed, 0) });
  return out;
}

export function PathsChart({ arms }: { arms: readonly LabArm[] }) {
  const { t } = useTranslation('lab');
  const n = Math.max(1, ...arms.map((a) => a.paths.reduce((s, p) => s + p.count, 0)));
  const base = arms[0] ? pathsShown(arms[0])[0] : undefined;
  return (
    <figure className="space-y-2" data-testid="chart-paths">
      <figcaption className="text-xs font-medium">{base ? t('figPaths', { path: base.label || t('noCalls'), count: base.count, n }) : t('figPathsNone')}</figcaption>
      <div className="grid gap-3 sm:grid-cols-2">
        {arms.map((a) => (
          <div key={a.id} className="rounded-md border border-border p-2" aria-hidden="true">
            <p className="mb-1 truncate text-[11px] font-medium" title={a.label}>{a.label}</p>
            {pathsShown(a).map((p, i) => (
              <div key={i} className="mb-1">
                <div className="flex justify-between gap-2 text-[10px] text-muted-foreground"><span className="truncate font-mono">{p.label === 'other' ? t('figOther') : p.label || t('noCalls')}</span><span className="tabular-nums">{p.count}{p.passed ? ` · ✓${p.passed}` : ''}</span></div>
                <svg width="100%" height="6" viewBox="0 0 100 6" preserveAspectRatio="none" className="block">
                  <rect x={0} y={0} width={100} height={6} fill="hsl(var(--muted))" />
                  <rect x={0} y={0} width={(p.count / n) * 100} height={6} fill={p.label === 'other' ? 'hsl(var(--muted-foreground) / 0.5)' : 'hsl(var(--muted-foreground))'} />
                  <rect x={0} y={0} width={(p.passed / n) * 100} height={6} fill="hsl(var(--success))" />
                </svg>
              </div>
            ))}
          </div>
        ))}
      </div>
      <table className="sr-only">
        <caption>{t('figPathsLabel')}</caption>
        <thead><tr><th>{t('colArm')}</th><th>{t('colPath')}</th><th>{t('colPlays')}</th><th>{t('colRight')}</th></tr></thead>
        <tbody>{arms.flatMap((a) => pathsShown(a).map((p, i) => <tr key={`${a.id}-${i}`}><td>{a.label}</td><td>{p.label === 'other' ? t('figOther') : p.label || t('noCalls')}</td><td>{p.count}</td><td>{p.passed}</td></tr>))}</tbody>
      </table>
    </figure>
  );
}
