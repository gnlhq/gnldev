# thread_id_reserved

**HTTP 400**

## What happened

A request served in the **root scope** (no organization bound to the caller) named a thread whose id
starts with `org:`. Nothing was read, run or written.

## Why

Organizations' threads live in the same store as the root's, under `org:<id>:<threadId>` — that
prefix is how `withOrgStorage` keeps them apart. A thread id is chosen by the client, so a root-scope
caller that could use `org:acme:t-1` would read acme's thread by name, and one that sent
`org:acme:new` would create a conversation inside acme's partition. ADR-0001: in the root scope,
every organization's rows are hidden — including when the caller names one.

Measured before this refusal: a root-scope end user who posted `threadId: 'org:acme:fresh'` got
acme's stored message in the prompt sent to the model.

An organization's request is not affected: its thread ids are prefixed by its own view, so an acme
user may call a thread `org:notes` and it is stored as `org:acme:org:notes`.

## What to do

- **Pick a thread id that does not start with `org:`** (`organization-notes`, `Org:x` and `my-org:1`
  are all fine — only the exact `org:` prefix is reserved).
- **To work with an organization's threads**, make the request as that organization: an identity
  bound to it (`orgId` on the principal), or your deployment's organization resolver. In code, build
  the memory over `withOrgStorage(storage, orgId)`.
- A root-scope `AgentMemory` refuses the same ids with `ReservedThreadIdError`, so doors without this
  check (the standalone chat and AG-UI routes) fail closed rather than serve the thread.
