// What the chat route accepts, said before the AI SDK's converter is asked. `convertToModelMessages` throws
// its own TypeError on a shape it does not know ("Cannot read properties of undefined (reading 'some')"),
// which reached the client as the 400's message — accurate about the code, useless about the request. And a
// body in another wire shape that carried no `messages` at all ran an EMPTY turn and answered 200 with an
// error frame in the stream. Both are the caller sending the wrong body, so both are one clear 400.

const SHAPE = "useChat v5: { id, messages: [{ id, role: 'user', parts: [{ type: 'text', text: '…' }] }] }";

/** Why this body is not a chat request, or undefined when it is. Checks shape only — never content. */
export function chatBodyProblem(body: unknown): string | undefined {
  const b = body as { messages?: unknown; prompt?: unknown; message?: unknown } | null | undefined;
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return `the chat route takes a JSON object (${SHAPE})`;
  if (b.messages === undefined) {
    if (b.prompt !== undefined || b.message !== undefined) {
      return `this route reads \`messages\`, not \`${b.prompt !== undefined ? 'prompt' : 'message'}\` — send ${SHAPE}; for a single prompt use POST /agents/:name/run`;
    }
    return `\`messages\` is required (${SHAPE})`;
  }
  if (!Array.isArray(b.messages)) return `\`messages\` must be an array (${SHAPE})`;
  if (b.messages.length === 0) return `\`messages\` is empty — the chat route needs the conversation's last user message (${SHAPE})`;
  for (let i = 0; i < b.messages.length; i++) {
    const m = b.messages[i] as { role?: unknown; parts?: unknown; content?: unknown } | null;
    if (m === null || typeof m !== 'object') return `messages[${i}] must be an object (${SHAPE})`;
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') return `messages[${i}].role must be 'user', 'assistant' or 'system'`;
    if (!Array.isArray(m.parts)) {
      return m.content !== undefined
        ? `messages[${i}] has \`content\` but no \`parts\` array — this route takes the useChat v5 message shape, not {role, content} (${SHAPE})`
        : `messages[${i}] has no \`parts\` array (${SHAPE})`;
    }
  }
  return undefined;
}
