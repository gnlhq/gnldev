// @vitest-environment jsdom
// The Lab's thread mode: a thread is sent from the Inspector's thread ledger; its turns are drawn on a
// timeline whose numbers are also in a table a screen reader reads; nothing can be run until what a
// right answer does is written down; the plan says what will be spent and when n is too small; the
// verdict is the rule's sentence, and every chart of the result carries its own table. The report is
// Markdown with the request that reproduces it.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n';
import { Lab } from '../src/views/Lab';
import { ThreadDetail } from '../src/views/inspector-thread';
import { threadReport, verdictText, overridesOf, defaultTurn, untestableText, ThreadResult } from '../src/views/lab-thread';
import i18n from '../src/i18n';
import { timelineFinding, pathsShown, shareOf } from '../src/views/lab-charts';
import type { LabThreadDiagnosis, LabThreadTurn } from '../src/api';
import { PANEL_ROUTES } from './lab-panel-fixtures';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const posts: Array<{ url: string; body: unknown }> = [];
const gets: string[] = [];
function stubFetch(routes: Record<string, unknown>) {
  routes = { ...PANEL_ROUTES, ...routes };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST') posts.push({ url: u, body: JSON.parse(String(init.body)) }); else gets.push(u);
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => u.includes(k));
    const value = key ? routes[key] : {};
    if ((init?.headers as Record<string, string> | undefined)?.accept === 'text/event-stream') {
      const bytes = new TextEncoder().encode(`event: done\ndata: ${JSON.stringify(value)}\n\n`);
      return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) };
    }
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => value };
  }));
}
function LocationProbe() { const l = useLocation(); return <div data-testid="location">{l.pathname + l.search}</div>; }
function wrap(node: React.ReactNode, at = '/lab') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter initialEntries={[at]}><QueryClientProvider client={qc}>{node}<LocationProbe /></QueryClientProvider></MemoryRouter>);
}

const plan = { arms: 2, comparisons: 3, alpha: 0.0167, targetDifference: 0.4, power: 0.8, trials: 4, plannedTrials: 31, detectableDifference: 0.9, eliminationPlays: 32, verificationPlays: 12, jointPlays: 4, totalPlays: 48, tokens: 10560, estimatedCostUsd: 0.0123, underpowered: true };
const turns: LabThreadTurn[] = [
  { turn: 1, runId: 'r1', status: 'completed', class: 'completed', modelSteps: 2, firstStepInputTokens: 800, layout: { status: 'present', layout: 'exact', memoryMessages: 0, notes: [] }, composition: { unit: 'characters', total: 100, labelled: true, bySource: { system: 40, wm: 30, turn: 30 } }, diagnosable: true },
  { turn: 2, runId: 'r2', status: 'failed', class: 'infrastructure', classReason: 'the provider refused the request (429)', modelSteps: 0, layout: { status: 'present', layout: 'exact', memoryMessages: 2, notes: [] }, diagnosable: false, whyNot: 'nothing in it says how the agent behaves: the provider refused the request (429)' },
  {
    turn: 3, runId: 'r3', status: 'completed', class: 'completed', modelSteps: 2, firstStepInputTokens: 1600, layout: { status: 'present', layout: 'exact', memoryMessages: 4, notes: [] },
    composition: { unit: 'characters', total: 400, labelled: true, bySource: { system: 40, wm: 30, recent: 300, turn: 30 } }, diagnosable: true,
    experiments: {
      suspects: [{ id: 'working memory', kind: 'wm', source: 'layout', preview: '# Working Memory\naddress: Izmir', intervention: 'wm-remove' }, { id: 'recent 1', kind: 'recent', source: 'layout', preview: 'Hello.', intervention: 'remove' }],
      absences: [{ id: 'restore:window', kind: 'window', turns: [1], at: 0, preview: 'My address is Ankara.' }], untestable: [], grouped: false, tokensPerPlay: 220, plan,
    },
  },
];
const arm = (id: string, label: string, passed: number, judged: number, extra: object = {}) => ({ id, intervention: 'remove', label, targets: [], passed, judged, undetermined: 0, failed: 0, rate: { value: judged ? passed / judged : null, low: 0, high: 1, n: judged }, paths: [{ calls: [{ toolName: 'createOrder', args: { address: passed ? 'Ankara' : 'Izmir' }, source: passed ? 'none' : 'recorded' }], count: judged, passed }], ...extra });
const diagnosis: LabThreadDiagnosis = {
  runId: 'r3', agent: 'shop', model: 'cheap', threadId: 't', turn: 3, expect: { calls: [{ toolName: 'createOrder', args: { address: 'Ankara' } }] },
  layout: turns[2]!.layout, composition: turns[2]!.composition!,
  elimination: { grouped: false, parts: [], shares: [{ part: 'working memory', share: -0.5, blame: 0.5, noise: 0.02 }, { part: 'recent 1', share: 0.01, blame: -0.01, noise: 0 }], plays: 32, failed: 0, undetermined: 0 },
  arms: [arm('baseline', 'the turn unchanged', 0, 4) as any, arm('wm-replace:working memory', 'the working memory replaced with the corrected text', 4, 4, { difference: { value: 1, low: 0.3, high: 1, n: 4 }, failed: 1 }) as any],
  comparisons: 2, z: 2.24, verdict: { kind: 'cause', arm: 'wm-replace:working memory', also: [], sentence: 'Cause: …' },
  untestable: [], plan, plays: 41, failed: 1, inputTokens: 9000, outputTokens: 900, costUsd: 0.011, priced: true, notes: [],
};
// The Improve tab shows the turn's explanation plan and its capsule beside the diagnosis: both are asked for.
const explainPlan = { runId: 'r3', agent: 'shop', parts: [], trials: 3, replays: 24, tokensPerReplay: 1000, estimatedTokens: 20000 };
const capsuleBase = { runId: 'r3', agent: 'shop', system: 'You are a shop agent.', tools: [], earlierMessages: 2, memoryMessages: 0, lastMessage: 'Ship it.', recordedCalls: [], tokensPerPlay: 1000 };
const routes = {
  '/capabilities': { lab: true },
  '/lab/plan': explainPlan,
  '/lab/capsule': capsuleBase,
  '/lab/thread-plan': { threadId: 't', model: 'cheap', total: 3, offset: 0, turns },
  '/lab/thread': diagnosis,
  '/lab/experiments': { items: [] },
  '/lab': { agents: ['shop'], models: ['cheap'] },
};

