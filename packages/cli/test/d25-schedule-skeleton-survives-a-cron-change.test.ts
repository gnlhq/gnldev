// d25 item 21: the file `gnl add schedule` / `gnl init --features schedule` writes must be true about re-registering.
//
// Measured on release/0.17.1: its comment says "the same id updates the definition ... so this file can run on every
// deploy". The scheduler's default (`ifExists: 'refuse'`) does the opposite for a CHANGED spec: boot crashes with
// "already scheduled with a different spec". Decision: the skeleton's own example call passes `ifExists: 'replace'`
// and its comment says what is true; the LIBRARY default stays 'refuse' (negative control below).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryJournal } from '@gnldev/durable';
import { scheduleWorkflow } from '@gnldev/scheduler';
import { scaffold } from '../src/scaffold.js';
import { RECIPES } from '../src/recipes.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The object literal the skeleton passes to scheduleWorkflow(journal, {...}) — comments inside it included. */
function skeletonCall(text: string): string {
  const start = text.indexOf('scheduleWorkflow(journal,');
  expect(start, 'the skeleton calls scheduleWorkflow(journal, {...})').toBeGreaterThan(-1);
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  throw new Error('unbalanced call');
}

function scaffoldedScheduleFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-sched-'));
  dirs.push(dir);
  scaffold(join(dir, 'app'), { features: ['schedule'] });
  return readFileSync(join(dir, 'app', RECIPES.schedule!.file), 'utf8');
}

describe('the schedule skeleton\'s example call', () => {
  it('passes ifExists: \'replace\' (an uncommented property of the call)', () => {
    const call = skeletonCall(scaffoldedScheduleFile());
    const live = call.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n').replace(/\/\/.*$/gm, '');
    expect(live).toMatch(/ifExists\s*:\s*['"]replace['"]/);
  });

  it('BEHAVIOUR: the skeleton\'s own spec, registered again with another cron, is accepted (a deploy that changes the cron boots)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const literal = skeletonCall(scaffoldedScheduleFile());
    // evaluate the literal exactly as written (its commented-out lines stay comments)
    const spec = new Function(`return (${literal});`)() as Record<string, unknown>;
    const j = new InMemoryJournal();
    await scheduleWorkflow(j as any, spec as any, 0);
    const changed = { ...spec, cron: '0 4 * * *' };
    await expect(scheduleWorkflow(j as any, changed as any, 0)).resolves.toBe(spec.id);
  });

  it('its comment no longer claims the same id "updates the definition" by default', () => {
    const text = scaffoldedScheduleFile();
    expect(text).not.toMatch(/same id updates the definition/);
    // and still says something about re-registering (the precondition: the comment was not simply deleted)
    expect(text).toMatch(/idempotent|re-?regist|every deploy/i);
  });

  it('every place the recipe text is exposed agrees (file contents and the printed wiring)', () => {
    const r: any = RECIPES.schedule;
    expect(JSON.stringify([r.contents ?? '', r.humanWire ?? ''])).not.toMatch(/same id updates the definition/);
  });
});

describe('NEGATIVE CONTROL: the library default does not change', () => {
  it('scheduleWorkflow with no ifExists still refuses a changed spec under an existing id', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const j = new InMemoryJournal();
    await scheduleWorkflow(j as any, { id: 'n', cron: '0 3 * * *', name: 'w' }, 0);
    await scheduleWorkflow(j as any, { id: 'n', cron: '0 3 * * *', name: 'w' }, 0); // same spec: no-op
    await expect(scheduleWorkflow(j as any, { id: 'n', cron: '0 4 * * *', name: 'w' }, 0)).rejects.toThrow(/different spec/);
  });
});
