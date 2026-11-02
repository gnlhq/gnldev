// @vitest-environment jsdom
// The hand-drawn lab charts on empty, NaN and null data: no throw, no NaN or Infinity in an SVG
// attribute, and a table a screen reader reads in every figure.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '../src/i18n';
import { TimelineChart, CompositionChart, ShapleyChart, ForestChart, PathsChart } from '../src/views/lab-charts';

afterEach(() => cleanup());
// Diagnostics, printed with GNL_TEST_VERBOSE=1.
const log = (...a: unknown[]) => void (process.env.GNL_TEST_VERBOSE && process.stdout.write(`AUDIT ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`));
const NaNi = { value: NaN, low: NaN, high: NaN, n: 0 };
const nullI = { value: null, low: null, high: null, n: 0 } as any;
const arm = (id: string, rate: any, diff?: any, extra: any = {}) => ({ id, intervention: id === 'baseline' ? 'baseline' : 'remove', label: id, targets: [], passed: 0, judged: 0, undetermined: 3, failed: 2, rate, ...(diff ? { difference: diff } : {}), paths: [], ...extra });

const cases: Record<string, () => JSX.Element> = {
  timelineEmpty: () => <TimelineChart turns={[]} onSelect={() => {}} />,
  timelineOdd: () => <TimelineChart turns={[{ turn: 1, runId: 'r', status: 'failed', class: 'infrastructure', modelSteps: 0, layout: { status: 'absent', reason: 'no-record', detail: 'x' }, diagnosable: false } as any, { turn: 2, runId: 'r2', status: 'completed', class: 'completed', modelSteps: 1, firstStepInputTokens: NaN, composition: { unit: 'characters', total: 0, labelled: true, bySource: {} }, layout: { status: 'none' }, diagnosable: true } as any]} onSelect={() => {}} />,
  compositionUndef: () => <CompositionChart composition={undefined} turn={1} />,
  compositionZero: () => <CompositionChart composition={{ unit: 'characters', total: 0, labelled: false, bySource: {} } as any} turn={1} />,
  shapleyNull: () => <ShapleyChart shares={[{ part: 'a', blame: null as any, noise: null }]} />,
  shapleyEmpty: () => <ShapleyChart shares={[]} />,
  shapleyNaN: () => <ShapleyChart shares={[{ part: 'a', blame: NaN, noise: null }, { part: 'b', blame: Infinity, noise: NaN as any }]} />,
  forestNaN: () => <ForestChart arms={[arm('baseline', NaNi), arm('x', NaNi, NaNi)]} finding="f" />,
  forestNull: () => <ForestChart arms={[arm('baseline', nullI), arm('x', nullI, nullI)]} finding="f" />,
  forestEmpty: () => <ForestChart arms={[]} finding="f" />,
  pathsEmpty: () => <PathsChart arms={[]} />,
  pathsNoCalls: () => <PathsChart arms={[arm('baseline', NaNi, undefined, { paths: [{ calls: [], count: 0, passed: 0 }] })]} />,
};

describe('lab charts on degenerate data', () => {
  for (const [name, el] of Object.entries(cases)) {
    it(name, () => {
      const errors: string[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(String(a[0]).slice(0, 140)); });
      let threw: unknown;
      try { render(el()); } catch (e) { threw = e; }
      spy.mockRestore();
      const html = document.body.innerHTML;
      const nanAttr = /="[^"]*NaN[^"]*"/.test(html) || /="[^"]*Infinity[^"]*"/.test(html);
      const figures = document.querySelectorAll('figure').length, tables = document.querySelectorAll('figure table').length;
      log('chart', name, { threw: threw ? String(threw).slice(0, 140) : null, errors: errors.slice(0, 1), nanAttr, figures, tables, text: (document.body.textContent ?? '').slice(0, 120) });
      expect(threw).toBeUndefined();
      expect(nanAttr).toBe(false);
      if (figures) expect(tables).toBe(figures);
    });
  }
});
