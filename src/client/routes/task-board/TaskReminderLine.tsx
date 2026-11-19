import type { TaskReminderNote } from "@shared/task-board";
import { TaskChip } from "./TaskChip";

/** The reminder the personal agent got about a task, as a faint line: what it
 *  was told, for the owner to see why it moves the task. */
export function TaskReminderLine({ reminder, agentName }: { reminder: TaskReminderNote; agentName: string }) {
  return (
    <div data-slot="task-reminder-line" className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 py-1 text-xs text-faint">
      <span>Reminded {agentName}:</span>{" "}
      <TaskChip id={reminder.taskId} className="min-w-0" />{" "}
      <span>has not changed since {reminder.threadTitle} reported</span>
    </div>
  );
}
