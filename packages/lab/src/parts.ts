// A recorded run's parts, proposed from its own record (never typed in), each named by where it came
// from: the system prompt the caller gave, the working memory memory put in it, memory's observations,
// recall and recent window, the conversation the caller passed, and the results of the tools it called.
//
// A memory run's parts are named as the run's own layout proves it (@gnldev/durable readRunMemoryLayout);
// a memory run without a layout is not guessed at: its parts are the plain turns, each marked
// `source: 'unknown'`. A tool call and its result are never split between two parts: a provider refuses a
// conversation that holds one without the other. Shared by the Studio surface (studio.ts) and the thread
// diagnosis (thread-diagnose.ts).
import type { ModelMessage } from 'ai';
import { readRunMemoryLayout, memoryRowsOf, type MemoryLayout } from '@gnldev/durable';
import { capsuleSystemOf, type CapsuleMemory } from './capsule.js';

export interface LabPart {
  id: string;
  /**
   * Where the part came from: the system prompt the caller gave (`system`), the working memory memory
   * put in it (`wm`), memory's observations (`om`), recall (`recall`), the recent window (`recent`), the
   * conversation the caller passed or rows no memory row accounts for (`turn`), a tool's result (`tool`).
   */
  kind: 'system' | 'wm' | 'om' | 'recall' | 'recent' | 'turn' | 'tool';
  /**
   * `layout` — the kind is proven: by the run's memory layout, or because the run had no memory.
   * `unknown` — a memory run whose layout does not say (none recorded, or rows it could not label):
   * the part may hold memory's rows under another kind.
   */
  source: 'layout' | 'unknown';
  /** What the part is, as the run recorded it (cut to 160 characters). */
  preview: string;
}

/** What a run's memory layout lets the lab say about where its input came from. */
export type LabLayout =
  /** The run had no memory: nothing in its input came from memory. */
  | { status: 'none' }
  | { status: 'present'; layout: MemoryLayout['status']; memoryMessages: number; notes: string[] }
  /** A memory run whose layout does not prove where its parts came from — `detail` says why. */
  | { status: 'absent'; reason: string; detail: string };


export const cut = (s: string) => (s.length > 160 ? `${s.slice(0, 157)}…` : s);
export const textOf = (content: unknown): string =>
  typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((p: any) => (p?.type === 'text' ? p.text : p?.type === 'tool-call' ? `[${p.toolName}]` : p?.type === 'tool-result' ? `[${p.toolName} result]` : '')).join(' ').trim()
  : '';

export interface Proposed {
  parts: LabPart[];
  systemSections: Record<string, string>;
  messages: Record<string, number[]>;
  toolResults: Record<string, string>;
}

/** What proposeParts knows of where the input came from. */
export interface PartSources {
  /** The run had memory. Without `layout`, its parts are `source: 'unknown'`. */
  memory: boolean;
  /** The run's layout, when it proves the spans (status exact/changed). */
  layout?: MemoryLayout;
  rows?: CapsuleMemory;
}

type MessageKind = 'om' | 'recall' | 'recent' | 'turn';
interface Group { kind: MessageKind; source: 'layout' | 'unknown'; at: number[] }

const toolIdsOf = (m: ModelMessage | undefined, type: 'tool-call' | 'tool-result'): string[] =>
  Array.isArray(m?.content) ? (m!.content as any[]).filter((p) => p?.type === type && typeof p.toolCallId === 'string').map((p) => p.toolCallId) : [];

