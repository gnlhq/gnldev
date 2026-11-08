// The slot semaphore behind test/pg-connection-budget.setup.ts (read that file for the rule, the numbers and why).
// Plain CommonJS so it can ALSO run as a `--require` preload in the child processes a test spawns, which have no vitest.
'use strict';
const { createRequire } = require('node:module');
const { existsSync, readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');

/** Every distinct copy of node-postgres a package of this repository resolves (they are one under pnpm, but a second would escape the cap unseen). */
function pgModules() {
  const root = resolve(__dirname, '..');
  const seen = new Set();
  const out = [];
  for (const top of ['packages', 'examples']) {
    const dir = join(root, top);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      try {
        const path = createRequire(join(dir, name, 'package.json')).resolve('pg');
        if (!seen.has(path)) { seen.add(path); out.push(require(path)); }
      } catch { /* this package has no pg */ }
    }
  }
  return out;
}

/**
 * Gives every `pg.Client` of this process one of `limit` slots before it connects and takes the slot back when its socket ends.
 * `who()` names the file or fixture for the error. Returns the shared state; `state.limit` may be changed later (Infinity = no cap).
 */
function install(limit, waitMs, who, describeShare) {
  const state = { limit, held: 0, waiters: [] };
  const give = () => { state.held--; if (state.held < state.limit) state.waiters.shift()?.(); };
  const take = () => {
    if (state.held < state.limit) { state.held++; return Promise.resolve(); }
    return new Promise((ok, fail) => {
      const wake = () => { clearTimeout(timer); state.held++; ok(); };
      const timer = setTimeout(() => {
        const i = state.waiters.indexOf(wake);
        if (i >= 0) state.waiters.splice(i, 1);
        fail(new Error(
          `pg-connection-budget: ${who()} waited ${waitMs} ms for a Postgres connection and none came free. This process holds ${state.held} of its ${state.limit} (${describeShare}). `
          + 'Close stores/pools earlier here, or, if connection count is what it tests, list it in EXEMPT in test/pg-connection-budget.setup.ts with the reason.'));
      }, waitMs);
      state.waiters.push(wake);
    });
  };
  for (const pg of pgModules()) {
    const proto = pg.Client.prototype;
    if (proto.__gnlBudgeted) continue;
    proto.__gnlBudgeted = true;
    const connect = proto.connect;
    proto.connect = function (cb) {
      if (state.limit === Infinity || this.__budgeted) return connect.apply(this, arguments);
      this.__budgeted = true;
      let given = false;
      const release = () => { if (!given) { given = true; give(); } };
      this.once('end', release);
      const run = (done) => take().then(
        () => connect.call(this, (e) => { if (e) release(); done(e); }),
        (e) => { this.__budgeted = false; done(e); },
      );
      if (typeof cb === 'function') { void run(cb); return undefined; }
      return new Promise((ok, fail) => void run((e) => (e ? fail(e) : ok())));
    };
  }
  return state;
}

module.exports = { install };

// Preload mode (a spawned fixture): the parent's setup file put this file in NODE_OPTIONS and the cap in the environment.
if (process.env.GNL_TEST_PG_CHILD_LIMIT && (process.env.GNL_PG_URL || process.env.GNL_PG_ADMIN_URL || process.env.GNL_PGVECTOR_URL)) {
  const limit = Number(process.env.GNL_TEST_PG_CHILD_LIMIT);
  install(limit, 20_000, () => `fixture ${process.argv.slice(1, 3).join(' ')}`, `a spawned process; the setup file explains the child share`);
}
