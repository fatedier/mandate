import type { MemoryManager } from "../../src/server/modules/memory/manager.js";
import type { MemoryEntry, MemoryUpdateInput } from "../../src/server/modules/memory/types.js";

type Writer = Pick<MemoryManager, "writeIfUnchanged">;

/** A change to a stored memory, written the way every write is: in a
 *  transaction, here one that checks nothing first. */
export async function updateMemory(memory: Writer, input: MemoryUpdateInput): Promise<MemoryEntry> {
  return (await memory.writeIfUnchanged([], (tx) => tx.update(input)))!;
}

/** A stored memory archived, the same way. */
export async function archiveMemory(memory: Writer, id: string, metadata?: Record<string, unknown>): Promise<MemoryEntry> {
  return (await memory.writeIfUnchanged([], (tx) => tx.archive(id, metadata)))!;
}