describe("what cannot be tested, in the reader's language", () => {
  it('a coded reason is said in Turkish; one without codes in the server\'s words', async () => {
    const t = i18n.getFixedT('tr', 'lab') as never;
    expect(untestableText(t, { candidate: 'memory (…)', reason: 'the run carries no memory layout', kind: 'memory', layoutReason: 'no-layout' }))
      .toBe("Test edilemedi — bellek (working memory, gözlemler, hatırlananlar, son mesajlar): run, bellek düzeni kaydedilmeye başlanmadan önce kaydedilmiş.");
    expect(untestableText(t, { candidate: 'x', reason: 'y', kind: 'processor-rows', rows: 2 })).toMatch(/2 satır çıkarılmış/);
    expect(untestableText(t, { candidate: 'x', reason: 'y', kind: 'memory', layoutReason: 'from-the-future' })).toMatch(/: y$/);
    expect(untestableText(t, { candidate: 'old server', reason: 'its words' })).toBe('Test edilemedi — old server: its words');
  });
});

describe('a guess, then the proof', () => {
  it('a guess the plays bore out says so, shows what it proposed, and that elimination did not run; one they did not is said too', () => {
    const verified: LabThreadDiagnosis = { ...diagnosis, elimination: { ...diagnosis.elimination, shares: [], plays: 0, skipped: true },
      guess: { parts: [{ part: 'working memory', correction: '# Working Memory\naddress: Ankara' }], verified: true, z: 2.2, arms: diagnosis.arms, verdict: diagnosis.verdict } };
    wrap(<ThreadResult d={verified} />);
    expect(screen.getByTestId('thread-guess-line').textContent).toMatch(/Guess: working memory — the plays bore it out[\s\S]*What it proposed for working memory:[\s\S]*address: Ankara[\s\S]*never the result by itself/);
    expect(screen.getByTestId('elimination-skipped')).toBeTruthy();
    cleanup();
    wrap(<ThreadResult d={{ ...diagnosis, guess: { parts: [{ part: 'turn 1' }], verified: false, z: 2.2, arms: [], verdict: { kind: 'not-found', sentence: 'x' } } }} />);
    expect(screen.getByTestId('thread-guess-line').textContent).toMatch(/Guess: turn 1 — the plays did not bear it out/);
    expect(screen.queryByTestId('elimination-skipped')).toBeNull();
  });
});

