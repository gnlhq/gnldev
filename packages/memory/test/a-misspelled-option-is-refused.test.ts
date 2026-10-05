// Every options object @gnldev/memory reads refuses a name it does not take (@gnldev/options), in the
// config and in each bag inside it. Measured in this package's own tests before: an
// `observationalMemory: { model }` (the option is `observerModel`) ran observational memory with no
// observer model, and a `workingMemory: { enabled: true }` set nothing — both silently.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { AgentMemory, memoryPreset, migrateWorkingMemoryKeys, migrateReservedRootThreads, renderWorkingMemorySystem } from '../src/index.js';

const storage = () => new InMemoryStorage() as any;

describe('@gnldev/memory: a misspelled option is refused', () => {
  it.each([
    ['AgentMemory', () => new AgentMemory({ storage: storage(), recentn: 5 } as any), /AgentMemory: `recentn` .* did you mean `recentN`\?/],
    ['AgentMemory recall', () => new AgentMemory({ storage: storage(), recall: { topk: 3 } } as any), /AgentMemory: recall: `topk` .* did you mean `topK`\?/],
    ['AgentMemory workingMemory', () => new AgentMemory({ storage: storage(), workingMemory: { enabled: true } } as any), /AgentMemory: workingMemory: `enabled` is not an option/],
    ['memoryPreset observationalMemory', () => memoryPreset(storage(), 'chat', { observationalMemory: { model: {} } } as any), /memoryPreset: observationalMemory: `model` is not an option/],
    ['memoryPreset observation', () => memoryPreset(storage(), 'chat', { observationalMemory: { observation: { messageThreshhold: 3 } } } as any), /observationalMemory\.observation: `messageThreshhold` .* did you mean `messageThreshold`\?/],
    ['migrateWorkingMemoryKeys', () => migrateWorkingMemoryKeys(storage().memory, { resourceId: ['a'] } as any), /migrateWorkingMemoryKeys: `resourceId` .* did you mean `resourceIds`\?/],
    ['migrateReservedRootThreads', () => migrateReservedRootThreads(storage(), { dryrun: true } as any), /migrateReservedRootThreads: `dryrun` .* did you mean `dryRun`\?/],
    ['createThread', () => new AgentMemory({ storage: storage() }).createThread({ resourceID: 'u' } as any), /createThread: `resourceID` .* did you mean `resourceId`\?/],
    ['cloneThread', () => new AgentMemory({ storage: storage() }).cloneThread('t', { newThreadID: 'n' } as any), /cloneThread: `newThreadID` .* did you mean `newThreadId`\?/],
    ['updateThread', () => new AgentMemory({ storage: storage() }).updateThread('t', { titel: 'x' } as any), /updateThread: `titel` .* did you mean `title`\?/],
    ['getMessages', () => new AgentMemory({ storage: storage() }).getMessages('t', { scop: 'thread' } as any), /getMessages: `scop` .* did you mean `scope`\?/],
    ['recallObservationsSemantic', () => new AgentMemory({ storage: storage() }).recallObservationsSemantic('t', 'q', { topk: 2 } as any), /recallObservationsSemantic: `topk` .* did you mean `topK`\?/],
    ['renderWorkingMemorySystem', () => renderWorkingMemorySystem({}, { readonly: true } as any), /workingMemory: `readonly` .* did you mean `readOnly`\?/],
  ])('%s', async (_n, build, message) => {
    await expect((async () => build())()).rejects.toThrow(message);
  });
});