/** The parts of a run, from its record (see the header). @internal — `input` is the record a run was given, not an options bag. */
export function proposeParts(input: { system?: unknown; messages?: unknown }, calledTools: readonly string[], maxParts = 6, sources: PartSources = { memory: false }): Proposed {
  const recorded = typeof input.system === 'string' ? input.system : '';
  const known = !sources.memory || sources.layout !== undefined;
  const source = known ? 'layout' as const : 'unknown' as const;
  const sys = capsuleSystemOf(recorded, sources.layout ? sources.rows : undefined);
  const wmText = sys.workingMemory && 'text' in sys.workingMemory ? sys.workingMemory.text : undefined;
  let sections = sys.own.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const messages = (Array.isArray(input.messages) ? input.messages : []) as ModelMessage[];
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  const end = lastUser < 0 ? messages.length : lastUser;
  // Each position's kind, by the layout's spans; a row it does not label is `turn`, of unknown source.
  const L = sources.layout;
  const unlabelled = new Set([...(L?.foreign ?? []), ...(L?.ambiguous ?? [])]);
  const inSpan = (sp: [number, number] | undefined, i: number) => !!sp && i >= sp[0] && i < sp[1];
  const kindAt = (i: number): { kind: MessageKind; source: 'layout' | 'unknown' } => {
    if (!L) return { kind: 'turn', source };
    if (unlabelled.has(i)) return { kind: 'turn', source: 'unknown' };
    if (inSpan(L.observations, i)) return { kind: 'om', source: 'layout' };
    if (inSpan(L.recall, i)) return { kind: 'recall', source: 'layout' };
    if (inSpan(L.recent, i)) return { kind: 'recent', source: 'layout' };
    if (inSpan(L.incoming, i)) return { kind: 'turn', source: 'layout' };
    return { kind: 'turn', source: 'unknown' };
  };
  // Observations and recall are one part each; the recent window and the conversation are cut into turns.
  let groups: Group[] = [];
  for (let i = 0; i < end; i++) {
    const k = kindAt(i);
    const g = groups.at(-1);
    const sameRun = g && g.kind === k.kind && g.source === k.source && g.at.at(-1) === i - 1;
    if (sameRun && (k.kind === 'om' || k.kind === 'recall' || messages[i]!.role !== 'user')) g!.at.push(i);
    else groups.push({ kind: k.kind, source: k.source, at: [i] });
  }
  const merge = (a: Group, b: Group): Group => ({
    kind: a.kind === b.kind ? a.kind : 'turn',
    source: a.kind === b.kind && a.source === b.source ? a.source : 'unknown',
    at: [...a.at, ...b.at].sort((x, y) => x - y),
  });
  // A tool call and its result in one part.
  for (let changed = true; changed;) {
    changed = false;
    const callIn = new Map<string, number>();
    groups.forEach((g, gi) => g.at.forEach((i) => toolIdsOf(messages[i], 'tool-call').forEach((id) => callIn.set(id, gi))));
    outer: for (let gi = 0; gi < groups.length; gi++) {
      for (const i of groups[gi]!.at) for (const id of toolIdsOf(messages[i], 'tool-result')) {
        const ci = callIn.get(id);
        if (ci !== undefined && ci !== gi) {
          const [a, b] = ci < gi ? [ci, gi] : [gi, ci];
          groups = [...groups.slice(0, a), merge(groups[a]!, groups[b]!), ...groups.slice(a + 1, b), ...groups.slice(b + 1)];
          changed = true;
          break outer;
        }
      }
    }
  }
  const tools = [...new Set(calledTools)];
  const count = () => sections.length + (wmText !== undefined ? 1 : 0) + groups.length + tools.length;
  // Too many: merge the oldest neighbours of one kind, then the oldest two, then the system prompt's sections.
  while (count() > maxParts && groups.length > 1) {
    let at = groups.findIndex((g, gi) => gi + 1 < groups.length && g.kind === groups[gi + 1]!.kind);
    if (at < 0) at = 0;
    groups = [...groups.slice(0, at), merge(groups[at]!, groups[at + 1]!), ...groups.slice(at + 2)];
  }
  if (count() > maxParts && sections.length > 1) sections = [sections.join('\n\n')];
  if (count() > maxParts) throw new RangeError(`@gnldev/lab: the run has ${count()} parts even merged; raise maxParts`);
  const out: Proposed = { parts: [], systemSections: {}, messages: {}, toolResults: {} };
  sections.forEach((s, i) => { const id = `system ${i + 1}`; out.systemSections[id] = s; out.parts.push({ id, kind: 'system', source, preview: cut(s) }); });
  if (wmText !== undefined) { out.systemSections['working memory'] = wmText; out.parts.push({ id: 'working memory', kind: 'wm', source: 'layout', preview: cut(wmText) }); }
  const seen: Record<string, number> = {};
  const nameOf = (g: Group) => {
    const base = g.kind === 'om' ? 'observations' : g.kind === 'recall' ? 'recall' : g.kind === 'recent' ? 'recent' : g.source === 'unknown' && L ? 'unlabelled' : 'turn';
    seen[base] = (seen[base] ?? 0) + 1;
    return g.kind === 'om' || g.kind === 'recall' ? (seen[base] === 1 ? base : `${base} ${seen[base]}`) : `${base} ${seen[base]}`;
  };
  for (const g of groups) {
    const id = nameOf(g);
    out.messages[id] = g.at;
    out.parts.push({ id, kind: g.kind, source: g.source, preview: cut(g.at.map((j) => textOf(messages[j]!.content)).filter(Boolean).join(' · ')) });
  }
  for (const t of tools) { const id = `${t} result`; out.toolResults[id] = t; out.parts.push({ id, kind: 'tool', source, preview: `what ${t} returned` }); }
  return out;
}

/** Where a run's input came from: its layout read, and what the lab can say with it. @internal — its arguments are a reader and a run's record, not an options bag. */
export async function sourcesOf(j: { get: <T>(key: string) => Promise<T | undefined> }, runId: string, input: { threadId?: unknown }): Promise<{ sources: PartSources; layout: LabLayout }> {
  const reading = await readRunMemoryLayout(j as never, runId);
  // A run frozen with no thread had no memory: nothing in its input came from memory.
  if (reading.status === 'absent' && reading.reason === 'no-record' && input.threadId === undefined) return { sources: { memory: false }, layout: { status: 'none' } };
  const rows = memoryRowsOf(reading);
  if (!rows.known) return { sources: { memory: true }, layout: { status: 'absent', reason: rows.reason, detail: rows.detail } };
  const L = (reading as Extract<typeof reading, { status: 'present' }>).layout;
  const notes: string[] = [];
  if (rows.rewritten.length) notes.push(`${rows.rewritten.length} of memory's row(s) were rewritten by an input processor — their place is memory's, their content is not`);
  if (rows.foreign.length) notes.push(`${rows.foreign.length} row(s) no memory row accounts for (an input processor's own) — not counted as memory`);
  if (rows.ambiguous.length) notes.push(`${rows.ambiguous.length} row(s) of memory content whose part cannot be told — not counted as memory`);
  if (L.droppedByChain) notes.push(`${L.droppedByChain} of memory's row(s) were removed by an input processor before the model saw them`);
  const wm = rows.workingMemory;
  if (wm?.status === 'rewritten') notes.push('the working memory was rewritten by an input processor; its ends are anchored');
  if (wm && !('span' in wm)) notes.push(`the working memory's place in the system prompt is not known ('${wm.status}') — it cannot be told apart or left out`);
  return { sources: { memory: true, layout: L, rows }, layout: { status: 'present', layout: L.status, memoryMessages: rows.positions.length, notes } };
}