describe('the thread mode, pure', () => {
  it('the turn shown first, the overrides parsed, the timeline and the paths summed', () => {
    expect(defaultTurn(turns)).toBe('r3');
    expect(overridesOf('')).toEqual({ overrides: [] });
    expect(overridesOf('{"toolName":"lookup","output":{"a":1}}')).toEqual({ overrides: [{ toolName: 'lookup', args: {}, output: { a: 1 } }] });
    expect(overridesOf('[1]')).toEqual({ error: 'shape' });
    expect(overridesOf('{')).toEqual({ error: 'json' });
    const t = (k: string, o?: Record<string, unknown>) => `${k}${o ? JSON.stringify(o) : ''}`;
    expect(timelineFinding(turns, t)).toContain('figTimelineInfra{"turns":"2"}');
    expect(timelineFinding(turns, t)).toContain('figTimelineMemory{"turn":3,"pct":"83%"}');
    expect(shareOf(turns[2]!.composition).map((s) => s.source)).toEqual(['system', 'wm', 'recent', 'turn']);
    const many = { paths: [5, 4, 3, 2, 1].map((count) => ({ calls: [], count, passed: 0 })) };
    expect(pathsShown(many).map((p) => [p.label, p.count])).toEqual([['', 5], ['', 4], ['', 3], ['other', 3]]);
  });

  it('the verdict and the report come from the rule, with the request that reproduces it', () => {
    const t = (k: string, o?: Record<string, unknown>) => `${k}${o ? JSON.stringify(o) : ''}`;
    expect(verdictText(diagnosis, t)).toBe('verdictCause{"arm":"the working memory replaced with the corrected text","from":"0/4","to":"4/4"}');
    expect(verdictText({ ...diagnosis, verdict: { kind: 'indistinct', arms: ['baseline', 'wm-replace:working memory'], also: [], sentence: '' } }, t)).toContain('verdictIndistinct');
    const md = threadReport(diagnosis, t, { runId: 'r3', model: 'cheap', expect: diagnosis.expect, trials: 4, workingMemory: 'address: Ankara' });
    for (const h of ['reportVerdict', 'reportSuccess', 'reportArms', 'reportShapley', 'reportComposition', 'reportPaths', 'reportLimits', 'reportReproduce']) expect(md).toContain(h);
    expect(md).toContain('| the working memory replaced with the corrected text | 4/4 |');
    expect(md).toContain('"workingMemory": "address: Ankara"');
    expect(md).toContain('reportLimitN{"n":4,"d":"90%"}');
    // one denominator — the plays that ran — in the sentence and in the table; the judged-only figure last
    const stopped = { ...diagnosis, arms: [diagnosis.arms[0]!, { ...diagnosis.arms[1]!, undetermined: 2, bounds: { low: { value: 4 / 6, low: 0.3, high: 0.9, n: 6 }, high: { value: 1, low: 0.6, high: 1, n: 6 } } }] };
    expect(verdictText(stopped, t)).toContain('"to":"4/6"');
    expect(threadReport(stopped, t)).toContain('| the working memory replaced with the corrected text | 4/6 | 67%–100% |');
  });
});

describe('the thread mode says only what it measured', () => {
  const t = (k: string, o?: Record<string, unknown>) => `${k}${o ? JSON.stringify(o) : ''}`;
  it('a turn that ended in an error is named in the finding, from its own class as the ledger shows it', () => {
    const failed = turns.map((x, i) => (i === 0 ? { ...x, class: 'failed' as const } : x));
    expect(timelineFinding(failed, t)).toContain('figTimelineFailed{"turns":"1"}');
    // none failed, none judged: "none wrong" is not said — no right answer was given to judge by
    const quiet = turns.map((x) => ({ ...x, class: 'completed' as const, expected: undefined, composition: undefined }));
    expect(timelineFinding(quiet, t)).toBe(`figTimelineNoneUnjudged{"count":${turns.length}}`);
  });

  it('no change tested: "not tested", never "not found"', () => {
    expect(verdictText({ ...diagnosis, verdict: { kind: 'untested', untested: [], sentence: '' } }, t)).toBe('verdictUntestedNone');
    expect(verdictText({ ...diagnosis, verdict: { kind: 'untested', untested: ['wm-replace:working memory'], sentence: '' } }, t))
      .toBe('verdictUntestedArms{"arms":"the working memory replaced with the corrected text"}');
  });
});

