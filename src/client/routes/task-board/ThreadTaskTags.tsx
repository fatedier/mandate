import { useMemo } from "react";
import { useTaskBoardStore } from "@/store/task-board";
import { TaskChip } from "./TaskChip";

/** The tasks a thread works on, beside its title: each a chip that opens the
 *  task in the personal agent's panel. Nothing for a thread no task names. */
export function ThreadTaskTags({ threadId }: { threadId: string }) {
  const tasks = useTaskBoardStore((s) => s.tasks);
  const ids = useMemo(
    () => (tasks ? [...tasks.values()].filter((t) => t.threads.some((link) => link.threadId === threadId)).map((t) => t.id) : []),
    [tasks, threadId]
  );
  if (ids.length === 0) return null;
  return (
    <span data-slot="thread-task-tags" className="flex min-w-0 shrink items-center gap-1 overflow-hidden">
      {ids.map((id) => <TaskChip key={id} id={id} className="max-w-48 shrink" />)}
    </span>
  );
}
