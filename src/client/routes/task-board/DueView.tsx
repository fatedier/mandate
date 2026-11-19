import type { TaskDto } from "@shared/api/task-board";
import { TaskGroup } from "./ListView";
import { TaskRow } from "./TaskRow";
import { byDue, DUE_GROUPS, dueGroupOf, isOpen, localDay } from "./task-format";

/** The open tasks as an agenda: Overdue, Today, This week, Later, No due
 *  date; a group with none is left out. */
export function DueView({ tasks, selected, agentName, now, onOpen }: {
  tasks: readonly TaskDto[];
  selected: string | null;
  agentName: string;
  now: number;
  onOpen: (id: string) => void;
}) {
  const today = localDay(now);
  const open = tasks.filter(isOpen).sort(byDue);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-4 pt-1 pb-6 md:px-6">
      {DUE_GROUPS.map((group) => {
        const items = open.filter((t) => dueGroupOf(t, today) === group.id);
        if (items.length === 0) return null;
        return (
          <TaskGroup
            key={group.id}
            id={group.id}
            heading={group.label}
            count={items.length}
            tone={group.id === "overdue" ? "flex items-center gap-2 px-0.5 text-[13px] font-semibold text-destructive" : undefined}
          >
            {items.map((task) => <TaskRow key={task.id} task={task} selected={task.id === selected} agentName={agentName} now={now} onOpen={() => onOpen(task.id)} />)}
          </TaskGroup>
        );
      })}
    </div>
  );
}
