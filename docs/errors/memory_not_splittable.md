# memory_not_splittable

**HTTP 500**

## What happened

The request was bound to an organization — by the `org` option (`x-gnl-org`), or by an identity that
carries an `orgId` (`roleAuth({ client: { token, orgId } })`, an end-user token, an `identify()` that
returns one) — and the config's `memory` is an object that cannot be given that organization's own
partition:

- a hand-written `Memory` (it has no `forOrganization`);
- an `AgentMemory` built over a different storage than the config's `storage`;
- an `AgentMemory` subclass (it may keep state the framework cannot rebuild);
- a config with only a `journal`, which has no memory port to split.

`new AgentMemory({ storage })` over the config's own `storage` is split automatically: each
organization gets the same memory over its own partition, and this error does not occur.

## Why

One conversation store shared by every organization is keyed by a caller-chosen thread id, so naming
another organization's thread would read it. The alternative — serving the turn with memory quietly
off — is what this framework used to do under a `roleAuth` `orgId`: the startup banner said memory was
on, and nothing was ever stored. Both are refused. The status is 500 because the caller did nothing
wrong; the deployment's config needs changing.

Where the host already knows it serves organizations (`createRestApi(config, { org })`), the same error
is thrown at construction instead, so the deployment does not start.

The answer to the caller is deliberately generic (a message and this code): how the deployment is
configured is the operator's business, not the end user's. The sentence that names the fix is written
to the server log, once per refused request.

## What to do

Pass `memoryFactory` instead of `memory` — it is called with each organization's storage:

```ts
createGnl({ storage, memoryFactory: (s) => new AgentMemory({ storage: s }), agents })
```

or build `AgentMemory` over the config's own `storage`, or set `memory: false` for no conversation store.
