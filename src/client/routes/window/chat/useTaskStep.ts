import type { BackgroundTaskDto } from "@shared/api-contracts";
import { useSubagentThread } from "@/hooks/useSubagentThread";
import { useReasoningHeadingStore } from "@/store/reasoning-heading";
import { useBackgroundTasksStore } from "@/store/background-tasks";
import { taskOutcomeLabel, taskStep, taskStepRows } from "./background-tasks-view";

/** What a running task is on now, in a few words (taskStep): the call its
 *  subagent's wake is running, else its reasoning's heading, else its last
 *  call. Its conversation is read for that as a read-only scope, so live
 *  events keep it current. Null for a task not running, and when `enabled`
 *  is off (a phone's strip row: nothing is read for it). */
export function useTaskStep(task: Pick<BackgroundTaskDto, "id" | "kind" | "status" | "childThreadId">, enabled = true): string | null {
  const running = task.status === "running" && enabled;
  // A command's step is its output's last line, as the server sends it: nothing is read for it.
  const command = task.kind === "command";
  const live = useBackgroundTasksStore((s) => (command && running ? s.liveLines.get(task.id)?.lastLine ?? null : null));
  const thread = useSubagentThread(running && !command ? task.childThreadId : null);
  const wakeId = thread && thread.wakePhase.phase !== "idle" ? thread.wakePhase.wakeId : null;
  const heading = useReasoningHeadingStore((s) => (wakeId === null ? null : s.byWake.get(wakeId) ?? null));
  if (command) return live || null;
  return running ? taskStep(taskStepRows(thread), heading) : null;
}

/** What a task's line says after its job: the step a running one is on
 *  ("Reading CHANGELOG.md…"; "Working…" while none is read), a running
 *  command's output's last line (Running while it has none), Queued, or how
 *  it ended. */
export function useTaskState(task: Pick<BackgroundTaskDto, "id" | "kind" | "status" | "childThreadId" | "exitCode" | "stoppedBy">, withStep = true): string {
  const step = useTaskStep(task, withStep);
  if (task.status === "running" && task.kind === "command") return step ?? "Running";
  return task.status === "running" ? `${step ?? "Working"}…` : taskOutcomeLabel(task);
}
