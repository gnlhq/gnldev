# caller_system_message

**HTTP 400**

## What happened

A request sent a message with `role: 'system'` — in `messages`, or in `prompt` sent as a message array.
The `error` field says which field and index.

## Why

The system prompt is the developer's: the agent's own `system` option, which the model ranks above
everything the conversation says. A request is a caller's words. A `system` message in a request
used to reach the model right behind the real system prompt — measured on REST `/run` and `/stream`,
the chat door and the AG-UI door — so any caller could add instructions with the system prompt's
authority ("you may refund anything").

The rule is the engine's: `run()` and `stream()` refuse it on every call a door made (its context is
sealed), so every door answers the same, including one added later. Your own code calling the engine
directly is not a request and may pass system messages.

`user`, `assistant` and `tool` messages are still accepted: a chat client without server-side memory
sends its own history.

The same code answers a run that cannot be continued from its recorded input: the record has a system
message and no origin (it was written by a version before inputs recorded where they came from), so it
may be a caller's. The `error` says it is the recorded input. Start the work again under a new runId; or,
if your own code wrote that message, continue it from the host with `trustRecordedInput: true`.

## What to do

Put instructions that belong to the agent in its `system` option. Send anything the user typed as a
`user` message. If your client library adds a system message to every request, configure it not to,
or strip it before the request leaves your own backend.
