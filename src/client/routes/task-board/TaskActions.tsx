import { Fragment, useRef, type KeyboardEvent, type MouseEvent } from "react";
import { toast } from "sonner";
import { Check, MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useTaskBoardStore } from "@/store/task-board";
import { errorText } from "@shared/error-text";
import { TASK_STATUS_LABEL, TASK_STATUSES } from "@shared/task-board";
import type { PatchTaskBody, TaskDto } from "@shared/api/task-board";
import { quickDays } from "./task-format";
import { useDeleteTask } from "./use-delete-task";
import { TaskStatusIcon } from "./TaskStatusIcon";

/**
 * A task's actions, one menu wherever its "⋯" is (its own page's header, a
 * card on the board, a row in the list): its status and its due date, each
 * a submenu, changed there and then; then Rename, Ask the agent and Delete.
 */
export function TaskActionsItems({ task, agentName, now, onRename, onAsk, onDelete }: {
  task: TaskDto;
  agentName: string;
  now: number;
  onRename: () => void;
  onAsk: () => void;
  onDelete: () => void;
}) {
  const patch = (body: PatchTaskBody) => {
    void useTaskBoardStore.getState().patch(task.id, body).catch((err: unknown) => toast.error(errorText(err)));
  };
  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>Status</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {TASK_STATUSES.map((status) => (
            <Fragment key={status}>
              {status === "cancelled" && <DropdownMenuSeparator />}
              <DropdownMenuItem onSelect={() => { if (status !== task.status) patch({ status }); }}>
                <TaskStatusIcon status={status} />{TASK_STATUS_LABEL[status]}
                {status === task.status && <Check aria-hidden className="ml-auto size-3.5" />}
              </DropdownMenuItem>
            </Fragment>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>Due</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {quickDays(now).map(([label, day]) => (
            <DropdownMenuItem key={label} onSelect={() => patch({ dueDate: day, dueTime: task.dueTime })}>{label}</DropdownMenuItem>
          ))}
          {task.dueDate && <DropdownMenuItem onSelect={() => patch({ dueDate: null, dueTime: null })}>Clear</DropdownMenuItem>}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onRename}>Rename</DropdownMenuItem>
      <DropdownMenuItem onSelect={onAsk}>Ask {agentName}</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onSelect={onDelete}>Delete task</DropdownMenuItem>
    </>
  );
}

/** A press or a key on the "⋯" or in its menu is theirs: the card or row
 *  around (which opens the task) and the view (whose empty space closes
 *  one) do not take it. The menu is portalled, but React passes its events
 *  up its own tree. */
const keep = (event: MouseEvent | KeyboardEvent) => { event.stopPropagation(); };

/**
 * A card's or a row's "⋯": the task's actions. On a card it sits over the
 * top right corner, shown on hover (always on a touch screen), solid with a
 * fade before it so the title runs under it; in a row it ends the row.
 * Rename and Ask happen on the task's page: it opens ready for them.
 */
export function TaskActionsButton({ task, agentName, now, onOpen, open, onOpenChange, place }: {
  task: TaskDto;
  agentName: string;
  now: number;
  onOpen: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  place: "corner" | "row";
}) {
  const deleteTask = useDeleteTask();
  // Done once the menu has closed, as the task's own menu does, so focus
  // goes to the title or the comment box and not back to the "⋯".
  const afterMenu = useRef<(() => void) | null>(null);
  const openFor = (kind: "rename" | "ask") => {
    afterMenu.current = () => {
      useTaskBoardStore.getState().requestTaskAction(task.id, kind);
      onOpen();
    };
  };
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-slot="task-actions"
          aria-label="Task actions"
          title="Task actions"
          onClick={keep}
          onKeyDown={keep}
          className={cn(
            "inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-chrome transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 group-hover:opacity-100 data-[state=open]:opacity-100 pointer-coarse:size-9 pointer-coarse:opacity-100",
            place === "corner"
              ? "absolute top-1.5 right-1.5 z-[1] bg-background opacity-0 before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-4 before:[background:linear-gradient(to_right,transparent,var(--background))] hover:[background:linear-gradient(var(--sel),var(--sel)),var(--background)]"
              : "opacity-0 hover:bg-sel"
          )}
        >
          <MoreHorizontal aria-hidden className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onClick={keep}
        onKeyDown={keep}
        onCloseAutoFocus={(event) => {
          const next = afterMenu.current;
          afterMenu.current = null;
          if (!next) return;
          event.preventDefault();
          next();
        }}
      >
        <TaskActionsItems task={task} agentName={agentName} now={now} onRename={() => openFor("rename")} onAsk={() => openFor("ask")} onDelete={() => { void deleteTask(task); }} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
