import type { AgentMessageContent } from "./agent-message-types.js";

const METADATA_KEY = "subagentTask";

/** What a subagent's first message carries beside its task text. */
export interface SubagentTaskMetadata {
  taskId: string;
  /** Who handed the job over, as the model reads it: a manager thread's
   *  title, a worker's feature, or "Your agent". */
  askedBy: string;
  /** Where its shell starts (its parent's), told to it before the task. */
  workingDir?: string;
  /** A page run whose end wakes its parent: started while it answered the
   *  user. Kept here, so a run that waits its turn keeps it over a restart. */
  wakesParent?: boolean;
}

export function subagentTaskMetadata(input: SubagentTaskMetadata): Record<string, unknown> {
  return { [METADATA_KEY]: {
    taskId: input.taskId, askedBy: input.askedBy,
    ...(input.workingDir ? { workingDir: input.workingDir } : {}),
    ...(input.wakesParent ? { wakesParent: true } : {})
  } };
}

export function subagentTaskOf(content: AgentMessageContent): SubagentTaskMetadata | null {
  if (content.type !== "text") return null;
  const raw = content.metadata?.[METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.taskId !== "string" || typeof r.askedBy !== "string" || !r.askedBy.trim()) return null;
  const workingDir = typeof r.workingDir === "string" && r.workingDir.trim() ? r.workingDir : undefined;
  return { taskId: r.taskId, askedBy: r.askedBy, ...(workingDir ? { workingDir } : {}), ...(r.wakesParent === true ? { wakesParent: true } : {}) };
}
