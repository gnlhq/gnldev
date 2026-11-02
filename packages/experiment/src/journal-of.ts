import { toJournal, type Journal, type JournalReader, type RunJournal, type Storage } from '@gnldev/durable';

/** What an experiment reads runs from: a store's `runs` (what runDurable is handed), the store, or a journal. */
export type JournalSource = RunJournal | Storage | (Journal & JournalReader);

/**
 * One reader over any of them. A store's `runs` lists runs through its own `listRuns(query)` and has no
 * `listRunsPaged`; `toJournal` is the bridge every host already uses to read it as a journal.
 */
export function readerOf(source: JournalSource): Journal & JournalReader {
  const s = source as Partial<Journal & JournalReader>;
  return typeof s.listRunsPaged === 'function' && typeof s.readRun === 'function' && typeof s.get === 'function'
    ? (source as Journal & JournalReader)
    : toJournal(source as RunJournal | Storage);
}
