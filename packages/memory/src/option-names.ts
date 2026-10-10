// The names of every options object @gnldev/memory reads, each held to its type by the compiler
// (@gnldev/options `optionNames`). A name not listed is refused where the bag is read, naming the
// option it is closest to: a misspelled `recall.topK` or `workingMemory.scope` would otherwise run the
// memory with its defaults and say nothing.
import { refuseUnknownNames, optionNames } from '@gnldev/options';
import type { MemoryConfig } from './agent-memory.js';
import type { MemoryPresetOptions } from './presets.js';
import type { WorkingMemoryConfig } from './working-memory.js';
import type { ObservationalMemoryConfig } from './observational.js';
import type { MigrateWorkingMemoryOptions, MigrateReservedRootThreadsOptions } from './migrate.js';

export const MEMORY_CONFIG_NAMES = optionNames<MemoryConfig>()(['storage', 'embed', 'recentN', 'recall', 'workingMemory', 'observationalMemory', 'generateTitle']);
export const MEMORY_PRESET_NAMES = optionNames<MemoryPresetOptions>()(['embed', 'workingMemory', 'observationalMemory']);
const RECALL_NAMES = optionNames<NonNullable<MemoryConfig['recall']>>()(['topK', 'threshold', 'messageRange', 'filter', 'scope', 'resourceId']);
export const WORKING_MEMORY_NAMES = optionNames<WorkingMemoryConfig>()(['schema', 'template', 'scope', 'readOnly']);
const OM_NAMES = optionNames<ObservationalMemoryConfig>()([
  'enabled', 'observerModel', 'reflectionModel', 'observation', 'reflection', 'scope', 'countTokens', 'buffering', 'onCompact', 'omVectors',
]);
const OM_OBSERVATION_NAMES = optionNames<NonNullable<ObservationalMemoryConfig['observation']>>()(['messageThreshold', 'tokenThreshold']);
const OM_REFLECTION_NAMES = optionNames<NonNullable<ObservationalMemoryConfig['reflection']>>()(['observationThreshold']);
const OM_VECTOR_NAMES = optionNames<NonNullable<ObservationalMemoryConfig['omVectors']>>()(['store', 'embed']);
export const MIGRATE_WM_NAMES = optionNames<MigrateWorkingMemoryOptions>()(['resourceIds', 'threadIds']);
export const MIGRATE_ROOT_THREADS_NAMES = optionNames<MigrateReservedRootThreadsOptions>()(['threadIds', 'rename', 'dryRun']);

/** The bags a memory config carries (AgentMemory's, and memoryPreset's which builds one). */
export function refuseMemoryBagNames(where: string, cfg: { recall?: unknown; workingMemory?: unknown; observationalMemory?: ObservationalMemoryConfig }): void {
  refuseUnknownNames(`${where}: recall`, cfg.recall, RECALL_NAMES);
  refuseUnknownNames(`${where}: workingMemory`, cfg.workingMemory, WORKING_MEMORY_NAMES);
  const om = cfg.observationalMemory;
  refuseUnknownNames(`${where}: observationalMemory`, om, OM_NAMES);
  refuseUnknownNames(`${where}: observationalMemory.observation`, om?.observation, OM_OBSERVATION_NAMES);
  refuseUnknownNames(`${where}: observationalMemory.reflection`, om?.reflection, OM_REFLECTION_NAMES);
  refuseUnknownNames(`${where}: observationalMemory.omVectors`, om?.omVectors, OM_VECTOR_NAMES);
}
type M = import('./agent-memory.js').AgentMemory;
export const GET_MESSAGES_NAMES = optionNames<NonNullable<Parameters<M['getMessages']>[1]>>()(['query', 'resourceId', 'scope']);
export const LOAD_CONTEXT_NAMES = optionNames<NonNullable<Parameters<M['loadContext']>[1]>>()(['query', 'resourceId', 'incoming']);
export const RECALL_OBSERVATIONS_NAMES = optionNames<NonNullable<Parameters<M['recallObservationsSemantic']>[2]>>()(['topK', 'threshold']);
export const CREATE_THREAD_NAMES = optionNames<NonNullable<Parameters<M['createThread']>[0]>>()(['id', 'resourceId', 'title', 'metadata']);
export const UPDATE_THREAD_NAMES = optionNames<NonNullable<Parameters<M['updateThread']>[1]>>()(['title', 'metadata']);
export const CLONE_THREAD_NAMES = optionNames<NonNullable<Parameters<M['cloneThread']>[1]>>()(['newThreadId', 'resourceId']);
export const DELETE_THREAD_NAMES = optionNames<NonNullable<Parameters<M['deleteThread']>[1]>>()(['allowInFlight']);
