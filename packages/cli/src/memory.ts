// DEFAULT memory for gnl dev/studio (the common "dev-server auto-provisioned LibSQL" pattern).
// @gnldev/durable and @gnldev/studio CANNOT import @gnldev/memory (cycle); this composition layer can.
// The 'chat' preset without embeddings → semantic recall is off, no API key required; thread/message/working-memory fully work.
// NOTE: dev memory requires a MemoryStore → config must supply `storage` (e.g. SqliteStorage) (journal is not enough).
// `mem` is the caller's already project-resolved @gnldev/memory module (see runtime.ts's loadMemory) —
// @gnldev/memory is an optional peer dependency of @gnldev/cli, resolved from the target project at runtime.
import type * as Memory from '@gnldev/memory';
import type { AgentMemory } from '@gnldev/memory';
import type { Storage, Journal } from '@gnldev/durable';

/** createGnl.memoryFactory: derives a writable Memory from storage (so Playground runs get written to a thread). */
export function devMemoryFactory(mem: typeof Memory): (storage: Storage | Journal) => AgentMemory {
  return (storage) => mem.memoryPreset(storage as Storage, 'chat');
}

/**
 * createStudioApp.memory — the 'chat' preset over `storage`, handed to Studio as it is. Studio's memory
 * type is picked from @gnldev/durable's `Memory`, which AgentMemory implements, so there is no adapter
 * left to keep in step: this used to forward each method by hand, and the forwarding is where a renamed
 * method got lost.
 */
export function devStudioMemory(mem: typeof Memory, storage: Storage): AgentMemory {
  return mem.memoryPreset(storage, 'chat');
}
