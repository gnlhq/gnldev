// The names of every options object @gnldev/workflow reads, each held to its parameter's type by the
// compiler (@gnldev/options `optionNames`): an option added to a type and not here fails typecheck. A
// name not listed is refused where the bag is read, naming the option it is closest to.
import { optionNames } from '@gnldev/options';

export const STEP_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./workflow.js').step>[2]>>()(['sideEffect', 'recover', 'claimTtlMs']);
export const WAIT_FOR_RESUME_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./workflow.js').waitForResume>[1]>>()(['validate', 'reason']);
export const CANCEL_WORKFLOW_RUN_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./workflow.js').cancelWorkflowRun>[2]>>()(['reason']);
export const LIST_WORKFLOW_RUNS_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./workflow.js').listWorkflowRuns>[1]>>()(['status']);
type W = import('./workflow.js').Workflow<any, any>;
export const LOOP_NAMES = optionNames<NonNullable<Parameters<W['loop']>[2]>>()(['id', 'maxIters']);
export const RUN_RESUMABLE_NAMES = optionNames<NonNullable<Parameters<W['runResumable']>[2]>>()(['maxSteps', 'resume', 'signal', 'workflowName']);
