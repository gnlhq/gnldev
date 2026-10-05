import { refuseUnknownNames, optionNames, type RemovedNames } from '@gnldev/options';
// The one refusal for an option written into a door's engine config (first argument) instead of its
// options (second), for every factory that takes the two: createRestApi, createChatRoute,
// createAguiRoute, createA2AServer. The config is read by the engine, which knows nothing of the
// door's options, so a misplaced one was ignored without a word — measured: `identify` in
// createChatRoute's config was never called and every request ran anonymously (200); `a2aSecret` in
// createRestApi's config served every route unsigned. TypeScript refuses the literal; plain
// JavaScript and a config assembled elsewhere did not.

//
// The same holds for a name in the options that is no option: a misspelled `authorise` left the door
// without its policy and every request ran (measured, 4 doors: 403 with the right name, 200 with the
// misspelled one). A name the door does not take is refused, with the option it is closest to.

/**
 * Options a door took once and no longer does, each with the sentence that says what replaced it.
 * @internal — a table of replacement sentences, not an options bag.
 */
export type RemovedDoorOptions = RemovedNames;

/**
 * The identity hooks the chat and AG-UI routes took before `identify`. Refused rather than ignored: a
 * JavaScript config (or one cast past the types) that still passes one would start every run ownerless.
 */
export const REMOVED_IDENTITY_OPTIONS: RemovedDoorOptions = {
  resolveResourceId: 'was removed: it handed the resolver the request body, the one place a subject must never come from. '
    + 'Use `identify: (req) => principal`, reading your session or a verified token.',
  identity: "was replaced by `identify` (0.7.0): it returns a Principal from @gnldev/auth — `{ kind: 'subject', id, orgId, roles: [] }` "
    + 'for an end user — so the route can tell a user from staff.',
};

/**
 * Throws naming each option of `factory` found in `config` and not in `opts`, and each name in `opts`
 * that is not an option of `factory`. `sharedWithConfig`: names a project's config legitimately
 * carries for another reader (gnl dev passes it whole). `removed`: former options, refused with what
 * replaced them.
 */
export function refuseMisplacedOptions(
  factory: string,
  config: unknown,
  opts: unknown,
  optionKeys: readonly string[],
  sharedWithConfig: ReadonlySet<string> = new Set(),
  removed: RemovedDoorOptions = {},
): void {
  const o = (opts ?? {}) as Record<string, unknown>;
  refuseUnknownNames(factory, o, optionKeys, removed);
  if (config === null || typeof config !== 'object') return;
  const c = config as Record<string, unknown>;
  const misplaced = optionKeys.filter((k) => !sharedWithConfig.has(k) && c[k] !== undefined && o[k] === undefined);
  if (!misplaced.length) return;
  const one = misplaced.length === 1;
  throw new TypeError(
    `${misplaced.map((k) => `\`${k}\``).join(', ')} ${one ? 'is an option' : 'are options'} of ${factory}, not of the engine config, and ${one ? 'was' : 'were'} given in the config (first argument), where nothing reads ${one ? 'it' : 'them'}. Pass ${one ? 'it' : 'them'} second: ${factory}(config, { ${misplaced.map((k) => `${k}: …`).join(', ')} }).`,
  );
}

/**
 * A door's option names, held to its options interface by the compiler: a name that is no option does
 * not typecheck, and an option left out names itself in the error (`missing`). One definition of the
 * pin, used by every door that calls `refuseMisplacedOptions`.
 *
 *   const KEYS = doorOptionKeys<MyDoorOptions>()(['identify', 'authorize']);
 */
export const doorOptionKeys = optionNames;

