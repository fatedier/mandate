import type { BackgroundTaskStore } from "../modules/agent/background-task-store.js";
import type { CommandStats } from "./background-commands.js";
import { formatSubagentDuration } from "../../shared/subagent-messages.js";

/** One of a conversation's queued or running background tasks, as
 *  list_tasks and get_feature_status give it. */
export interface TaskListItem {
  taskId: string;
  kind: "subagent" | "command";
  title: string;
  status: "queued" | "running";
  /** How long it has run ("4m 12s"); "" while queued. */
  runningFor: string;
  command?: string;
  outputPath?: string;
  outputBytes?: number;
  outputLines?: number;
}

/** A conversation's queued and running tasks, oldest first; a command with
 *  what it has written so far. */
export function listTasksFor(
  deps: { tasks: Pick<BackgroundTaskStore, "listOpen">; stats: (taskId: string) => CommandStats | null; now?: () => number },
  threadId: string
): TaskListItem[] {
  const now = deps.now?.() ?? Date.now();
  return deps.tasks.listOpen()
    .filter((task) => task.parentThreadId === threadId && (task.status === "queued" || task.status === "running"))
    .map((task) => {
      const base: TaskListItem = {
        taskId: task.id,
        kind: task.kind,
        title: task.title,
        status: task.status as "queued" | "running",
        runningFor: task.status === "running" && task.startedAt ? formatSubagentDuration(now - Date.parse(task.startedAt)) : ""
      };
      if (task.kind !== "command") return base;
      const stats = deps.stats(task.id);
      return { ...base, command: task.command ?? "", outputPath: task.outputPath ?? "", outputBytes: stats?.bytes ?? 0, outputLines: stats?.lines ?? 0 };
    });
}

/** The part of a conversation's first context after a compaction: what
 *  still runs or waits. Null when nothing does. */
export function tasksContext(items: readonly TaskListItem[]): string | null {
  if (items.length === 0) return null;
  const lines = items.map((item) => item.kind === "command"
    ? `- ${item.taskId} · Command · ${item.title} · \`${item.command}\` · running ${item.runningFor}`
    : `- ${item.taskId} · Subagent · ${item.title} · ${item.status === "queued" ? "queued" : `running ${item.runningFor}`}`);
  return ["Background tasks running when this conversation was compacted (list_tasks shows them as they are now):", ...lines].join("\n");
}

/** What a conversation's tools read of its tasks: list_tasks's items, and
 *  which kind a task is (stop_task stops each by its own service). */
export interface TaskList {
  list(threadId: string): TaskListItem[];
  kindOf(taskId: string): "subagent" | "command" | null;
}
