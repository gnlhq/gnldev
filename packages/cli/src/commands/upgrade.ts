// `gnl upgrade` — brings the store a gnl.config names up to this version through `storage.upgrade()`.
// It lists first: a developer who types `gnl upgrade` should see what each step does before it runs,
// and can run only the ones they choose (`--only`).
import type { UpgradeReport } from '@gnldev/durable';
import type { Command } from './types.js';
import { flag, flagBool } from '../args.js';
import { loadConfig } from '../config.js';
import { loadDurable, projectDirOf } from '../runtime.js';
import { bold, dim, yellow } from '../ansi.js';
import { settlePending, waitOptionsOf, PENDING_BLOCKS_EXIT } from './pending.js';

/** The steps that put an earlier version's store into this version's format; they decide no run. */
const FORMAT_STEPS = ['run-status', 'schema'] as const;

/** The report as `gnl upgrade` and `gnl doctor` print it. */
export function renderUpgrade(r: UpgradeReport): string[] {
  const out: string[] = [];
  const pad = Math.max(...r.steps.map((s) => s.name.length), 4);
  const line = (s: UpgradeReport['steps'][number]) => `  ${s.name.padEnd(pad)}  ${dim(s.description)}`;
  const ran = r.steps.filter((s) => s.ran);
  const pending = r.steps.filter((s) => s.pending && !s.ran);
  const done = r.steps.filter((s) => s.pending === false && !s.ran);
  if (ran.length) { out.push(bold('ran')); for (const s of ran) out.push(`${line(s)}${s.detail ? dim(`  ${JSON.stringify(s.detail)}`) : ''}`); }
  if (pending.length) {
    out.push(bold(r.dryRun ? 'pending' : 'still pending'));
    for (const s of pending) out.push(`${line(s)}${s.detail ? dim(`  ${JSON.stringify(s.detail)}`) : ''}`);
  }
  if (done.length) { out.push(bold('done')); for (const s of done) out.push(line(s)); }
  return out;
}

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
      if (!dryRun) {
        const plan = await storage.upgrade({ ...(only ? { only: only as never } : {}), dryRun: true });
        if (plan.steps.some((s) => s.name === 'run-status' && s.pending)) {
          const format = (only ?? FORMAT_STEPS).filter((n) => (FORMAT_STEPS as readonly string[]).includes(n));
          for (const l of renderUpgrade(await storage.upgrade({ only: format as never }))) console.log(l);
        }
        const d = await loadDurable(projectDirOf(configPath));
        const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
        const pending = await settlePending(config, d, { interactive, wait, timeoutMs });
        if (pending.blocking) {
          console.log('');
          console.log(yellow('Not upgraded further: work in hand blocks it (above). Do not start this version yet — decide it with `gnl pending`, or wait for it with `gnl upgrade --wait`.'));
          process.exitCode = PENDING_BLOCKS_EXIT;
          return;
        }
      }
      // No `storage.init()` first: init is a process's boot, and a store whose `run-status` step is pending
      // refuses to boot — that refusal names this command. Every step reaches the store its own way.
      const report = await storage.upgrade({ ...(only ? { only: only as never } : {}), dryRun });
      for (const l of renderUpgrade(report)) console.log(l);
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
