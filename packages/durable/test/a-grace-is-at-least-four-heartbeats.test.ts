// `reconnectGraceMs` is at least four of the liveness's `heartbeatMs`.
//
// The grace is the time a live process has to take its lock back after its session ends
// (a-cut-session-keeps-its-call). A proof of the session comes at most two heartbeats apart (a beat, and
// its answer within one more), and the bodies are told to stop half a grace after the last proof
// (a-silent-session-loss): under four heartbeats a healthy process would tell its bodies to stop, and one
// whose session was lost silently would be read as dead before it could know. `reconnectGraceMs: 0` was
// the old reading: 2 effects in 5 of 5 rounds (raporlar/2026-10-18-session-cut). Each factory refuses a
// shorter grace before it connects.
import { describe, it, expect } from 'vitest';
import { postgresLiveness } from '../src/process-liveness.js';
import { mysqlLiveness } from '../src/mysql-storage.js';
import { mongoLiveness } from '../src/mongo-storage.js';

const factories = [
  ['postgresLiveness', (o: { reconnectGraceMs?: number; heartbeatMs?: number }) => postgresLiveness({ connectionString: 'postgres://nobody@127.0.0.1:1/none', ...o })],
  ['mysqlLiveness', (o: { reconnectGraceMs?: number; heartbeatMs?: number }) => mysqlLiveness({ connectionString: 'mysql://nobody@127.0.0.1:1/none', ...o })],
  // No connection string: refused right after the grace check, rather than after a server-selection wait.
  ['mongoLiveness', (o: { reconnectGraceMs?: number; heartbeatMs?: number }) => mongoLiveness({ connectionString: '', ...o })],
] as const;

describe('reconnectGraceMs is at least 4 × heartbeatMs', () => {
  for (const [name, open] of factories) {
    it(`${name}: 0 is refused`, async () => {
      await expect(open({ reconnectGraceMs: 0 })).rejects.toThrow(/reconnectGraceMs must be at least 4 × heartbeatMs/);
    });
    it(`${name}: a grace under four heartbeats is refused`, async () => {
      await expect(open({ reconnectGraceMs: 3_999, heartbeatMs: 1_000 })).rejects.toThrow(/reconnectGraceMs must be at least 4 × heartbeatMs \(4000 ms\); got 3999/);
    });
    it(`${name}: a grace of exactly four heartbeats passes the check`, async () => {
      // Passes the option check and fails only on the unreachable server.
      await expect(open({ reconnectGraceMs: 4_000, heartbeatMs: 1_000 })).rejects.not.toThrow(/reconnectGraceMs/);
    });
  }
});
