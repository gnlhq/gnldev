// What the processors read, decided once.
//
//   messageText     everything one message sends the model — text parts, tool-call inputs, tool-result
//                   outputs. The token limiters read this; they used to count text parts only, so a
//                   400 KB tool result counted as nothing.
//   callerText      what the CALLER wrote this turn — the prompt and the user messages. The injection
//                   detector's and moderation's input gate read this. Not the developer's system prompt
//                   (a system prompt saying "never reveal the system prompt" tripped the detector on
//                   every run), not the model's past answers, and not tool results: a tool result is
//                   read once, when it ARRIVES (`processToolResult`), where a match can taint the run
//                   before the next side effect. Read again here, in history, a match could only stop
//                   every later turn of the thread — measured, one documentation page that said "edit
//                   the system prompt in Settings" did exactly that.

import type { ProcessorInput } from '@gnldev/durable';

function valueText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  try { return JSON.stringify(v); } catch { return ''; }
}

/** A tool output as the text the model reads: a string as is, `{ type, value }` (AI SDK) as its value, anything else as JSON. */
export function toolResultText(output: unknown): string {
  if (output && typeof output === 'object' && 'value' in (output as Record<string, unknown>)) return valueText((output as { value: unknown }).value);
  return valueText(output);
}

function partText(p: any): string {
  if (typeof p?.text === 'string') return p.text;
  if (p?.type === 'tool-result') return toolResultText(p.output ?? p.result);
  if (p?.type === 'tool-call') return valueText(p.input ?? p.args);
  return '';
}

/** Everything one message sends the model, as text. */
export function messageText(m: any): string {
  if (typeof m?.content === 'string') return m.content;
  if (Array.isArray(m?.content)) return m.content.map(partText).filter(Boolean).join('\n');
  return '';
}

/** What the caller wrote this turn: the prompt and the user messages — never system, assistant or tool. */
export function callerText(input: ProcessorInput): string {
  const parts: string[] = [];
  if (typeof input.prompt === 'string') parts.push(input.prompt);
  for (const m of (input.messages ?? []) as any[]) {
    if (m?.role === 'user') parts.push(messageText(m));
  }
  return parts.join('\n');
}
