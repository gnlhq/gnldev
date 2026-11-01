// A section with a low share is a candidate; it is called harmless only when removing it moves behaviour
// by no more than the noise of asking twice, and a control section shows the check can tell.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { createMockModel } from '../../durable/test/mock.js';
import { checkPrune } from '../src/index.js';

/** Looks the order up first only when the rules section is in its system prompt; tone changes nothing. */
const model = createMockModel(async (o: any) => {
  const system = JSON.stringify(o.prompt.filter((p: any) => p.role === 'system'));
  const usage = { inputTokens: 10, outputTokens: 1 };
  const calls = o.prompt.filter((p: any) => p.role === 'tool').length;
  if (calls === 0 && system.includes('look up')) return { content: [{ type: 'tool-call', toolCallId: 'l', toolName: 'lookup', input: '{}' }], finishReason: 'tool-calls', usage };
  if (!JSON.stringify(o.prompt).includes('"toolName":"replace"')) return { content: [{ type: 'tool-call', toolCallId: 'r', toolName: 'replace', input: '{}' }], finishReason: 'tool-calls', usage };
  return { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage };
});
const tools = {
  lookup: tool({ description: 'Look up', inputSchema: z.object({}), execute: async () => ({ ok: true }) }),
  replace: tool({ description: 'Replace', inputSchema: z.object({}), execute: async () => ({ ok: true }) }),
};

describe('a section is removed only when it is shown harmless', () => {
  it('tone: harmless; rules (the control): the check tells it apart', async () => {
    const r = await checkPrune({
      model, tools, prompts: ['It arrived broken.', 'The lamp is cracked.'], trials: 3,
      systemSections: { rules: 'Always look up an order first.', tone: 'Be brief.' }, remove: 'tone', control: 'rules',
    });
    expect(r.noise).toBe(0);
    expect(r.removed.distance).toBe(0);
    expect(r.harmless).toBe(true);
    expect(r.control!.distance).toBe(1);
    expect(r.controlSeparates).toBe(true);
    expect(r.runs).toBe(4 * 2 * 3);
    expect(r.failed).toBe(0);
  });

  it('removing a section that matters is not harmless', async () => {
    const r = await checkPrune({ model, tools, prompts: ['It arrived broken.'], trials: 2, systemSections: { rules: 'Always look up an order first.' }, remove: 'rules' });
    expect(r.harmless).toBe(false);
    expect(r.control).toBeUndefined();
  });

  it('a section that is not in the prompt is refused', async () => {
    await expect(checkPrune({ model, tools, prompts: ['x'], systemSections: { tone: 'Be brief.' }, remove: 'rules' })).rejects.toThrow(/'rules' is not one of the systemSections/);
  });
});
