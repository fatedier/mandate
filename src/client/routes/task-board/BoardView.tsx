import { useRef, useState, type DragEvent, type PointerEvent } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useElementWidth } from "@/hooks/useElementWidth";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useScrollEdges } from "@/hooks/useScrollEdges";
import { cn } from "@/lib/utils";
import { boardFoldedByHand, useTaskBoardStore } from "@/store/task-board";
import { BOARD_STATUSES, TASK_STATUS_LABEL } from "@shared/task-board";
import type { TaskDto, TaskStatus } from "@shared/api/task-board";
import { BOARD_INSET_PX, boardInset, COLUMN_GAP_PX, COLUMN_MIN_PX, foldedColumns, stepTo } from "./board-layout";
import { TaskCard } from "./TaskCard";
import { columnOrder } from "./task-format";
import { TaskStatusIcon } from "./TaskStatusIcon";

const DRAG_TYPE = "text/plain";
/** How far a press on the board's own ground travels before it is a drag of the board. */
const PAN_SLOP_PX = 4;
/** What a press on the board's ground must not start on: these have a press of their own. */
const NOT_GROUND = '[data-slot="task-card"], button, a, input, [role="menu"]';

/**
 * The board: a column per status in one row, Cancelled only when asked for.
 * A card dragged onto another column moves there.
 *
 * A column folds away from its heading: it leaves the row and its heading
 * (status, name, count) sits in a line above the board, where it still takes
 * a card dropped on it and a press opens it again; kept in this browser.
 * Short of room, a status with no task folds away of its own accord, so the
 * ones with tasks have the row (board-layout.ts), until the owner opens it
 * by hand; and columns narrow to their minimum. What still does not fit is
 * off to the side: a button at that edge steps a column at a time, and the
 * board's own ground drags with the mouse, so the scrollbar is not the only
 * way there.
 *
 * Each column is as tall as the board and its cards scroll inside it, its
 * heading in sight: a long column pushes no other away, and a card dropped
 * anywhere on a column moves there.
 */
