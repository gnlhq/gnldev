// `gnl upgrade` — brings the store a gnl.config names up to this version through `storage.upgrade()`.
// It lists first: a developer who types `gnl upgrade` should see what each step does before it runs,
// and can run only the ones they choose (`--only`).
import type { UpgradeReport } from '@gnldev/durable';
import type { Command } from './types.js';
import { flag, flagBool } from '../args.js';
import { loadConfig } from '../config.js';
import { bold, dim, yellow } from '../ansi.js';

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
  usage: 'gnl upgrade [--list | --dry-run] [--only <step>[,<step>]] [--config gnl.config.ts]',
  async run(ctx) {
    const configPath = flag(ctx.argv, 'config') ?? 'gnl.config.ts';
    const config = await loadConfig(configPath);
    const storage = config.storage;
    if (!storage) throw new Error('gnl upgrade needs `storage` in gnl.config — a journal-only deployment has no store to upgrade.');
    if (typeof storage.upgrade !== 'function') {
      console.log(`${storage.name}: this store has no upgrade steps.`);
      return;
    }
    const onlyRaw = flag(ctx.argv, 'only');
    const only = onlyRaw ? onlyRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const dryRun = flagBool(ctx.argv, 'list') || flagBool(ctx.argv, 'dry-run');
    await storage.init?.();
    const report = await storage.upgrade({ ...(only ? { only: only as never } : {}), dryRun });
    for (const l of renderUpgrade(report)) console.log(l);
    if (dryRun && report.steps.some((s) => s.pending)) {
      console.log('');
      console.log(yellow('Nothing was written.'));
      console.log(dim('Run them all:  gnl upgrade        One of them:  gnl upgrade --only <step>'));
    }
    await storage.close?.();
  },
};
