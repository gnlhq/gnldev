# run_unfinished

**HTTP 502**

## What happened

The model's stream ended without saying it finished, and nothing on this side stopped it — no cancel, no
release by a draining process, no timeout. The engine reads an ending from what the provider sent, so a
stream that simply stops is not taken as an answer. The run is recorded `failed` with this code, and the
text that streamed before the cut is in its event log.

What usually produces it is a stream cut between the model and the run: a provider or proxy that closed
the connection mid-answer, a socket reset, or a custom launch that returned early. The AI SDK does not
report these as failures — it gives a cut stream a `finish` of its own — so the engine reads the provider's
parts below it. A stream counts as cut when it has:

- no `finish` part at all, or the stream itself broke;
- `finishReason.unified === 'interrupted'` (from `@ai-sdk/openai` 4.0.100 and `@ai-sdk/anthropic` 4.0.86);
- `{ unified: 'other', raw: undefined }` with no usage, on a model that is not `v2` — what older adapters
  send when the body closes. A reason the provider named has `raw` set, and is an ending;
- an adapter's report that the stream ended without a finish reason (`@ai-sdk/openai-compatible`).

On `POST /agents/:name/run` this answers 502. On `/agents/:name/stream` the 200 is already sent: the `error`
event carries the code.

**What it does not catch.** A `v2` model's cut, when the adapter sends its default `finish`: the SDK's `v2`
bridge drops `raw` from every ending, so that cut reads like an ending and answers 200. A stream cut after a
proxy already sent usage, on an adapter older than `interrupted`, reads the same way.

**What can read as a cut that is not one.** A `v2` model behind `wrapLanguageModel` reports `v4`, so an
ending of its with an unrecognized reason and no usage is, to the byte, what an adapter sends for a cut. It
answers 502 on every attempt. Use the model unwrapped, or have it report usage.

## Why

**Not `completed`**, because the run has no evidence that the answer is whole. Calling a cut-off
answer complete would let the caller store half a reply as the reply, and nothing afterwards would
say otherwise.

**502 rather than 400**, because the request was fine. Before this code had a status it fell through
to the generic 400 — "your request was malformed" — and a client with retry logic reads 400 as "never
retry", exactly backwards. The cut happened upstream of the caller, which is what a bad gateway is.

## What to do

**Re-drive the same runId.** A failed run is not over: the same id starts it again, and the journal
replays every step that completed — a model call already recorded is not made again, and a durable
tool whose call was already claimed does not run a second time. The step that was cut has no answer on
record, so its model call is made again; if it got as far as a tool call, that call is on record and
replays instead, and the tool runs once. A fresh runId would re-run everything, including any tool call
that already had an effect.

**If it repeats on the same agent**, look at what sits between the model and the run: a proxy or
gateway with a response timeout shorter than the generation, an idle-connection cutoff, or a custom
launch that returns before its stream ends.

**If it repeats on every attempt against an OpenAI-compatible server**, check that the server sends a
`finish_reason`. A body that closes without one, even after `[DONE]`, reads as a cut and a retry gets the
same body. `[DONE]` does not settle it: the adapters do not report it, and servers also send it after a
failure. Fix the server or the gateway in front of it.

**The partial text is not lost.** It is in the run's event log (`gnl.follow`, or Studio's run view),
which is usually the fastest way to see how far the answer got before the cut.
