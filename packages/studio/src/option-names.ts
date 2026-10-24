// The names of every options object @gnldev/studio reads, each held to its parameter's type by the
// compiler (@gnldev/options `optionNames`): an option added to a type and not here fails typecheck. A
// name not listed is refused where the bag is read, naming the option it is closest to.
import { refuseUnknownNames, optionNames } from '@gnldev/options';
import { refuseBudgetLimitNames } from '@gnldev/durable';
import type { StudioApiOptions } from './server.js';

// `__fullScanEveryTicks` is no host's: a test-only knob for the dead-event scan (server.ts reads it untyped).
export const CREATE_STUDIO_API_NAMES = [...optionNames<import('./server.js').StudioApiOptions>()(['reader', 'resume', 'compensate', 'chat', 'gnl', 'memory', 'memoryFactory', 'workflows', 'workflowInputs', 'scorers', 'datasets', 'mcp', 'a2a', 'queue', 'events', 'deadEventScan', 'cache', 'vectors', 'workflowStore', 'users', 'userErasure', 'compileWorkflow', 'auth', 'allowOpenAccess', 'allowedHosts', 'allowCrossSite', 'org', 'evalGate', 'retention', 'budgets', 'modelSuggestions', 'alerts', 'regressionModel', 'otelExport', 'optimizer']), '__fullScanEveryTicks'] as const;
export const CREATE_STUDIO_ADMIN_NAMES = optionNames<NonNullable<Parameters<typeof import('./server.js').createStudioAdmin>[0]>>()(['apiBase']);
export const CREATE_STUDIO_APP_NAMES = optionNames<import('./server.js').StudioAppOptions>()(['apiBase', 'reader', 'resume', 'compensate', 'chat', 'gnl', 'memory', 'memoryFactory', 'workflows', 'workflowInputs', 'scorers', 'datasets', 'mcp', 'a2a', 'queue', 'events', 'deadEventScan', 'cache', 'vectors', 'workflowStore', 'users', 'userErasure', 'compileWorkflow', 'auth', 'allowOpenAccess', 'allowedHosts', 'allowCrossSite', 'org', 'evalGate', 'retention', 'budgets', 'modelSuggestions', 'alerts', 'regressionModel', 'otelExport', 'optimizer']);
export const CREATE_STUDIO_RUNNER_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./runner.js').createStudioRunner>[2]>>()(['toJsonSchema', 'toolExec']);
export const BASIC_AUTH_NAMES = optionNames<NonNullable<Parameters<typeof import('./auth.js').basicAuth>[0]>>()(['user', 'pass']);
type Bag<K extends keyof StudioApiOptions> = Exclude<NonNullable<StudioApiOptions[K]>, (...args: never[]) => unknown>;
const ORG_NAMES = optionNames<Bag<'org'>>()(['resolve']);
const RETENTION_NAMES = optionNames<Bag<'retention'>>()(['olderThanMs', 'keepSuspended', 'auditOlderThanMs', 'suspendedTtlMs', 'tombstones']);
const BUDGETS_NAMES = optionNames<Bag<'budgets'>>()(['default', 'perOrg']);
const ALERTS_NAMES = optionNames<Bag<'alerts'>>()(['webhook', 'timeoutMs']);
const EVAL_GATE_NAMES = optionNames<Bag<'evalGate'>>()(['datasetId', 'minAvg']);
const DEAD_EVENT_SCAN_NAMES = optionNames<Bag<'deadEventScan'>>()(['timeoutMs', 'queueWaitMs', 'queueDepth', 'maxAbandonedScans']);
const USER_ERASURE_NAMES = optionNames<Bag<'userErasure'>>()(['storage', 'erasers', 'memory', 'settleMs']);

/** The bags inside Studio's options, each by its own reader; a budget limit by the engine's. */
export function refuseStudioBagNames(where: string, o: StudioApiOptions): void {
  refuseUnknownNames(`${where}: org`, o.org, ORG_NAMES);
  refuseUnknownNames(`${where}: retention`, o.retention, RETENTION_NAMES);
  refuseUnknownNames(`${where}: budgets`, o.budgets, BUDGETS_NAMES);
  refuseBudgetLimitNames(`${where}: budgets.default`, o.budgets?.default);
  for (const [org, limit] of Object.entries(o.budgets?.perOrg ?? {})) refuseBudgetLimitNames(`${where}: budgets.perOrg.${org}`, limit);
  refuseUnknownNames(`${where}: alerts`, o.alerts, ALERTS_NAMES);
  refuseUnknownNames(`${where}: evalGate`, o.evalGate, EVAL_GATE_NAMES);
  refuseUnknownNames(`${where}: deadEventScan`, o.deadEventScan, DEAD_EVENT_SCAN_NAMES);
  refuseUnknownNames(`${where}: userErasure`, o.userErasure, USER_ERASURE_NAMES);
}
