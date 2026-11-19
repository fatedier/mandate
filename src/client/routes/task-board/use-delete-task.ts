import { useCallback } from "react";
import { toast } from "sonner";
import { confirmAction } from "@/components/confirm-action";
import { useTaskBoardStore } from "@/store/task-board";
import { errorText } from "@shared/error-text";
import type { TaskDto } from "@shared/api/task-board";

/** Deletes a task once the owner says so: it moves to Recently deleted, and
 *  a toast offers it back. True when it went. */
export function useDeleteTask(): (task: TaskDto) => Promise<boolean> {
  const removeTask = useTaskBoardStore((s) => s.removeTask);
  const restore = useTaskBoardStore((s) => s.restore);
  return useCallback(async (task: TaskDto) => {
    if (!(await confirmAction({
      title: "Delete this task?",
      description: `“${task.title}” moves to Recently deleted. Its threads stay as they are.`,
      confirmLabel: "Delete"
    }))) return false;
    try {
      await removeTask(task.id);
    } catch (err) {
      toast.error(errorText(err));
      return false;
    }
    toast.message("Task deleted", { action: { label: "Undo", onClick: () => { void restore(task.id).catch((err: unknown) => toast.error(errorText(err))); } } });
    return true;
  }, [removeTask, restore]);
}
