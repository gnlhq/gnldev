// `gnl upgrade` — brings the store a gnl.config names up to this version through `storage.upgrade()`.
// It lists first: a developer who types `gnl upgrade` should see what each step does before it runs,
// and can run only the ones they choose (`--only`).
import type { UpgradeReport } from '@gnldev/durable';
import type { Command } from './types.js';
import { flag, flagBool } from '../args.js';
import { loadConfig } from '../config.js';
import { loadDurable, projectDirOf, registerInstalledUpgradeSteps } from '../runtime.js';
import { bold, dim, yellow } from '../ansi.js';
import { settlePending, waitOptionsOf, PENDING_BLOCKS_EXIT } from './pending.js';

type Row = UpgradeReport['steps'][number];
const waitsFor = (s: Row) => typeof s.detail?.waits === 'string';
const unregistered = (s: Row) => s.detail?.notRegistered === true;

/** A step's detail as one line: the versions a package step reports first ("data v1 → package v2"), then the rest. */
function detailOf(s: Row): string {
  if (!s.detail) return '';
  const { waits: _w, notRegistered: _n, register: _r, by: _b, dataVersion, packageVersion, ...rest } = s.detail;
  const versions = dataVersion !== undefined || packageVersion !== undefined ? `data v${dataVersion ?? '?'} → package v${packageVersion ?? '?'}` : '';
  const more = Object.keys(rest).length ? JSON.stringify(rest) : '';
  const text = [versions, more].filter(Boolean).join('  ');
  return text ? dim(`  ${text}`) : '';
}

/** The report as `gnl upgrade` and `gnl doctor` print it. */
export function renderUpgrade(r: UpgradeReport): string[] {
  const out: string[] = [];
  const pad = Math.max(...r.steps.map((s) => s.name.length), 4);
  const line = (s: Row) => `  ${s.name.padEnd(pad)}  ${dim(s.description)}`;
  const ran = r.steps.filter((s) => s.ran);
  const failed = r.steps.filter((s) => s.failed);
  const skipped = r.steps.filter((s) => s.notAttempted);
  const missing = r.steps.filter(unregistered);
  const waiting = r.steps.filter((s) => s.pending && !s.ran && waitsFor(s));
  const pending = r.steps.filter((s) => s.pending && !s.ran && !s.failed && !s.notAttempted && !waitsFor(s) && !unregistered(s));
  const done = r.steps.filter((s) => s.pending === false && !s.ran);
  if (ran.length) { out.push(bold('ran')); for (const s of ran) out.push(`${line(s)}${detailOf(s)}`); }
  if (failed.length) { out.push(bold('failed')); for (const s of failed) out.push(`${line(s)}  ${s.failed!.message}`); }
  if (skipped.length) { out.push(bold('not attempted (after a failure)')); for (const s of skipped) out.push(line(s)); }
  if (pending.length) { out.push(bold(r.dryRun ? 'pending' : 'still pending')); for (const s of pending) out.push(`${line(s)}${detailOf(s)}`); }
  if (waiting.length) {
    out.push(bold('waits for older processes') + dim('  (run once every process of the earlier version is gone: gnl upgrade --only <step>)'));
    for (const s of waiting) out.push(`${line(s)}${detailOf(s)}`);
  }
  if (missing.length) {
    out.push(bold('not registered') + dim('  (a package found data its step has not moved, and no step for it is registered)'));
    for (const s of missing) out.push(`${line(s)}${detailOf(s)}`, `      add where the store is built:  ${s.detail!.register as string}`);
  }
  if (done.length) { out.push(bold('done')); for (const s of done) out.push(line(s)); }
  return out;
}

/** Whether the report calls for a failing exit: a step failed, or a package's debt has no registered step. */
const failsRun = (r: UpgradeReport) => r.steps.some((s) => s.failed || unregistered(s));

