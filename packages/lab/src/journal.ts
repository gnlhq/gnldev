// Reading a run's own record: its tool calls and the tokens its model steps used.
import { usageAndCostFromModelValue, type JournalReader } from '@gnldev/durable';
export { readerOf, type JournalSource } from '@gnldev/experiment';

/** The tools a run called, in order, and the tokens its model steps used. */
export async function usageOfRun(journal: JournalReader, runId: string): Promise<{ calls: string[]; inputTokens: number; outputTokens: number; firstInputTokens: number }> {
  const entries = await journal.readRun(runId);
  let inputTokens = 0, outputTokens = 0, firstInputTokens: number | undefined;
  const calls: string[] = [];
  for (const e of entries) {
    if (e.kind === 'tool' && typeof (e.value as { toolName?: unknown })?.toolName === 'string') calls.push((e.value as { toolName: string }).toolName);
    if (e.kind === 'model') {
      const u = usageAndCostFromModelValue(e.value);
      if (u) { inputTokens += u.inputTokens; outputTokens += u.outputTokens; firstInputTokens ??= u.inputTokens; }
    }
  }
  // The first model step's input: what asking only the next decision again takes.
  return { calls, inputTokens, outputTokens, firstInputTokens: firstInputTokens ?? 0 };
}
