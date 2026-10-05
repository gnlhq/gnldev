// The names of every options object @gnldev/scheduler reads, each held to its parameter's type by the
// compiler (@gnldev/options `optionNames`): an option added to a type and not here fails typecheck. A
// name not listed is refused where the bag is read, naming the option it is closest to.
import { optionNames } from '@gnldev/options';

export const SCHEDULE_WORKFLOW_INPUT_NAMES = optionNames<NonNullable<Parameters<typeof import('./index.js').scheduleWorkflow>[1]>>()(['id', 'name', 'input', 'at', 'every', 'cron', 'tz', 'maxAttempts', 'resourceId', 'caller', 'orgId', 'misfire', 'ifExists']);
export const POLL_SCHEDULER_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./index.js').pollScheduler>[3]>>()(['owner', 'retryMs', 'budgetGuard', 'lockTtlMs', 'runnerForOrg', 'onInvalidTime']);
export const CREATE_SCHEDULER_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./index.js').createScheduler>[2]>>()(['pollMs', 'owner', 'retryMs', 'backoff', 'maxPollMs', 'budgetGuard', 'lockTtlMs', 'runnerForOrg', 'onInvalidTime']);
export const MOVE_TRIGGER_TO_NAMES = optionNames<NonNullable<Parameters<typeof import('./index.js').moveTrigger>[2]>>()(['caller', 'resourceId', 'orgId']);
export const CREATE_WORKFLOW_WAKER_NAMES = optionNames<NonNullable<Parameters<typeof import('./workflow-waker.js').createWorkflowWaker>[0]>>()(['journal', 'resume', 'orgs', 'intervalMs', 'jitterMs', 'wakeEvented', 'onError']);
