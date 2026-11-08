# approval_not_permitted

**HTTP 403**

## What happened

Somebody said yes to a question that asks for an authorised person's approval, and was not one. Nothing
was recorded in the journal and nothing ran: the question is still open, and an authorised person can
still answer it. The `detail` names the tool and the call.

## Why

A human gate asks one of two different questions. **confirm** ("are you sure?") is consent: the person
who asked for the work answers it, and an authorised person may answer it too. **approve** ("may this
happen?") is permission: only an authorised person says yes. A question the developer wrote as approve
(a guard returning `approve`, or `require-approval`; a tool declared with `approve`; a call that may
already have happened after a crash) must not be answered by the end user whose work it is, who could
otherwise grant it to themselves.

The rule has one owner, the engine, so every door answers it alike: REST `/run`, `/stream` and `/resume`,
the chat and AG-UI surfaces, A2A, Slack and Telegram, Studio. A **no** is always accepted.

## What to do

Answer it as an authorised person: an operator token, or the application server. The authorised people
are staff and the application's own server by default; with the `approvers` option of `createGnl` the
rule you write replaces that default (`fourEyes()` is a ready-made one: the approver must not be the
person who started the work). From your own code, a direct call that names only `resourceId` is the
requester; pass `caller: STAFF` for a staff answer. If you wanted the end user to be able to answer, ask
with `confirm` instead of `approve`.
