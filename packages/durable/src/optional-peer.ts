import { createRequire } from 'node:module';

/**
 * Loads an optional peer dependency — a database driver (`pg`, `mysql2`, `mongodb`, `libsql`) or
 * `@gnldev/tool-schema` — by Node, when it is first used, and never by a bundler.
 *
 * Why it matters: a bundler resolves every require or import of a package name it can read at build
 * time. Measured on Next.js 16 (Turbopack), an App Router route that imported `@gnldev/durable` and ran on
 * memory failed `next build` with "Module not found: Can't resolve 'pg'" (twice) and
 * "'@gnldev/tool-schema'" — drivers the app never uses and never installed (raporlar/2026-10-21-frameworks).
 * A specifier the bundler cannot read, with its ignore hints, leaves the load to Node at run time, which
 * finds the driver in the app's node_modules when the app installed it.
 * @internal — storage adapter plumbing.
 */
export function requireOptionalPeer<T>(name: string): T {
  return createRequire(import.meta.url)(/* webpackIgnore: true */ /* turbopackIgnore: true */ name) as T;
}

/** `requireOptionalPeer` for an ES module (`import()`). @internal — storage adapter plumbing. */
export function importOptionalPeer<T>(name: string): Promise<T> {
  return import(/* webpackIgnore: true */ /* turbopackIgnore: true */ name) as Promise<T>;
}