export function BoardView({ tasks, showCancelled, selected, agentName, now, onOpen, onMove, onDeleteAllDone }: {
  tasks: readonly TaskDto[];
  showCancelled: boolean;
  selected: string | null;
  agentName: string;
  now: number;
  onOpen: (id: string) => void;
  onMove: (id: string, status: TaskStatus) => void;
  onDeleteAllDone: () => void;
}) {
  const statuses = showCancelled ? [...BOARD_STATUSES, "cancelled" as const] : BOARD_STATUSES;
  // The card being dragged: a browser's dataTransfer holds it too, but not
  // every drag carries one this page can read.
  const dragged = useRef<string | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
  const drop = (status: TaskStatus) => (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setOver(null);
    const id = event.dataTransfer?.getData(DRAG_TYPE) || dragged.current;
    dragged.current = null;
    const task = id ? tasks.find((t) => t.id === id) : undefined;
    if (task && task.status !== status) onMove(task.id, status);
  };

  const folded = useTaskBoardStore((s) => s.boardFolded);
  // The room the columns have: the frame's width less the board's margin on each side.
  const inset = boardInset(useIsMobile());
  const [frameRef, frameWidth] = useElementWidth<HTMLDivElement>();
  const away = foldedColumns(statuses, frameWidth > 0 ? frameWidth - 2 * inset : 0, {
    isEmpty: (status) => !tasks.some((t) => t.status === status),
    fold: (status) => boardFoldedByHand(folded, status)
  });
  const shown = statuses.filter((status) => !away.has(status));
  const shelved = statuses.filter((status) => away.has(status));
  // Which sides have a column cut off, read again when the columns in the
  // row change: the board's edge fade and its step buttons.
  const { ref: paneRef, more, onFocus } = useScrollEdges<HTMLDivElement>(shown.join());

  const step = (side: "left" | "right") => {
    const pane = paneRef.current;
    if (!pane) return;
    const box = pane.getBoundingClientRect();
    const columns = Array.from(pane.querySelectorAll<HTMLElement>('[data-slot="task-column"]')).map((column) => {
      const rect = column.getBoundingClientRect();
      return { left: rect.left - box.left + pane.scrollLeft, width: rect.width };
    });
    const to = stepTo(side, { left: pane.scrollLeft, width: pane.clientWidth, inset: BOARD_INSET_PX }, columns);
    if (to === null) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    pane.scrollTo({ left: to, behavior: still ? "auto" : "smooth" });
  };

  // A press on the board's own ground drags the board (a mouse only: a
  // finger scrolls it as it is).
  const pan = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const [panning, setPanning] = useState(false);
  // A drag ends in a click where the pointer is held, which the view around
  // would take for a click on empty space (it closes the open task): that
  // click is the drag's, and goes no further.
  const dragJustEnded = useRef(false);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    if ((event.target as HTMLElement).closest(NOT_GROUND)) return;
    pan.current = { x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const from = pan.current;
    if (!from) return;
    const [dx, dy] = [event.clientX - from.x, event.clientY - from.y];
    if (!from.moved && Math.hypot(dx, dy) < PAN_SLOP_PX) return;
    if (!from.moved) {
      from.moved = true;
      setPanning(true);
    }
    event.currentTarget.scrollLeft = from.left - dx;
    event.currentTarget.scrollTop = from.top - dy;
  };
  const endPan = () => {
    if (pan.current?.moved) {
      dragJustEnded.current = true;
      // The click, if one comes, comes at once: a later one is its own.
      setTimeout(() => { dragJustEnded.current = false; }, 0);
    }
    pan.current = null;
    setPanning(false);
  };

  /** What a column and a folded heading share: the drop of a card, and how a card over it looks. */
  const lane = (status: TaskStatus) => ({
    "data-slot": "task-column",
    "data-status": status,
    "aria-label": TASK_STATUS_LABEL[status],
    onDragOver: (event: DragEvent<HTMLElement>) => { event.preventDefault(); setOver(status); },
    onDragLeave: () => setOver((current) => (current === status ? null : current)),
    onDrop: drop(status)
  });
  const count = (status: TaskStatus) => tasks.filter((t) => t.status === status).length;

  return (
    <div ref={frameRef} data-slot="task-board-frame" className="flex min-h-0 min-w-0 flex-1 flex-col">
      {shelved.length > 0 && (
        // The statuses folded away, in their order: each its heading, and a press opens it.
        <div data-slot="task-board-folded" className="flex shrink-0 flex-wrap gap-1.5 pt-1 pb-2" style={{ paddingInline: inset }}>
          {shelved.map((status) => (
            <section
              key={status}
              {...lane(status)}
              // By hand, or for want of room and of tasks.
              data-folded={boardFoldedByHand(folded, status) === true ? "true" : "empty"}
              className={cn("rounded-full", over === status && "outline-2 outline-offset-1 outline-dashed outline-status-review")}
            >
              <h2 className="text-[13px] font-semibold text-foreground">
                <button
                  type="button"
                  data-slot="task-column-fold"
                  aria-expanded={false}
                  onClick={() => useTaskBoardStore.getState().setBoardFolded(status, false)}
                  className="flex h-7 items-center gap-1.5 rounded-full border border-border-soft bg-panel pr-2 pl-2.5 transition-colors hover:border-border hover:bg-sel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:h-11"
                >
                  <TaskStatusIcon status={status} />
                  {TASK_STATUS_LABEL[status]}
                  <span className="font-normal tabular-nums text-faint">{count(status)}</span>
                  <ChevronDown aria-hidden className="size-3.5 shrink-0 -rotate-90 text-faint" />
                </button>
              </h2>
            </section>
          ))}
        </div>
      )}
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <div
          ref={paneRef}
          data-slot="task-board"
          data-more={more}
          onFocus={onFocus}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onClickCapture={(event) => {
            if (!dragJustEnded.current) return;
            dragJustEnded.current = false;
            event.stopPropagation();
          }}
          // Sideways when even the narrowed columns do not fit; one row as
          // tall as the board, each column scrolling its own cards. Positioned:
          // a card reached by keyboard is scrolled clear of the edge fade by its offsets.
          className={cn("fade-x-edges relative grid min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden pt-1 pb-6", panning && "cursor-grabbing select-none")}
          style={{ gap: COLUMN_GAP_PX, paddingInline: inset, gridTemplateColumns: `repeat(${Math.max(1, shown.length)}, minmax(${COLUMN_MIN_PX}px, 1fr))`, gridTemplateRows: "minmax(0, 1fr)" }}
        >
          {shown.map((status) => {
            const items = tasks.filter((t) => t.status === status).sort(columnOrder(status));
            return (
              <section
                key={status}
                {...lane(status)}
                className={cn(
                  "flex min-h-0 min-w-0 flex-col gap-2 rounded-xl border border-border-soft bg-panel pt-2",
                  over === status && "outline-2 -outline-offset-2 outline-dashed outline-status-review"
                )}
              >
                <h2 className="mx-2 flex h-7 min-w-0 shrink-0 items-center gap-1 text-[13px] font-semibold text-foreground">
                  {/* The heading is the fold's control, as a status's is in the list. */}
                  <button
                    type="button"
                    data-slot="task-column-fold"
                    aria-expanded
                    onClick={() => useTaskBoardStore.getState().setBoardFolded(status, true)}
                    className="-my-1 flex min-w-0 items-center gap-2 rounded-sm px-1 py-1 hover:bg-sel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-11"
                  >
                    <TaskStatusIcon status={status} />
                    <span className="truncate">{TASK_STATUS_LABEL[status]}</span>
                    <span className="font-normal tabular-nums text-faint">{items.length}</span>
                    <ChevronDown aria-hidden className="size-3.5 shrink-0 text-faint" />
                  </button>
                  {status === "done" && items.length > 0 && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label="Done actions"
                          title="Done actions"
                          className="ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-chrome transition-colors hover:bg-sel hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:size-11"
                        >
                          <MoreHorizontal aria-hidden className="size-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem variant="destructive" onSelect={onDeleteAllDone}>Delete all Done</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </h2>
                <div data-slot="task-column-cards" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                  {items.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      agentName={agentName}
                      now={now}
                      selected={task.id === selected}
                      onOpen={() => onOpen(task.id)}
                      onDragStart={(event) => {
                        dragged.current = task.id;
                        event.dataTransfer?.setData(DRAG_TYPE, task.id);
                        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                      }}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
        {(["left", "right"] as const).map((side) => (more === side || more === "both" ? (
          <button
            key={side}
            type="button"
            data-slot="task-board-step"
            data-side={side}
            aria-label={side === "left" ? "Scroll left" : "Scroll right"}
            title={side === "left" ? "Scroll left" : "Scroll right"}
            onClick={() => step(side)}
            className={cn(
              "absolute top-1 z-[2] inline-flex size-7 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm transition-colors hover:bg-sel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:size-11",
              side === "left" ? "left-1" : "right-1"
            )}
          >
            {side === "left" ? <ChevronLeft aria-hidden className="size-4" /> : <ChevronRight aria-hidden className="size-4" />}
          </button>
        ) : null))}
      </div>
    </div>
  );
}
