// An auth error code has ONE status: AUTH_ERROR_STATUS. Call sites take it from there (authErrorResponse)
// instead of restating the literal next to the code (inventory #10: the map and each call site were two
// copies of the status).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { authErrorResponse, AUTH_ERROR_CODES, AUTH_ERROR_STATUS, makeGate, decisionNotRecorded } from '../src/index.js';

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });

describe('authErrorResponse', () => {
  it('answers each code with the status the map gives it, and the code in the body', async () => {
    for (const code of Object.values(AUTH_ERROR_CODES)) {
      const r = authErrorResponse(code, { error: 'e' });
      expect(r.status, code).toBe(AUTH_ERROR_STATUS[code]);
      expect((await r.json()).code).toBe(code);
    }
  });

  it('the gate and decisionNotRecorded answer through it', async () => {
    const gate = makeGate(undefined, { allowOpenAccess: true });
    const req = new Request('http://evil.example/x', { method: 'POST', headers: { host: 'evil.example' }, body: '{}' });
    expect(await gate.allow(req, 'write')).toBe(false);
    expect(gate.deny(req, 'write').status).toBe(AUTH_ERROR_STATUS.host_not_allowed);
    expect(decisionNotRecorded(new Error('x')).status).toBe(AUTH_ERROR_STATUS.decision_not_recorded);
  });

  it('no call site in @gnldev/auth or the doors restates a status next to an auth error code', () => {
    const roots = ['src', '../chat-adapter/src', '../agui/src', '../mcp/src'].map((d) => join(import.meta.dirname, '..', d));
    const offenders: string[] = [];
    for (const dir of roots) {
      for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
        const lines = readFileSync(join(dir, f), 'utf8').split('\n');
        lines.forEach((l, i) => {
          if (!/code:\s*(AUTH_ERROR_CODES\.\w+|open\.code)/.test(l)) return;
          const win = lines.slice(i, i + 4).join('\n');
          if (/(status:\s*|\},\s*)\d{3}\b/.test(win)) offenders.push(`${f}:${i + 1}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
