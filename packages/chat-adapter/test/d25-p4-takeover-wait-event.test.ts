// d25 P4 / madde 19 (KARAR-6, secenek A): while a client waits for a dead process's run to be taken over
// (Postgres / MongoDB: ~5 s of reconnect grace), the stream tells it something. Today it hears nothing until
// the answer, and cannot tell "waiting for the takeover" from "hung".
//
// Real OS processes over a real Postgres (GNL_PG_URL; skipped without it). The harness records WHEN each
// piece of the response reached the client. /run answers once, as JSON — it has no stream to tell anything
// in, so it is not part of this item (stays as is: the full answer, after the wait).
//
// Pinned: the answer still arrives complete (the wait does not become an error); an informational frame —
// one that is neither the answer nor an error — reaches the client at least 1.5 s BEFORE the answer, on
// /stream, the chat surface and AG-UI; the takeover ran the tool exactly once more (recover says not done: crash 1 + takeover 1).
// NOT pinned (decision point: KARAR-6 gives `waiting-takeover` only as an example, "ör."): the frame's
// exact name / type / payload. The test recognises "informational" by exclusion: it is a data frame that is
// not part of the vocabulary a normal run of that door speaks.
import { describe, it, expect } from 'vitest';
import { crashThenServe, PG } from './d25-resume/drive.js';

type Chunk = { ms: number; text: string };
const NORMAL: Record<string, RegExp> = {
  stream: /^(start|step-start|step-finish|text|text-delta|text-start|text-end|tool-call|tool-result|tool-input|finish|done|error|interrupt|heartbeat)$/,
  chat: /^(start|start-step|finish-step|finish|text-start|text-delta|text-end|tool-input-start|tool-input-delta|tool-input-available|tool-output-available|tool-output-error|error|abort)$/,
  agui: /^(RUN_STARTED|RUN_FINISHED|RUN_ERROR|TEXT_MESSAGE_START|TEXT_MESSAGE_CONTENT|TEXT_MESSAGE_END|TOOL_CALL_START|TOOL_CALL_ARGS|TOOL_CALL_END|TOOL_CALL_RESULT|STEP_STARTED|STEP_FINISHED|CUSTOM:gnl\.step-start|CUSTOM:gnl\.step-finish|CUSTOM:gnl\.interrupt)$/,
};
/** The name a frame of this door goes by (event name, `type`), or undefined for a comment / non-frame. */
function frameName(door: string, raw: string): string | undefined {
  if (!/^data: /m.test(raw)) return undefined; // an SSE comment (":" heartbeat) is not an event
  if (door === 'stream') return /^event: (.*)$/m.exec(raw)?.[1];
  try { const d = JSON.parse(/^data: (.*)$/m.exec(raw)![1]); return d.type === 'CUSTOM' ? `CUSTOM:${d.name}` : d.type; } catch { return undefined; }
}

describe.skipIf(!PG)('d25 P4 #19 — a client waiting for a takeover is told it is waiting', () => {
  for (const door of ['stream', 'chat', 'agui']) {
    it(`${door}: an informational frame arrives during the wait, then the full answer`, () => {
      const { c, s } = crashThenServe({ DOOR: door }, { DOOR: door, WAIT_MS: '0' }, 'pg');
      expect(c.status).not.toBe(0); // killed inside the tool
      const r = s.lines.REDRIVE;
      const chunks: Chunk[] = r.chunks;
      const answerAt = chunks.find((k) => /paid/.test(k.text))?.ms ?? Infinity;
      const infos = chunks.flatMap((k) => k.text.split('\n\n').map((raw) => ({ ms: k.ms, name: frameName(door, raw) })))
        .filter((f) => f.name !== undefined && !NORMAL[door].test(f.name!));
      console.log(`[19 ${door}] status`, r.status, 'answer at', answerAt, 'ms; chunk times', JSON.stringify(chunks.map((k) => k.ms)), '; informational', JSON.stringify(infos));
      expect(r.status).toBe(200);
      expect(r.full).toMatch(/paid/);                    // the wait did not become an error
      expect(answerAt).toBeGreaterThan(2000);           // precondition: there WAS a wait to speak into
      expect(infos.length).toBeGreaterThan(0);
      expect(Math.min(...infos.map((f) => f.ms))).toBeLessThan(answerAt - 1500);
      // The crash process wrote its effect line before it died (1); the harness tool's recover() answers
      // {done:false}, so the takeover runs the tool once more (2) — by contract. Exactly 2 = taken over ONCE, not repeatedly.
      expect(s.lines.AFTER_REDRIVE.effects).toBe(2);
    }, 180_000);
  }
});
