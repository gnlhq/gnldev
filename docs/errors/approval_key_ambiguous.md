# approval_key_ambiguous

**HTTP 409**

## What happened

An approval was sent under a tool call's id as the PROVIDER issued it (`approvals: { call_0: true }`), and
more than one open question of the run carries that id. Nothing was recorded: the request was refused
whole, and the `detail` lists the candidates.

## Why

A provider may reuse a tool-call id from one model answer to the next (some number their calls `call_0`
in every answer), so its own id does not say which question a yes belongs to. GNL gives every call an id
of its own the moment the model's answer enters it (`call_0.gnl-<run tag>-<step>-<index>`); answering the
wrong one would approve work nobody was asked about.

## What to do

Answer with the interrupt's own `toolCallId` (the GNL id), one entry per question:
`approvals: { [interrupt.toolCallId]: true }`. The provider's id keeps working only while exactly one open
question carries it.