describe('the Improve tab: one screen for a run and a thread', () => {
  it("a run of a thread opens on its own turn, the thread's turns above it, and says only that turn is played", async () => {
    stubFetch(routes);
    wrap(<Lab />, '/lab?runId=r1&threadId=t');
    expect(await screen.findByTestId('thread-strip')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turn 1' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('only-this-turn').textContent).toBe('Only turn 1 is played again; the turns after it do not change.');
    // why, then change — the expectation written once, above both
    expect(screen.getByTestId('step-why')).toBeTruthy();
    expect(screen.getByTestId('step-change')).toBeTruthy();
    expect(screen.getAllByTestId('capsule-expect')).toHaveLength(1);
    // another turn chosen on the strip: everything below follows it
    fireEvent.click(screen.getByRole('button', { name: 'Turn 3' }));
    await waitFor(() => expect(screen.getByTestId('only-this-turn').textContent).toMatch(/Only turn 3/));
  });

  it('a thread opens on its failed turn; a run of no thread has no strip, and says the proof needs one', async () => {
    stubFetch(routes);
    wrap(<Lab />, '/lab?threadId=t');
    await screen.findByTestId('thread-strip');
    expect(screen.getByRole('button', { name: 'Turn 3' }).getAttribute('aria-pressed')).toBe('true');
    cleanup();
    stubFetch(routes);
    wrap(<Lab />, '/lab?runId=solo');
    expect(await screen.findByTestId('no-thread-proof')).toBeTruthy();
    expect(screen.queryByTestId('thread-strip')).toBeNull();
    expect(screen.getByTestId('only-this-turn').textContent).toBe('Only this run is played again.');
  });

  it('a badge says what the Inspector sent: a run, or a thread — and nothing is asked to find one', async () => {
    stubFetch(routes);
    wrap(<Lab />, '/lab?runId=r1&threadId=t');
    expect((await screen.findByTestId('lab-selected-kind')).textContent).toBe('Run');
    expect(screen.getByTestId('lab-selected').textContent).toMatch(/r1.*of thread t/);
    cleanup();
    stubFetch(routes);
    wrap(<Lab />, '/lab?threadId=t');
    expect((await screen.findByTestId('lab-selected-kind')).textContent).toBe('Thread');
    expect(gets.some((u) => u.includes('/runs') || u.includes('/threads'))).toBe(false);
  });
});

describe('the thread mode', () => {
  it("the Inspector's thread ledger sends the thread to the Lab, only when the host has one", async () => {
    stubFetch({ '/threads/t/messages': [] });
    const runs = [{ runId: 'r1', status: 'completed', modelSteps: 1, toolCalls: 0 }] as any;
    wrap(<ThreadDetail threadId="t" runs={runs} metricsById={new Map()} caps={{ lab: true } as any} onOpenRun={() => {}} />, '/inspector');
    fireEvent.click(await screen.findByRole('button', { name: 'Open in Lab' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/lab?threadId=t'));
    cleanup();
    wrap(<ThreadDetail threadId="t" runs={runs} metricsById={new Map()} caps={{ lab: false } as any} onOpenRun={() => {}} />, '/inspector');
    expect(screen.queryByRole('button', { name: 'Open in Lab' })).toBeNull();
  });

  it('the timeline and the turn: every number in a table too; nothing runs before a right answer is written down', async () => {
    posts.length = 0;
    stubFetch(routes);
    wrap(<Lab />, '/lab?threadId=t');
    const timeline = await screen.findByTestId('chart-timeline');
    const rows = timeline.querySelectorAll('table.sr-only tbody tr');
    expect(rows).toHaveLength(3);
    expect(rows[1]!.textContent).toContain('infrastructure error');
    expect(timeline.querySelector('figcaption')!.textContent).toMatch(/Turns 2 ended before the model could be asked/);
    expect(screen.getByTestId('composition-table').textContent).toMatch(/recent messages300/);
    expect(screen.getByText(/turns 1 put back/)).toBeTruthy();
    // no expectation: the run button is disabled, and the page says why
    const run = screen.getByRole('button', { name: 'Diagnose' }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(screen.getByTestId('thread-needs-expect')).toBeTruthy();
    expect(screen.getByTestId('thread-underpowered').textContent).toMatch(/With 4 plays per arm only a difference of about 90% can be seen/);
    // a turn the provider refused says why it cannot be diagnosed
    fireEvent.click(screen.getByRole('button', { name: 'Turn 2' }));
    expect((await screen.findByTestId('thread-not-diagnosable')).textContent).toMatch(/the provider refused the request \(429\)/);
    expect(posts).toEqual([]);
  });

  it('a diagnosis: confirmed first, then the verdict, and each chart of the result with its own table', async () => {
    posts.length = 0;
    stubFetch(routes);
    wrap(<Lab />, '/lab?threadId=t');
    await screen.findByTestId('chart-timeline');
    fireEvent.change(screen.getByRole('textbox', { name: /Must call/ }), { target: { value: 'createOrder {"address":"Ankara"}' } });
    fireEvent.click(screen.getByLabelText('Try a corrected working memory'));
    fireEvent.change(screen.getAllByRole('textbox', { name: 'Try a corrected working memory' })[0]!, { target: { value: '# Working Memory\naddress: Ankara' } });
    const run = screen.getByRole('button', { name: 'Diagnose' }) as HTMLButtonElement;
    await waitFor(() => expect(run.disabled).toBe(false));
    fireEvent.click(run);
    expect(posts).toEqual([]);
    expect(await screen.findByText(/48 plays with cheap · at most [\d,]+ tokens · .* The turn's memory and your hypotheses are sent too/)).toBeTruthy();
    const buttons = await screen.findAllByRole('button', { name: 'Diagnose' });
    fireEvent.click(buttons[buttons.length - 1]!);
    await screen.findByTestId('thread-result');
    expect(posts).toEqual([{ url: expect.stringContaining('/lab/thread'), body: { runId: 'r3', model: 'cheap', expect: { calls: [{ toolName: 'createOrder', args: { address: 'Ankara' } }] }, workingMemory: '# Working Memory\naddress: Ankara', suggest: true, guess: true } }]);
    expect(screen.getByTestId('thread-verdict').textContent).toMatch(/Cause: the working memory replaced with the corrected text — the right answer went from 0\/4 unchanged to 4\/4\./);
    for (const id of ['chart-shapley', 'chart-forest', 'chart-paths']) {
      const fig = screen.getByTestId(id);
      expect(fig.tagName).toBe('FIGURE');
      expect(fig.querySelector('figcaption')!.textContent!.length).toBeGreaterThan(10);
      expect(fig.querySelectorAll('table.sr-only tbody tr').length).toBeGreaterThan(0);
    }
    expect(screen.getByTestId('chart-shapley').querySelector('table.sr-only')!.textContent).toMatch(/recent 1.*cannot be told apart from noise/);
    expect(screen.getByTestId('chart-forest').textContent).toMatch(/4\/4 \+1 errors/);
    // the plan was asked again with the hypothesis counted
    expect(gets.some((u) => u.includes('/lab/thread-plan') && u.includes('wm=1'))).toBe(true);
  });

  it('a blamed part only left out: the verdict says so, the box starts with the suggestion, and the correction goes with the next diagnosis', async () => {
    posts.length = 0;
    const notFound: LabThreadDiagnosis = {
      ...diagnosis, arms: [diagnosis.arms[0]!], verdict: { kind: 'not-found', sentence: '', uncorrected: ['recent 1'] },
      suggestions: [{ part: 'working memory', text: '# Working Memory\naddress: Ankara' }],
    };
    stubFetch({ ...routes, '/lab/thread': notFound });
    wrap(<Lab />, '/lab?threadId=t');
    await screen.findByTestId('chart-timeline');
    fireEvent.change(screen.getByRole('textbox', { name: /Must call/ }), { target: { value: 'createOrder {"address":"Ankara"}' } });
    const run = screen.getByRole('button', { name: 'Diagnose' }) as HTMLButtonElement;
    await waitFor(() => expect(run.disabled).toBe(false));
    fireEvent.click(run);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Diagnose' })).at(-1)!);
    await screen.findByTestId('thread-result');
    expect(screen.getByTestId('thread-verdict').textContent).toMatch(/But recent 1 was blamed and only left out/);
    const box = screen.getByTestId('thread-corrections');
    expect((within(box).getByRole('textbox', { name: 'What working memory should have said' }) as HTMLTextAreaElement).value).toBe('# Working Memory\naddress: Ankara');
    expect(within(box).getByText('suggested')).toBeTruthy();
    fireEvent.change(within(box).getByRole('textbox', { name: 'What recent 1 should have said' }), { target: { value: 'My address is Ankara.' } });
    fireEvent.click(within(box).getByRole('button', { name: 'Diagnose again with these corrections' }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Diagnose' })).at(-1)!);
    await waitFor(() => expect(posts).toHaveLength(2));
    // the person's text goes, the model is not asked again
    expect(posts[1]!.body).toMatchObject({ corrections: { 'working memory': '# Working Memory\naddress: Ankara', 'recent 1': 'My address is Ankara.' } });
    expect((posts[1]!.body as { suggest?: boolean }).suggest).toBeUndefined();
  });
});