export const upgradeCommand: Command = {
  name: 'upgrade',
  group: 'operate',
  summary: 'Bring a store an earlier version wrote up to this one: lists the steps, runs the pending ones',
  usage: 'gnl upgrade [--list | --dry-run] [--only <step>[,<step>]] [--wait [--timeout 10m]] [--config gnl.config.ts]',
  async run(ctx) {
    const configPath = flag(ctx.argv, 'config') ?? 'gnl.config.ts';
    const { wait, timeoutMs } = waitOptionsOf(ctx.argv); // a bad duration is refused before anything is read
    const config = await loadConfig(configPath);
    const storage = config.storage;
    if (!storage) throw new Error('gnl upgrade needs `storage` in gnl.config — a journal-only deployment has no store to upgrade.');
    // The store is closed however the command ends — an open Postgres pool kept the process alive for
    // its idle timeout after the answer.
    try {
      if (typeof storage.upgrade !== 'function') {
        console.log(`${storage.name}: this store has no upgrade steps.`);
        return;
      }
      const d = await loadDurable(projectDirOf(configPath));
      // The packages the project has installed bring their steps; one the application already registered is not added twice.
      await registerInstalledUpgradeSteps(storage, d, projectDirOf(configPath));
      const onlyRaw = flag(ctx.argv, 'only');
      const only = onlyRaw ? onlyRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      const dryRun = flagBool(ctx.argv, 'list') || flagBool(ctx.argv, 'dry-run');
      // WHAT THE STORE HAS IN HAND first (gnl pending): a call in doubt, or work still running, would be
      // decided or continued by this version under its own code. The steps run only when nothing blocks.
      // A listing (--list / --dry-run) writes nothing and is not held back.
      //
      // A store in an earlier version's run-table format cannot be read by this version until its FORMAT
      // steps have run (RUN_STATUS_PENDING_MESSAGE) — and those steps move columns, they continue and decide
      // nothing. So they run first, then the store is read, then the rest waits on what it holds.
      //
      // Work in hand does not hold back a package's step that is safe beside the earlier version's
      // processes (not `afterOlderGone`): moving a queue's jobs while a deploy rolls is the point of it. A
      // call that would run anything else — a store step, or a step that waits for the earlier processes —
      // is held as before.
      if (!dryRun) {
        const plan = await storage.upgrade({ ...(only ? { only } : {}), dryRun: true });
        if (plan.steps.some((s) => s.name === 'run-status' && s.pending)) {
          // The store's format steps (@gnldev/durable `FORMAT_STEPS`, the one list) — of `only`, when given.
          const format = (only ?? d.FORMAT_STEPS).filter((n) => (d.FORMAT_STEPS as readonly string[]).includes(n));
          for (const l of renderUpgrade(await storage.upgrade({ only: format }))) console.log(l);
        }
        const willRun = plan.steps.filter((s) => s.pending && !waitsFor(s) && !unregistered(s));
        const online = willRun.length > 0 && willRun.every((s) => d.isPackageStep(s.name) && !s.afterOlderGone);
        if (!online) {
          const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
          const pending = await settlePending(config, d, { interactive, wait, timeoutMs });
          if (pending.blocking) {
            console.log('');
            console.log(yellow('Not upgraded further: work in hand blocks it (above). Do not start this version yet — decide it with `gnl pending`, or wait for it with `gnl upgrade --wait`.'));
            process.exitCode = PENDING_BLOCKS_EXIT;
            return;
          }
        }
      }
      // No `storage.init()` first: init is a process's boot, and a store whose `run-status` step is pending
      // refuses to boot — that refusal names this command. Every step reaches the store its own way.
      let report: UpgradeReport;
      try {
        report = await storage.upgrade({ ...(only ? { only } : {}), dryRun });
      } catch (e) {
        // The first failing step stopped the run; what ran, what failed and what was not tried is in the error.
        if (!(e instanceof d.UpgradeFailedError)) throw e;
        for (const l of renderUpgrade(e.report)) console.log(l);
        console.log('');
        console.log(yellow(e.message));
        process.exitCode = 1;
        return;
      }
      for (const l of renderUpgrade(report)) console.log(l);
      if (failsRun(report)) process.exitCode = 1;
      if (dryRun && report.steps.some((s) => s.pending)) {
        console.log('');
        console.log(yellow('Nothing was written.'));
        console.log(dim('Run them all:  gnl upgrade        One of them:  gnl upgrade --only <step>'));
      }
    } finally {
      await storage.close?.().catch(() => {});
    }
  },
};
