import { taskCommentMetadata } from "../../../shared/task-board.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { UpwardInbox } from "../agent/upward-inbox.js";
import { localTimeZone } from "../../platform/time/agent-time.js";
import type { TaskDetailDto, TaskEntryDto } from "../../../shared/api/task-board.js";
import { renderTaskBlock } from "./task-text.js";

/** How much of the task the comment's message carries; the rest is cut. */
const COMMENT_TASK_MAX_CHARS = 8_000;

/**
 * The owner wrote @<agent> in a task's comment: the personal agent is woken
 * now, with the comment and the task. A request, so it wakes; keyed by
 * task, so a second comment before it reads the first joins it.
 */
export function createTaskCommentPoster(deps: {
  inbox: Pick<UpwardInbox, "post">;
  agentStore: Pick<AgentStore, "getOrCreatePersonalThread">;
  agentName: () => string;
  timeZone?: () => string;
  now?: () => number;
}): (task: TaskDetailDto, entry: TaskEntryDto) => void {
  return (task, entry) => {
    const personal = deps.agentStore.getOrCreatePersonalThread();
    const block = renderTaskBlock(task, "personal", {
      timeZone: deps.timeZone?.() ?? localTimeZone(), now: deps.now?.() ?? Date.now(),
      agentName: deps.agentName(), max: COMMENT_TASK_MAX_CHARS
    });
    const text = `[Task comment] The user commented on "${task.title}" (${task.id}) and asked you to act:\n${entry.text}\n\n${block}`;
    deps.inbox.post({
      to: personal.id,
      key: `task:${task.id}`,
      kind: "request",
      source: "task-comment",
      sourceThreadId: null,
      // The chat shows the owner's words and the task; the model reads `text`.
      content: { type: "text", text, metadata: taskCommentMetadata({ taskId: task.id, text: entry.text }) }
    }).wake();
  };
}
