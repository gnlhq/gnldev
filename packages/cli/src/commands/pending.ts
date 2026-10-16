// `gnl pending` — what the store still has in hand, before a shutdown or an upgrade (Karar 2.2).
//
// Three groups (@gnldev/durable pendingWork): calls in doubt and running work BLOCK; runs awaiting an
// approval do not. A call in doubt is put to its tool's recover() first, with the key it carried; what
// that cannot answer, a person decides — in a terminal. Without one nothing is asked: the list is
// printed and the exit code says whether something blocks (2), so a deploy script can stop on it.
// The list is read again after every decision; nothing is decided on a list that may have moved.
import type * as Durable from '@gnldev/durable';
import type { Journal, InDoubtCall, PendingWork, RunningWork, AwaitingApproval } from '@gnldev/durable';
import type { Command } from './types.js';
import { flag, flagBool } from '../args.js';
import { loadConfig, type GnlDevConfig } from '../config.js';
import { getJournal, parseDuration } from '../journal-util.js';
import { loadDurable, projectDirOf } from '../runtime.js';
import { selectPrompt } from '../prompt.js';
import { bold, dim, green, yellow } from '../ansi.js';
import { resumeRunCore } from './resume.js';

/** The exit code while something blocks — a deploy script stops on it. */
export const PENDING_BLOCKS_EXIT = 2;
const WAIT_POLL_MS = 250;
/**
 * How long `--wait` waits for running work when `--timeout` is not given. A frozen holder (SIGSTOP, a
 * paused VM) is alive to every liveness and makes no progress; without a bound a deploy script waited
 * for it forever. Ten minutes is above a long agent run and well below a CI job's own limit.
 */
export const DEFAULT_WAIT_TIMEOUT = '10m';
/** How often `--wait` says it is still waiting (it reads the store every WAIT_POLL_MS). */
export const WAIT_PROGRESS_EVERY_MS = 15_000;

/** `--wait` and `--timeout <dur>` as `gnl pending` and `gnl upgrade` read them: the syntax of `gnl sweep --older-than`. */
export function waitOptionsOf(argv: string[]): { wait: boolean; timeoutMs: number; timeout: string } {
  const timeout = flag(argv, 'timeout') ?? DEFAULT_WAIT_TIMEOUT;
  return { wait: flagBool(argv, 'wait'), timeoutMs: parseDuration(timeout), timeout };
}

/** A duration as a person reads it back: the largest unit that divides it ('10m', '45s', '90m'). */
function durationText(ms: number): string {
  for (const [u, n] of [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000]] as const) if (ms >= n && ms % n === 0) return `${ms / n}${u}`;
  return `${ms}ms`;
}

const where = (i: { scope?: string; runId: string }) => (i.scope !== undefined ? `${i.scope}/${i.runId}` : i.runId);
const callName = (c: InDoubtCall) => `${c.toolName ?? '?'}${c.toolCallId ? ` [${c.toolCallId}]` : ''}`;

function render(p: PendingWork, notes: string[]): string[] {
  const out: string[] = [];
  if (p.inDoubt.length) {
    out.push(bold('in doubt — blocks') + dim('  a side-effecting call stopped without an outcome; its effect may have happened'));
    for (const c of p.inDoubt) out.push(`  ${where(c)}  ${callName(c)}  ${dim(`${c.status}, attempt ${c.attempts}${c.idempotencyKey ? `, key ${c.idempotencyKey}` : ''}`)}`);
  }
  if (p.running.length) {
    out.push(bold('running — blocks') + dim('  a live process is executing it'));
    for (const r of p.running) {
      const who = [r.holder !== undefined ? `held by ${r.holder}` : '', r.since !== undefined ? `since ${new Date(r.since).toISOString()}` : ''].filter(Boolean).join(', ');
      out.push(`  ${where(r)}  ${dim(r.what)}${who ? dim(`  (${who})`) : ''}`);
    }
  }
  if (p.awaitingApproval.length) {
    out.push(bold('awaiting approval — does not block') + dim('  the next version asks the same question'));
    for (const a of p.awaitingApproval) out.push(`  ${where(a)}${a.toolName ? `  ${a.toolName}${a.toolCallId ? ` [${a.toolCallId}]` : ''}` : ''}`);
  }
  out.push(...notes);
  if (!p.blocking) out.push(green('nothing blocks a shutdown or an upgrade'));
  return out;
}

