import { useEffect, useMemo, useRef } from "react";
import { SquareCheckBig } from "lucide-react";
import type { PanelTabItem } from "@/components/PanelTabRow";
import { AttentionBadge } from "@/shell/AttentionBadge";
import { taskIdOfTab, TASKS_TAB } from "@/lib/panel-tabs";
import { useAgentPageUi } from "@/store/agent-page-ui";
import { useTaskBoardStore } from "@/store/task-board";
import { isOpen } from "./task-format";
import { TaskStatusIcon } from "./TaskStatusIcon";

/** How many open tasks wait on the owner: a linked thread needs them. */
export function useTasksNeedingYou(): number {
  const tasks = useTaskBoardStore((s) => s.tasks);
  return useMemo(() => (tasks ? [...tasks.values()].filter((t) => isOpen(t) && t.marks.needsYou).length : 0), [tasks]);
}

/** The Tasks tab in the agent's panel row, while it is open: closed like a
 *  thread's tab, its count of the tasks that need the owner after its name. */
export function useTasksPanelTab(open: boolean, shown?: (tabId: string) => boolean): PanelTabItem[] {
  const needYou = useTasksNeedingYou();
  if (!open) return [];
  return [{
    id: TASKS_TAB,
    label: "Tasks",
    icon: <SquareCheckBig aria-hidden className="size-3.5 shrink-0" />,
    onClose: () => useAgentPageUi.getState().closeTab(TASKS_TAB, undefined, shown),
    dataTasksTab: true,
    after: needYou > 0 ? <span title="Tasks that need you" className="inline-flex"><AttentionBadge count={needYou} urgent /></span> : undefined
  }];
}

/**
 * The tasks open in tabs of their own in the agent's panel (`task:` ids
 * among `tabIds`): each named by its task, with its status. A task that
 * left the board (deleted) takes its tab with it; until the board has
 * arrived a tab waits under a plain name.
 */
export function usePanelTaskTabs(tabIds: readonly string[], active: string, close: (tabId: string) => void): {
  items: ReadonlyMap<string, PanelTabItem>;
  /** The task whose tab is in sight, or null. */
  activeTask: string | null;
} {
  const tasks = useTaskBoardStore((s) => s.tasks);
  const items = new Map<string, PanelTabItem>();
  const gone: string[] = [];
  for (const id of tabIds) {
    const taskId = taskIdOfTab(id);
    if (taskId === null) continue;
    const task = tasks?.get(taskId);
    if (tasks && !task) { gone.push(id); continue; }
    items.set(id, {
      id,
      label: task?.title ?? "Task",
      icon: <TaskStatusIcon status={task?.status ?? "todo"} />,
      group: "Tasks",
      onClose: () => close(id),
      dataTaskTab: taskId
    });
  }
  // Closed once seen gone; `close` is the row's, as it is now.
  const closeNow = useRef(close);
  useEffect(() => { closeNow.current = close; });
  const goneKey = gone.join("\n");
  useEffect(() => {
    for (const id of goneKey ? goneKey.split("\n") : []) closeNow.current(id);
  }, [goneKey]);
  const activeTask = items.has(active) ? taskIdOfTab(active) : null;
  return { items, activeTask };
}
