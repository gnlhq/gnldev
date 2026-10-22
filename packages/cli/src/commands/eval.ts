// gnl eval [files or dirs…] — runs `*.eval.ts` suites (`defineEval` from @gnldev/evals), prints each
// scorer's mean against its threshold, and exits 1 when one falls short: an eval gate for CI.
//
// Each invocation starts fresh. A case's result is memoized by case and scorers, not by the code that
// produced it, so replaying an earlier invocation's results would hide the very change a CI run is
// asking about. `--resume <id>` continues an invocation that was cut off (the id is printed at start).
import { readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as Evals from '@gnldev/evals';
import type { EvalDatasetResult, EvalSpec, EvalThresholdFailure } from '@gnldev/evals';
import type { Command } from './types.js';
import { flag, flagBool, positionals } from '../args.js';
import { resolveFromProject } from '../runtime.js';
import { bold, dim } from '../ansi.js';

const EVAL_FILE = /\.eval\.(ts|mts|js|mjs)$/;

/** The eval files under each path: a file as is, a directory searched (node_modules and dot-dirs skipped). */
export function findEvalFiles(paths: string[]): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    const st = statSync(p);
    if (st.isFile()) { out.push(resolve(p)); return; }
    for (const name of readdirSync(p).sort()) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const child = join(p, name);
      if (statSync(child).isDirectory()) walk(child);
      else if (EVAL_FILE.test(name)) out.push(resolve(child));
    }
  };
  for (const p of paths) walk(p);
  return [...new Set(out)];
}

export interface EvalFileOutcome {
  file: string;
  datasetId?: string;
  result?: EvalDatasetResult;
  thresholds?: EvalSpec['thresholds'];
  failures: EvalThresholdFailure[];
  /** The file could not be loaded or run at all. */
  error?: string;
}

/**
 * Runs every suite in `files` and holds each to its thresholds. Pure of the terminal: the command
 * prints what this returns. `scope` makes the memo this invocation's own (`<dataset>:<invocation>`).
 */
export async function evalCore(opts: { files: string[]; evals: typeof Evals; journal?: unknown; invocation: string }): Promise<{ outcomes: EvalFileOutcome[]; pass: boolean }> {
  const outcomes: EvalFileOutcome[] = [];
  for (const file of opts.files) {
    let spec: EvalSpec;
    try {
      const mod = (await import(pathToFileURL(file).href)) as { default?: EvalSpec };
      if (!mod.default) throw new Error('no default export — export default defineEval({ dataset, run, scorers, thresholds })');
      spec = opts.evals.defineEval(mod.default); // the same name check as at the definition
    } catch (e) {
      outcomes.push({ file, failures: [], error: (e as Error).message });
      continue;
    }
    try {
      const result = await opts.evals.evalDataset({
        dataset: spec.dataset, run: spec.run, scorers: spec.scorers,
        ...(spec.concurrency ? { concurrency: spec.concurrency } : {}),
        ...(opts.journal ? { journal: opts.journal as never, scope: `${spec.dataset.id}:${opts.invocation}` } : {}),
      });
      const { failures } = spec.thresholds ? opts.evals.checkEvalThresholds(result, spec.thresholds) : { failures: [] };
      outcomes.push({ file, datasetId: spec.dataset.id, result, thresholds: spec.thresholds, failures });
    } catch (e) {
      outcomes.push({ file, datasetId: spec.dataset.id, failures: [], error: (e as Error).message });
    }
  }
  return { outcomes, pass: outcomes.every((o) => !o.error && o.failures.length === 0) };
}

const meanOf = (t: unknown): number | undefined => (typeof t === 'number' ? t : (t as { mean?: number } | undefined)?.mean);

function print(outcomes: EvalFileOutcome[], cwd: string): void {
  for (const o of outcomes) {
    const head = `${o.error || o.failures.length ? '✗' : '✓'} ${relative(cwd, o.file)}${o.datasetId ? dim(`  ${o.datasetId}`) : ''}`;
    console.log(bold(head));
    if (o.error) { console.log(`    ${o.error}`); continue; }
    const r = o.result!;
    console.log(dim(`    ${r.cases.length} case(s)`));
    for (const [scorer, mean] of Object.entries(r.aggregate)) {
      const t = o.thresholds?.[scorer];
      const want = meanOf(t);
      const every = typeof t === 'object' ? t.every : undefined;
      const rule = [want !== undefined ? `mean ≥ ${want}` : '', every !== undefined ? `every ≥ ${every}` : ''].filter(Boolean).join(', ');
      console.log(`    ${scorer.padEnd(22)} ${mean.toFixed(3)}${rule ? dim(`  (${rule})`) : ''}`);
    }
    for (const f of o.failures) {
      const line = f.rule === 'missing' ? `${f.scorer}: no scorer by this name in the suite`
        : f.rule === 'case-error' ? `case ${f.caseId} did not finish: ${f.reason}`
          : f.rule === 'mean' ? `${f.scorer}: mean ${f.got!.toFixed(3)} < ${f.want}`
            : `${f.scorer}: case ${f.caseId} scored ${f.got!.toFixed(3)} < ${f.want}${f.reason ? ` — ${f.reason}` : ''}`;
      console.log(`    ✗ ${line}`);
    }
  }
}

export const evalCommand: Command = {
  name: 'eval',
  group: 'inspect',
  summary: 'Run *.eval.ts suites and fail when a scorer falls short of its threshold',
  usage: 'gnl eval [files or dirs…] [--journal .gnl/evals.db] [--resume <id>] [--json]',
  async run(ctx) {
    const cwd = process.cwd();
    const paths = positionals(ctx.argv, ['journal', 'resume']);
    const files = findEvalFiles(paths.length ? paths : ['evals']);
    if (files.length === 0) throw new Error('gnl eval: no *.eval.ts files found (default: ./evals). Write one with defineEval from @gnldev/evals.');
    const evals = (await resolveFromProject('@gnldev/evals', cwd)) as typeof Evals;
    const journalPath = resolve(flag(ctx.argv, 'journal') ?? '.gnl/evals.db');
    mkdirSync(dirname(journalPath), { recursive: true });
    const { SqliteStorage } = (await resolveFromProject('@gnldev/durable/sqlite', cwd)) as { SqliteStorage: new (path: string) => unknown };
    const { toJournal } = (await resolveFromProject('@gnldev/durable', cwd)) as { toJournal: (s: unknown) => unknown };
    const invocation = flag(ctx.argv, 'resume') ?? `e${Date.now().toString(36)}`;
    const json = flagBool(ctx.argv, 'json');
    if (!json) console.log(dim(`gnl eval ${invocation} — ${files.length} suite(s); continue a cut-off run with --resume ${invocation}`));
    const { outcomes, pass } = await evalCore({ files, evals, journal: toJournal(new SqliteStorage(journalPath)), invocation });
    if (json) console.log(JSON.stringify({ invocation, pass, outcomes: outcomes.map(({ file, ...o }) => ({ file: relative(cwd, file), ...o })) }, null, 2));
    else print(outcomes, cwd);
    if (!pass) process.exitCode = 1;
  },
};
