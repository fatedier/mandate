import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { listFolded, useTaskBoardStore } from "@/store/task-board";
import { BOARD_STATUSES, TASK_STATUS_LABEL } from "@shared/task-board";
import type { TaskDto } from "@shared/api/task-board";
import { TaskRow } from "./TaskRow";
import { TaskStatusIcon } from "./TaskStatusIcon";
import { columnOrder } from "./task-format";

interface RowsProps {
  selected: string | null;
  agentName: string;
  now: number;
  onOpen: (id: string) => void;
}

/** A group of rows under its heading, in a box; `empty` when it has none.
 *  With `fold`, the heading folds the box away and opens it again. */
export function TaskGroup({ id, heading, count, empty, tone, fold, children }: {
  id: string;
  heading: ReactNode;
  count: number;
  empty?: string;
  tone?: string;
  fold?: { folded: boolean; onToggle: () => void };
  children: ReactNode;
}) {
  const label = (
    <>
      {heading}
      <span className="font-normal tabular-nums text-faint">{count}</span>
    </>
  );
  return (
    <section data-slot="task-group" data-group={id} className="flex flex-col gap-1.5">
      <h2 className={tone ?? "flex items-center gap-2 px-0.5 text-[13px] font-semibold text-foreground"}>
        {fold ? (
          // The whole heading is the control; 44px tall on a touch screen.
          <button
            type="button"
            data-slot="task-group-toggle"
            aria-expanded={!fold.folded}
            onClick={fold.onToggle}
            className="-mx-1 flex items-center gap-2 rounded-sm px-1 hover:bg-sel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-11"
          >
            {label}
            <ChevronDown aria-hidden className={cn("size-3.5 text-faint transition-transform", fold.folded && "-rotate-90")} />
          </button>
        ) : label}
      </h2>
      {!fold?.folded && (
        <div className="overflow-hidden rounded-lg border border-border-soft bg-panel">
          {count > 0 ? children : <p className="px-3.5 py-2.5 text-xs text-faint">{empty}</p>}
        </div>
      )}
    </section>
  );
}

/** Every task grouped by status, Cancelled only when asked for; each status
 *  folds from its heading (Backlog and Done start folded), kept in this browser. */
export function ListView({ tasks, showCancelled, ...rows }: RowsProps & { tasks: readonly TaskDto[]; showCancelled: boolean }) {
  const statuses = showCancelled ? [...BOARD_STATUSES, "cancelled" as const] : BOARD_STATUSES;
  const folded = useTaskBoardStore((s) => s.folded);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-4 pt-1 pb-6 md:px-6">
      {statuses.map((status) => {
        const items = tasks.filter((t) => t.status === status).sort(columnOrder(status));
        return (
          <TaskGroup
            key={status}
            id={status}
            heading={<><TaskStatusIcon status={status} />{TASK_STATUS_LABEL[status]}</>}
            count={items.length}
            empty={status === "todo" ? "Nothing waiting to start." : "None."}
            fold={{ folded: listFolded(folded, status), onToggle: () => useTaskBoardStore.getState().toggleFolded(status) }}
          >
            {items.map((task) => <TaskRow key={task.id} task={task} selected={task.id === rows.selected} agentName={rows.agentName} now={rows.now} onOpen={() => rows.onOpen(task.id)} />)}
          </TaskGroup>
        );
      })}
    </div>
  );
}
