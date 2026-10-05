// The names of every options object @gnldev/cli reads, each held to its parameter's type by the
// compiler (@gnldev/options `optionNames`): an option added to a type and not here fails typecheck. A
// name not listed is refused where the bag is read, naming the option it is closest to.
import { optionNames } from '@gnldev/options';
import { PROJECT_CONFIG_NAMES, type CreateGnlConfig } from '@gnldev/durable';
import type { GnlDevConfig } from './config.js';

export const DEFINE_CONFIG_NAMES = optionNames<NonNullable<Parameters<typeof import('./config.js').defineConfig>[0]>>()(['port', 'studio', 'title', 'subjects', 'surfaces', 'auth', 'license', 'licensePublicKey', 'licenseStrict', 'storage', 'journal', 'agents', 'tools', 'memory', 'memoryFactory', 'processors', 'workflows', 'networks', 'checkSuiteConsistency', 'schemaCompat', 'preset', 'suggestions', 'replayDisclosure']);
export const SCAFFOLD_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./scaffold.js').scaffold>[1]>>()(['name', 'template', 'features', 'answers', 'e2e', 'host', 'hostMode']);

/**
 * gnl.config's own names beside the engine's, held BOTH ways to @gnldev/durable's PROJECT_CONFIG_NAMES:
 * createGnl takes exactly that list beside its own, so a dev option added here and not there would make
 * every scaffolded app (which hands createGnl the whole file) refuse to start — that fails this line's
 * typecheck instead.
 */
void optionNames<Omit<GnlDevConfig, keyof CreateGnlConfig>>()(PROJECT_CONFIG_NAMES);
