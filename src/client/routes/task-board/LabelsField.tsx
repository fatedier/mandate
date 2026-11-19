import { toast } from "sonner";
import { LabelField } from "@/components/LabelField";
import { useKnownLabels } from "@/lib/known-labels";
import { useTaskBoardStore } from "@/store/task-board";
import { errorText } from "@shared/error-text";
import type { TaskDto } from "@shared/api/task-board";

/**
 * A task's Labels: the automatic ones (where its threads' workers ran, no
 * ×), then the owner's and the agent's, each with × to remove; and the field
 * that adds one (LabelField), suggesting the names in use on tasks and
 * threads.
 */
export function LabelsField({ task, agentName }: { task: TaskDto; agentName: string }) {
  const known = useKnownLabels();
  return (
    <LabelField
      slot="task"
      labels={task.labels}
      known={known}
      agentName={agentName}
      onAdd={(name) => { void useTaskBoardStore.getState().addLabel(task.id, name).catch((err: unknown) => toast.error(errorText(err))); }}
      onRemove={(name) => { void useTaskBoardStore.getState().removeLabel(task.id, name).catch((err: unknown) => toast.error(errorText(err))); }}
    />
  );
}
