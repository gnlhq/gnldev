# @gnldev/options

One rule for every options object GNL reads: a name it does not take is refused, with the option it is
closest to.

An options object read by name and never checked drops a misspelled name without a word. Measured
across the GNL packages before this rule: a misspelled `authorize` left a door without its policy, a
misspelled `guard` left an agent without its guard, `limits.maxToolCall` let a tool run past its limit,
and an SSO `issuer` written `isuer` accepted any issuer's token. Each now fails where the object is
read:

```
createChatRoute: `authorise` is not an option — did you mean `authorize`? Nothing would read it, so it would run without it.
```

You do not install this package: every GNL package that checks its options depends on it.

## For a package author

```ts
import { refuseUnknownNames, optionNames } from '@gnldev/options';

interface MyOptions { retries?: number; timeoutMs?: number }

// The list is held to the type by the compiler: a name that is no member, or a member left out, fails typecheck.
const NAMES = optionNames<MyOptions>()(['retries', 'timeoutMs']);

export function myThing(opts: MyOptions = {}) {
  refuseUnknownNames('myThing', opts, NAMES);
  // …
}
```

- `refuseUnknownNames(where, value, names, removed?)` — refuses any name not in `names`. `removed` maps a
  former option to the sentence that says what replaced it.
- `refuseMisspelledNames(where, value, names)` — for an object passed on to another library (GNL's
  `runDurable` passes the AI SDK's options to `generateText`): a name is refused only when it is a
  misspelling of a known one, so an option a newer version of that library adds still passes.
- `optionNames<T>()` / `variantNames<T>()` — the name list of an object type, or of every variant of a union.

A name set to `undefined` is no name: spreading an optional value is never refused. Only options bags are
checked — an implementation of an interface (a storage, a model, a provider) may carry members of its own.

## When a package's options change

Nothing has to be remembered: the compiler and `pnpm check:option-names` (CI) say what to update.

| Change | What fails | Fix |
|---|---|---|
| A field added to an options type | typecheck: the name list reports `missing: "<field>"` | add the name to the list |
| A field removed or renamed | typecheck: the list names a field the type no longer has | drop it; to say what replaced it, add the old name to the `removed` table |
| A new exported function, constructor, method or options type without the check | `check:option-names` | hand the bag to `refuseUnknownNames`, or tag gnl-internal plumbing `@internal — <why>` |
| A new gnl.config field for `gnl dev` | typecheck in `@gnldev/cli` (pinned both ways to `PROJECT_CONFIG_NAMES`) | add it to `PROJECT_CONFIG_NAMES` in `@gnldev/durable` |
| A newer AI SDK adds an option | nothing for the host: a name close to none passes on to the AI SDK; on upgrade, typecheck asks for the SDK's new names | add them to the AI SDK list |

One blind spot: a method of an object a factory returns (`createCache(...).set`) is held only by its
options type having a list — `check:option-names` cannot see that the method body reads it. Review
that call when adding such a method.
