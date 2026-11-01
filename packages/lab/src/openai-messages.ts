// A recorded conversation (AI SDK messages) in the OpenAI chat format, for an endpoint the lab calls
// itself (toolChoiceProbability). A tool call and its result keep the id that pairs them; a provider
// refuses one without the other.
import type { ModelMessage } from 'ai';

type Part = { type?: string; text?: string; toolCallId?: string; toolName?: string; input?: unknown; output?: unknown };

const textOfParts = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? (content as Part[]).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('') : '';

/** A tool result's output as the text the OpenAI format carries. */
function outputText(output: unknown): string {
  const o = output as { type?: string; value?: unknown } | undefined;
  if (o && typeof o === 'object' && 'value' in o) return typeof o.value === 'string' ? o.value : JSON.stringify(o.value);
  return typeof output === 'string' ? output : JSON.stringify(output ?? null);
}

/** @internal */
export function openAIMessagesOf(messages: readonly ModelMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'user') { out.push({ role: m.role, content: textOfParts(m.content) }); continue; }
    if (m.role === 'assistant') {
      const parts = (Array.isArray(m.content) ? m.content : []) as Part[];
      const calls = parts.filter((p) => p.type === 'tool-call').map((p) => ({
        id: p.toolCallId, type: 'function', function: { name: p.toolName, arguments: typeof p.input === 'string' ? p.input : JSON.stringify(p.input ?? {}) },
      }));
      const text = textOfParts(m.content);
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    if (m.role === 'tool') {
      for (const p of (Array.isArray(m.content) ? m.content : []) as Part[]) {
        if (p.type === 'tool-result') out.push({ role: 'tool', tool_call_id: p.toolCallId, content: outputText(p.output) });
      }
    }
  }
  return out;
}
