// What a run's "which words" and "remove a section" panels are planned with, for tests about the rest of
// the Improve tab: one word, one section — the panels render and ask for nothing more.
export const WORDS_PLAN = { runId: 'r', agent: 'a', words: ['hi'], tools: ['createOrder'], tool: 'createOrder', method: 'sampled', samples: 5, subsets: 2, calls: 10, estimatedTokens: 100 };
export const PRUNE_PLAN = { runId: 'r', agent: 'a', sections: [{ id: 'system 1', kind: 'system', source: 'layout', preview: 'x' }], tools: [], arms: 3, runs: 30, estimatedTokens: 100 };
export const PANEL_ROUTES = { '/lab/words-plan': WORDS_PLAN, '/lab/prune-plan': PRUNE_PLAN };
