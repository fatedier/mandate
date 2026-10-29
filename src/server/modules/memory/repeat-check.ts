import { DECISION_THRESHOLD } from "../manager-checks/answer.js";
import { judgeChoice, type JudgementCandidate, type JudgementChoice } from "../manager-checks/judge.js";
import { logError } from "../../platform/logger.js";
import type { MemoryManager } from "./manager.js";
import type { MemoryEntry, MemoryScope } from "./types.js";
import repeatPromptPath from "./prompts/memory-repeat-check.md" with { type: "file" };

/** Memory repeat check: does a memory extraction is about to store say
 *  anything the stored memories most like it do not? */
export type MemoryRepeatAnswer = "repeat" | "new";

export const MEMORY_REPEAT_CHOICE: JudgementChoice<MemoryRepeatAnswer> = {
  purpose: "memory_repeat_check",
  promptPath: repeatPromptPath,
  options: ["repeat", "new"],
  // Left out only when the model is sure: a memory wrongly dropped is lost,
  // a repeat wrongly kept is the dream's to merge.
  fromDecision: (probabilities) => ((probabilities.repeat ?? 0) >= DECISION_THRESHOLD ? "repeat" : "new")
};

/** How many stored memories a new one is read beside: the ones most like it. */
const SIMILAR_MEMORIES = 5;

/** What the judgement reads: the new memory, then the stored ones most like it. */
export function repeatCheckContext(content: string, similar: ReadonlyArray<Pick<MemoryEntry, "content">>): string {
  return [
    "New memory:",
    content,
    "",
    "Stored memories most like it:",
    ...similar.map((entry, k) => `${k + 1}. ${entry.content}`)
  ].join("\n");
}

/** Whether a memory about to be stored repeats one already stored in its
 *  scope (its project's, or the user's). It is read beside the preferences
 *  and knowledge most like it, never task records: those are a worker's
 *  history, and a memory left out for them would reach no brief. No model,
 *  nothing like it stored, a lookup that fails, or no answer: it is no
 *  repeat, and is stored. */
export async function repeatsStoredMemory(
  memory: MemoryManager,
  candidates: readonly JudgementCandidate[],
  input: { threadId: string; scope: MemoryScope; projectId: string | null; content: string }
): Promise<boolean> {
  if (candidates.length === 0) return false;
  let similar: MemoryEntry[];
  try {
    similar = (await memory.search({
      query: input.content,
      scope: input.scope,
      projectId: input.scope === "project" ? input.projectId : null,
      types: ["preference", "knowledge"],
      maxResults: SIMILAR_MEMORIES
    })).map((result) => result.entry);
  } catch (err) {
    logError(`memory repeat check for thread ${input.threadId}`, err);
    return false;
  }
  if (similar.length === 0) return false;
  const judged = await judgeChoice(candidates, {
    threadId: input.threadId,
    context: repeatCheckContext(input.content, similar),
    subject: { memory: input.content, similar: similar.map((entry) => entry.id) }
  }, MEMORY_REPEAT_CHOICE);
  if (judged?.answer !== "repeat") return false;
  // The dream may move, rewrite or archive a memory while the model is
  // asked: the answer stands only on memories that are still as it read them.
  if (await unchanged(memory, similar)) {
    // Which one it repeats, the answer does not say: each is noted with how alike.
    memory.recordUses(similar.map((entry, i) => ({ memoryId: entry.id, kind: "repeat", threadId: input.threadId, agent: null, rank: i + 1 })));
    return true;
  }
  judged.notUsed("memory_changed");
  return false;
}

/** Each memory still available at the version read. Both are compared: an
 *  edit stamps a new updatedAt, but archiving a project archives its memories
 *  at the wall clock's time, which can equal their last write's. A read that
 *  fails is a change. */
async function unchanged(memory: MemoryManager, read: readonly MemoryEntry[]): Promise<boolean> {
  try {
    const now = await Promise.all(read.map((entry) => memory.get(entry.id)));
    return now.every((entry, k) => entry?.status === "available" && entry.updatedAt === read[k]!.updatedAt);
  } catch {
    return false;
  }
}
