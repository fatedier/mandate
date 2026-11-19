import { useNow } from "@/hooks/useNow";
import { personalAgentLabel } from "@/lib/personal-agent-label";
import { useAgentPageUi } from "@/store/agent-page-ui";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { openThreadBeside } from "@/routes/thread-tabs/open-thread-beside";
import { useOpenTask } from "./task-open";
import { TaskBoard } from "./TaskBoard";
import { TaskDetail } from "./TaskDetail";

/** The Tasks tab's view: the board, drawn while its tab is in sight. A task
 *  chosen in it opens in a tab of its own, beside this one (on a phone, full
 *  screen, as every task does there); what was searched for and whether
 *  cancelled tasks show are the panel's to hold, so they are there again
 *  after that task has been read. */
export function TasksPanelTab() {
  const view = useAgentPageUi((s) => s.tasksView);
  const openTask = useOpenTask();
  return (
    <div data-slot="tasks-panel" className="flex min-h-0 flex-1 flex-col pt-2">
      <TaskBoard
        selected={null}
        onSelect={(id) => { if (id) openTask(id); }}
        held={{ ...view, set: (change) => useAgentPageUi.getState().setTasksView(change) }}
      />
    </div>
  );
}

/** A task's own tab: the task, whole. Its threads open as tabs beside it;
 *  `onClose` closes the tab once the task is deleted from here. */
export function TaskTabView({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const agentName = usePersonalAgentStore((s) => personalAgentLabel(s.agent));
  const now = useNow();
  return (
    <div data-slot="task-tab" className="flex min-h-0 flex-1 flex-col">
      <TaskDetail taskId={taskId} agentName={agentName} now={now} onClose={onClose} tab openThread={(threadId) => { void openThreadBeside(threadId); }} />
    </div>
  );
}