const toolOf = (config: GnlDevConfig, c: InDoubtCall): { recover?: (input: unknown, o: { idempotencyKey: string; toolCallId: string }) => Promise<unknown> } | undefined => {
  const tools = c.agent ? (config.agents?.[c.agent] as { tools?: unknown } | undefined)?.tools : undefined;
  return tools && typeof tools === 'object' && c.toolName ? (tools as Record<string, never>)[c.toolName] : undefined;
};

export interface SettleOptions {
  /** Ask a person (a terminal). Without, nothing is asked. */
  interactive: boolean;
  /** Wait while only running work blocks. */
  wait: boolean;
  /** How long to wait (`--timeout`); when it passes, the list is returned as it stands, `timedOut`. Default 10m. */
  timeoutMs?: number;
  /** @internal — tests move time themselves. */
  clock?: { now(): number; sleep(ms: number): Promise<void> };
  /** Print nothing (a caller that prints the result itself). */
  quiet?: boolean;
}

/**
 * The flow `gnl pending` and `gnl upgrade` share: list, ask recover() about every call in doubt, let a
 * person decide what remains (interactive), wait for running work (`wait`), list again. Returns the
 * last list read — `blocking` is whether the shutdown or upgrade may go ahead.
 */
export async function settlePending(config: GnlDevConfig, d: typeof Durable, opts: SettleOptions): Promise<PendingWork & { timedOut?: true }> {
  if (typeof d.pendingWork !== 'function') throw new Error("gnl pending: this project's @gnldev/durable is older than the CLI — it has no pendingWork(). Upgrade @gnldev/durable.");
  const journal = getJournal(config, d) as unknown as Journal;
  // Whether a holder is alive is asked of its process — the store's liveness, as every process asks it.
  const storage = config.storage as { processLiveness?: () => Durable.ProcessLiveness | undefined | Promise<Durable.ProcessLiveness | undefined> } | undefined;
  // One per store (process-liveness.ts): made here only when nothing answers for this store yet, and then
  // ended here.
  const live = d.livenessFor(journal) ? undefined
    : await d.storeLiveness(journal, { own: () => storage?.processLiveness?.() }).catch(() => undefined);
  const log = (l: string) => { if (!opts.quiet) console.log(l); };
  const notes: string[] = [];
  const idOf = (c: InDoubtCall) => `${where(c)}#${c.key}`;
  const leftToItsVersion = new Set<string>(); // a person chose: the version that started it finishes it — blocks
  const safeToRerun = new Set<string>(); // recover() said it never happened — the run re-runs it — does not block
  const clock = opts.clock ?? { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
  const timeoutMs = opts.timeoutMs ?? parseDuration(DEFAULT_WAIT_TIMEOUT);
  const waitStarted = clock.now();
  let saidAt: number | undefined;
  let timedOut = false;
  try {
    for (;;) {
      const p = await d.pendingWork(journal);
      let acted = false;
      for (const c of p.inDoubt) {
        const id = idOf(c);
        if (leftToItsVersion.has(id) || safeToRerun.has(id)) continue;
        const r = await d.recoverInDoubt(journal, c, toolOf(config, c));
        if (r === 'happened') { notes.push(`${green('✓')} ${where(c)} ${callName(c)}: recover() found the effect — recorded as its result`); acted = true; continue; }
        if (r === 'moved') { acted = true; continue; }
        if (r === 'not-happened') { notes.push(`${green('✓')} ${where(c)} ${callName(c)}: recover() says it never happened — the run re-runs it, safely`); safeToRerun.add(id); continue; }
        if (!opts.interactive) continue;
        const choice = await selectPrompt([
          { id: 'done', label: 'It happened — record it as done', hint: 'your declaration is recorded with the result' },
          { id: 'cancel', label: 'Cancel the run' },
          { id: 'keep', label: 'Leave it — finish it with the version that started it', hint: 'the shutdown or upgrade waits' },
        ], { title: `${where(c)} ${callName(c)} — in doubt (${c.status}, attempt ${c.attempts})` });
        if (choice === 'done') {
          const by = process.env.USER ?? 'operator';
          if (await d.declareInDoubtDone(journal, c, { by })) notes.push(`${green('✓')} ${where(c)} ${callName(c)}: recorded as done (declared by ${by})`);
          acted = true;
        } else if (choice === 'cancel') {
          await d.cancelPendingRun(journal, c, 'canceled by an operator (gnl pending)');
          notes.push(`${yellow('•')} ${where(c)}: canceled`);
          acted = true;
        } else {
          leftToItsVersion.add(id);
        }
      }
      if (opts.interactive) {
        for (const r of p.running) {
          const choice = await selectPrompt([
            { id: 'wait', label: 'Wait for it' },
            { id: 'cancel', label: 'Cancel the run', hint: 'it stops at its next step or tool' },
          ], { title: `${where(r)} — ${r.what}` });
          if (choice === 'cancel') { await d.cancelPendingRun(journal, r, 'canceled by an operator (gnl pending)'); acted = true; }
        }
        for (const a of p.awaitingApproval) {
          if (!a.agent || !a.toolCallId) continue;
          const choice = await selectPrompt([
            { id: 'keep', label: 'Leave it waiting' },
            { id: 'reject', label: 'Reject it', hint: 'the run continues with the refusal' },
          ], { title: `${where(a)} ${a.toolName ?? ''} — awaiting approval` });
          if (choice === 'reject') { await resumeRunCore(config, d, a.runId, a.agent, { approvals: { [a.toolCallId]: false } }); acted = true; }
        }
      }
      if (acted) continue; // read again: a decision is never made on a list that may have moved
      // Blocking is what is left after recover() and the person: a call left to its version blocks.
      const settled: PendingWork = { ...p, inDoubt: p.inDoubt.filter((c) => !safeToRerun.has(idOf(c))) };
      settled.blocking = settled.inDoubt.length > 0 || settled.running.length > 0;
      const onlyRunning = settled.inDoubt.length === 0 && settled.running.length > 0;
      if (opts.wait && onlyRunning) {
        const now = clock.now();
        if (now - waitStarted < timeoutMs) {
          // Said when the wait starts and then every WAIT_PROGRESS_EVERY_MS — not at every read of the store.
          if (saidAt === undefined || now - saidAt >= WAIT_PROGRESS_EVERY_MS) {
            saidAt = now;
            log(dim(`waiting for ${settled.running.length} running…`));
          }
          await clock.sleep(Math.min(WAIT_POLL_MS, timeoutMs - (now - waitStarted)));
          continue;
        }
        // The bound passed: the list as it stands, blocking — the answer of the same call without --wait.
        timedOut = true;
        notes.push(yellow(`still running after ${durationText(timeoutMs)} (above). Nothing was canceled. Wait longer: --timeout 1h — or decide it in a terminal: gnl pending`));
      }
      if (!opts.quiet) for (const l of render(settled, notes)) console.log(l);
      return timedOut ? { ...settled, timedOut: true } : settled;
    }
  } finally {
    if (live) {
      d.unbindLiveness(journal);
      await live.close().catch(() => {});
    }
  }
}

export const pendingCommand: Command = {
  name: 'pending',
  group: 'operate',
  summary: 'What the store still has in hand: calls in doubt and running work block a shutdown or an upgrade; approvals do not',
  usage: 'gnl pending [--wait [--timeout 10m]] [--json] [--config gnl.config.ts]',
  async run(ctx) {
    const configPath = flag(ctx.argv, 'config') ?? 'gnl.config.ts';
    const json = flagBool(ctx.argv, 'json');
    const { wait, timeoutMs } = waitOptionsOf(ctx.argv); // a bad duration is refused before anything is read
    const config = await loadConfig(configPath);
    const d = await loadDurable(projectDirOf(configPath));
    const interactive = !json && Boolean(process.stdin.isTTY && process.stdout.isTTY);
    // The store this command opened is closed when it has answered, however it ends: an open Postgres
    // pool kept the process alive for its idle timeout (10 s) after the answer was printed.
    let p: Awaited<ReturnType<typeof settlePending>>;
    try {
      p = await settlePending(config, d, { interactive, wait, timeoutMs, quiet: json });
    } finally {
      await (config.storage as { close?: () => Promise<void> } | undefined)?.close?.().catch(() => {});
    }
    if (json) {
      const strip = <T extends object>(xs: T[]) => xs.map((x) => { const { record: _r, ...rest } = x as T & { record?: unknown }; return rest; });
      console.log(JSON.stringify({ blocking: p.blocking, ...(p.timedOut ? { timedOut: true } : {}), inDoubt: strip(p.inDoubt), running: strip<RunningWork>(p.running), awaitingApproval: strip<AwaitingApproval>(p.awaitingApproval) }, null, 2));
    }
    if (p.blocking) process.exitCode = PENDING_BLOCKS_EXIT;
  },
};
