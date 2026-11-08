import { describe, it, expect } from 'vitest';
import { runTag, mintCallId, providerIdOf, isGnlCallId, sameCall, ownsLegacyMarker, markerIsMine, stepMinter, renameAnswerPart, restoreProviderIds } from '../src/call-identity.js';

describe('call identity rule', () => {
  it('mints <providerId>.gnl-<8 base36>-<step>-<index>, deterministic and run-specific', () => {
    const id = mintCallId('call_0', 'run-A', 2, 1);
    expect(id).toMatch(/^call_0\.gnl-[0-9a-z]{8}-2-1$/);
    expect(mintCallId('call_0', 'run-A', 2, 1)).toBe(id);
    expect(mintCallId('call_0', 'run-B', 2, 1)).not.toBe(id);
    expect(runTag('run-A')).toHaveLength(8);
  });
  it('round-trips, including ids with dots, colons and the Kimi shape', () => {
    for (const p of ['call_0', 'toolu_01AbC', 'functions.pay:0', 'a.b.c', 'x.gnl-notatag', '', 'with space', 'new\nline']) {
      const m = mintCallId(p, 'r', 0, 0);
      expect(isGnlCallId(m)).toBe(true);
      expect(providerIdOf(m)).toBe(p);
    }
  });
  it('an id GNL did not mint is returned as it is', () => {
    for (const p of ['call_0', 'functions.pay:0', '.gnl-', 'x.gnl-abcdefgh-1', 'x.GNL-abcdefgh-1-1', 'x.gnl-abcdefg-1-1']) {
      expect(isGnlCallId(p)).toBe(false);
      expect(providerIdOf(p)).toBe(p);
    }
  });
  it('sameCall needs both runs named and equal', () => {
    expect(sameCall({ runId: 'r', toolCallId: 'c' }, { runId: 'r', toolCallId: 'c' })).toBe(true);
    expect(sameCall({ runId: 'r2', toolCallId: 'c' }, { runId: 'r', toolCallId: 'c' })).toBe(false);
    expect(sameCall({ runId: 'r', toolCallId: 'c2' }, { runId: 'r', toolCallId: 'c' })).toBe(false);
    expect(sameCall({ toolCallId: 'c' }, { runId: 'r', toolCallId: 'c' })).toBe(false);
  });
  it('legacy ownership: hold, else proc, must equal the call\'s own record', () => {
    expect(ownsLegacyMarker({ hold: 'h1', proc: 'p1' }, { hold: 'h1' })).toBe(true);
    expect(ownsLegacyMarker({ hold: 'h1', proc: 'p1' }, { hold: 'h2', proc: 'p1' })).toBe(false);
    expect(ownsLegacyMarker({ proc: 'p1' }, { proc: 'p1' })).toBe(true);
    expect(ownsLegacyMarker({ proc: 'p1' }, { proc: 'p2' })).toBe(false);
    expect(ownsLegacyMarker({}, {})).toBe(false);
    expect(ownsLegacyMarker({ hold: 'h' }, undefined)).toBe(false);
    expect(ownsLegacyMarker({ hold: 'h' }, {})).toBe(false);
  });
  it('markerIsMine: named marker by sameCall, legacy by id AND stamp', () => {
    const me = { runId: 'r', toolCallId: 'c' };
    expect(markerIsMine({ firstRunId: 'r', firstToolCallId: 'c' }, me, undefined)).toBe(true);
    expect(markerIsMine({ firstRunId: 'other', firstToolCallId: 'c' }, me, { hold: 'h' })).toBe(false);
    expect(markerIsMine({ firstToolCallId: 'c', hold: 'h' }, me, { hold: 'h' })).toBe(true);
    expect(markerIsMine({ firstToolCallId: 'c', hold: 'h' }, me, { hold: 'x' })).toBe(false);
    expect(markerIsMine({ firstToolCallId: 'other', hold: 'h' }, me, { hold: 'h' })).toBe(false);
  });
  it('a step minter numbers distinct provider ids by first appearance and is stable inside the step', () => {
    const mint = stepMinter('r', 3);
    const a = mint('call_0'); const b = mint('call_1');
    expect(mint('call_0')).toBe(a);
    expect(a).toBe(mintCallId('call_0', 'r', 3, 0));
    expect(b).toBe(mintCallId('call_1', 'r', 3, 1));
    expect(mint(a)).toBe(a);
  });
  it('renames the id-bearing parts of an answer and nothing else, without mutating', () => {
    const mint = stepMinter('r', 0);
    const parts = [
      { type: 'tool-input-start', id: 'call_0', toolName: 'pay' },
      { type: 'tool-input-delta', id: 'call_0', delta: '{}' },
      { type: 'tool-input-end', id: 'call_0' },
      { type: 'tool-call', toolCallId: 'call_0', toolName: 'pay', input: '{}' },
      { type: 'tool-approval-request', approvalId: 'a', toolCallId: 'call_0' },
      { type: 'tool-result', toolCallId: 'call_0', toolName: 'x', result: 1 },
      { type: 'text-start', id: 'call_0' },
    ];
    const frozen = JSON.stringify(parts);
    const out = parts.map((p) => renameAnswerPart(p, mint)) as any[];
    expect(JSON.stringify(parts)).toBe(frozen);
    const g = mintCallId('call_0', 'r', 0, 0);
    expect([out[0].id, out[1].id, out[2].id, out[3].toolCallId, out[4].toolCallId, out[5].toolCallId]).toEqual(Array(6).fill(g));
    expect(out[4].approvalId).toBe('a');
    expect(out[6]).toBe(parts[6]);
  });
  it('restores provider ids in a prompt, copying, and returns the same array when nothing changed', () => {
    const g = mintCallId('call_0', 'r', 0, 0);
    const prompt = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: g, toolName: 'pay', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: g, toolName: 'pay', output: {} }, { type: 'tool-approval-response', approvalId: 'a', approved: true }] },
      { role: 'system', content: 'plain' },
    ];
    const frozen = JSON.stringify(prompt);
    const out = restoreProviderIds(prompt) as any[];
    expect(JSON.stringify(prompt)).toBe(frozen);
    expect(out[1].content[0].toolCallId).toBe('call_0');
    expect(out[2].content[0].toolCallId).toBe('call_0');
    expect(out[0]).toBe(prompt[0]);
    const raw = [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_0', toolName: 'p', input: {} }] }];
    expect(restoreProviderIds(raw)).toBe(raw);
  });
});
