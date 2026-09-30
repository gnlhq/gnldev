# @gnldev/tool-schema

Tool schemas that one provider accepts and another rejects, smoothed over.

The same JSON Schema does not travel cleanly between OpenAI, Gemini and Anthropic: one rejects
`format` on strings, another dislikes certain nested constructs. This package rewrites a tool's
schema for the model actually being called.

## Install

> Install: `pnpm add @gnldev/tool-schema` — or use it from a [repo clone](https://github.com/gnlhq/gnldev): `pnpm install && pnpm -r build`.

```bash
npm i @gnldev/tool-schema
```

## Use

It is opt-in from `@gnldev/durable`:

```ts
import { defaultRules } from '@gnldev/tool-schema';

const gnl = createGnl({ ...config, schemaCompat: defaultRules });
// or per call: runDurable({ runId, journal, model, tools, schemaCompat: true, prompt })
```

Or directly:

```ts
import { applyToolCompat, detectModel, defaultRules } from '@gnldev/tool-schema';

const safe = applyToolCompat(tools, detectModel(modelId), defaultRules);
```

## Exports

| Export | What it is |
|---|---|
| `detectModel` | Model id → which provider family it belongs to |
| `applyToolCompat` | Applies the matching rules to a tool set |
| `shapeToolDefinitions` | The same rules on the AI SDK's converted tool list, for a model chosen at call time (what `@gnldev/durable` uses per fallback candidate) |
| `chainToolCompat` | Both halves for a model chosen at call time: `shape` (per candidate) and `tools` whose validators read an invited `null` back through what that candidate was sent |
| `ToolSchemaError` | A rule's refusal (e.g. `strict: true` with an open object under OpenAI); it propagates instead of skipping the rule |
| `defaultRules` | The bundled rule set (OpenAI / Gemini / Anthropic) |
| `ToolSchemaRule` | The rule interface — add your own for a provider not covered here. `transform(schema, model, ctx)`: a rule that widens a node to accept `null` as "not supplied" calls `ctx.nullMeansAbsent(node)` |

Rules are ordinary objects, so a provider the default set does not know about is a rule you write
rather than a fork you maintain.

## What the model is told changes; what the tool accepts does not

The rules rewrite the schema **sent to the model**. The tool still validates with its own schema:
zod checks, `.default()` and `.transform()` run as they do without this package, so `execute` receives
the same value with compat on or off, and invalid input never reaches it. A tool given as `jsonSchema()`
without a `validate` stays unvalidated, as it was.

## One thing the OpenAI rule changes that you will see

OpenAI's strict mode has no notion of an optional property: every key of an object must be listed in
`required`. So the rule lists them all — and widens the ones that **were** optional to also accept
`null`, which is the only way strict mode can express "not supplied":

```
z.object({ to: z.string(), cc: z.string().optional() })
→  required: ["to", "cc"],  cc: { type: ["string", "null"] }
```

Without the second half the parameter is silently promoted to mandatory. Under `strict: true` the
model then has no way to leave it out; without strict, `required` is still what it is told the tool
wants. Keys that were genuinely required are left alone.

When the model takes up that offer and sends `cc: null`, the tool reads it as `cc` left out: a `null`
at a key your schema does not require, and does not allow to be `null`, is removed before your
validator runs. A field you declared `.nullable()` keeps its `null`; a `null` at a required key is
still an error. The reading comes from the rule's own record of the nodes it widened, read off the
schema that was sent, so it holds inside unions (a `z.discriminatedUnion`, a `z.union` of objects,
arrays of either) and for a rule of your own that records through `ctx.nullMeansAbsent`.

An object you declared **open** (`z.record`, `.catchall()`, `z.looseObject`) stays open; every other
object gets `additionalProperties: false`. OpenAI accepts an open object on any tool that does not set
`strict: true`. Under `strict: true` OpenAI refuses one, so the rule throws a `ToolSchemaError` before
the model is called: declare the keys with `z.object`, or drop `strict` from the tool.

An `enum` gets `null` added to its **values** too, and a `const` is wrapped in `anyOf` rather than
widened in place — in both cases changing only `type` would leave a node whose type admits `null`
while its value constraint forbids it, which nothing can satisfy.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
