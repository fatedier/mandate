import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { toast } from "sonner";
import { ArrowLeft, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/PillTabs";
import { confirmAction } from "@/components/confirm-action";
import { useElementWidth } from "@/hooks/useElementWidth";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useNow } from "@/hooks/useNow";
import { formatRelativeTime } from "@/lib/format";
import { personalAgentLabel } from "@/lib/personal-agent-label";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { useTaskBoardStore, type TaskBoardView } from "@/store/task-board";
import { errorText } from "@shared/error-text";
import type { TaskDto, TaskStatus } from "@shared/api/task-board";
import { boardOffered } from "./board-layout";
import { BoardView } from "./BoardView";
import { DueView } from "./DueView";
import { ListView } from "./ListView";
import { NewTaskDialog } from "./NewTaskDialog";
import { TaskDetail } from "./TaskDetail";
import { TaskStatusIcon } from "./TaskStatusIcon";
import { isOpen, localDay, matchesFilters, matchesSearch } from "./task-format";
import { ClearFilters, TaskFilterBar, TaskFilterPhone } from "./TaskFilters";

const VIEWS: ReadonlyArray<{ id: TaskBoardView; label: string }> = [
  { id: "board", label: "Board" },
  { id: "list", label: "List" },
  { id: "due", label: "Due" }
];
/** The views of a page with no room for a board. */
const WITHOUT_BOARD = VIEWS.filter((v) => v.id !== "board");

const EMPTY: readonly TaskDto[] = [];

/** What a click in the view is for, when it lands on one: a card or a row
 *  opens its task, a control does its own thing. */
const CLICKABLE = 'a, button, input, textarea, select, label, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="option"]';

/**
 * The owner's tasks, in either of their homes (the Tasks page, a tab in the
 * personal agent's panel): Board, List or Due, a search, New task; Cancelled
 * and Recently deleted behind the footer. On the Tasks page the task opened
 * shows beside the view (on a phone, in its place); the panel opens a task
 * in a tab of its own and names none here.
 */
export function TaskBoard({ selected, onSelect, held }: {
  /** The task open here, from the home's address; null where the home opens
   *  tasks elsewhere. */
  selected: string | null;
  /** A task chosen (a card, a row, one just made), or null to close the one open. */
  onSelect: (id: string | null) => void;
  /** The search and Show cancelled, held by a home whose board comes and
   *  goes while they should stay (the panel's tab); absent, the board's own. */
  held?: { query: string; showCancelled: boolean; set: (change: { query?: string; showCancelled?: boolean }) => void };
}) {
  const board = useTaskBoardStore((s) => s.tasks);
  const deleted = useTaskBoardStore((s) => s.deleted);
  const phone = useIsMobile();
  const [rowRef, rowWidth] = useElementWidth<HTMLDivElement>();
  // The board chosen stays chosen; a page with no room for it shows List.
  const withBoard = boardOffered(phone, rowWidth);
  const kept = useTaskBoardStore((s) => s.view);
  const view = kept === "board" && !withBoard ? "list" : kept;
  const setView = useTaskBoardStore((s) => s.setView);
  const fetchDeleted = useTaskBoardStore((s) => s.fetchDeleted);
  const patch = useTaskBoardStore((s) => s.patch);
  const removeAllDone = useTaskBoardStore((s) => s.removeAllDone);
  const filters = useTaskBoardStore((s) => s.filters);
  const agentName = usePersonalAgentStore((s) => personalAgentLabel(s.agent));
  const now = useNow();
  const [ownQuery, setOwnQuery] = useState("");
  const [ownShowCancelled, setOwnShowCancelled] = useState(false);
  const query = held ? held.query : ownQuery;
  const setQuery = (next: string) => (held ? held.set({ query: next }) : setOwnQuery(next));
  const showCancelled = held ? held.showCancelled : ownShowCancelled;
  const setShowCancelled = (next: boolean) => (held ? held.set({ showCancelled: next }) : setOwnShowCancelled(next));
  const [showDeleted, setShowDeleted] = useState(false);
  const [creating, setCreating] = useState(false);

  // What was deleted is not on the board the stream sends: read here, and
  // again whenever the stream comes back (deletes and purges it missed).
  useEffect(() => {
    const read = () => { void fetchDeleted().catch(() => {}); };
    read();
    window.addEventListener("mandate:sse-open", read);
    return () => window.removeEventListener("mandate:sse-open", read);
  }, [fetchDeleted]);

  const all = useMemo(() => (board ? [...board.values()] : EMPTY), [board]);
  const today = localDay(now);
  const filtering = filters.labels.length > 0 || filters.due.length > 0;
  const tasks = useMemo(() => all.filter((t) => matchesSearch(t, query) && matchesFilters(t, filters, today)), [all, query, filters, today]);
  const open = all.filter(isOpen).length;
  const cancelled = tasks.filter((t) => t.status === "cancelled").length;
  const selectedTask = selected && board?.has(selected) ? selected : null;
  const fail = (err: unknown) => { toast.error(errorText(err)); };
  // A click on the view's empty space closes the open task. Not one that
  // ends a text selection, nor one in something drawn outside the view (a
  // menu's or a dialog's layer reaches here through React only).
  const closeOnEmptySpace = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (!event.currentTarget.contains(target) || target.closest(CLICKABLE)) return;
    if (window.getSelection()?.isCollapsed === false) return;
    onSelect(null);
  };
  const move = (id: string, status: TaskStatus) => { void patch(id, { status }).catch(fail); };
  const deleteAllDone = async () => {
    const done = all.filter((t) => t.status === "done").length;
    if (!(await confirmAction({
      title: `Delete ${done} done tasks?`,
      description: "They move to Recently deleted. Their threads stay as they are.",
      confirmLabel: "Delete"
    }))) return;
    await removeAllDone().catch(fail);
  };

  if (phone && selectedTask) {
    return (
      <div data-slot="task-board-home" className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TaskDetail key={selectedTask} taskId={selectedTask} agentName={agentName} now={now} onClose={() => onSelect(null)} drill />
      </div>
    );
  }
  const rows = { selected: selectedTask, agentName, now, onOpen: (id: string) => onSelect(id) };
  let body;
  if (showDeleted) {
    body = <DeletedList tasks={[...deleted.values()]} query={query} now={now} onBack={() => setShowDeleted(false)} />;
  } else if (board !== null && all.length === 0) {
    body = (
      <p data-slot="tasks-empty" className="px-6 py-16 text-center text-sm text-muted-foreground">
        No tasks yet. Create one with New task, or ask {agentName} to note one down.
      </p>
    );
  } else if (filtering && tasks.filter((t) => (view === "due" ? isOpen(t) : t.status !== "cancelled" || showCancelled)).length === 0) {
    body = (
      <div data-slot="tasks-filtered-empty" className="flex flex-col items-center gap-2 px-6 py-16 text-center text-sm text-muted-foreground">
        <p>No tasks match these filters.</p>
        <ClearFilters />
      </div>
    );
  } else if (view === "board") {
    body = <BoardView tasks={tasks} showCancelled={showCancelled} {...rows} onMove={move} onDeleteAllDone={() => { void deleteAllDone(); }} />;
  } else if (view === "list") {
    body = <ListView tasks={tasks} showCancelled={showCancelled} {...rows} />;
  } else {
    body = <DueView tasks={tasks} {...rows} />;
  }

  return (
    <div data-slot="task-board-home" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-1 pb-3 md:px-6">
        <PillTabs role="nav" aria-label="Tasks view" items={withBoard ? VIEWS : WITHOUT_BOARD} value={view} onChange={(next) => { setShowDeleted(false); setView(next); }} />
        <span className="text-xs tabular-nums text-faint">{open} open</span>
        <span className="flex-1" />
        {phone ? <TaskFilterPhone tasks={all} /> : <TaskFilterBar tasks={all} />}
        <label className="flex h-7 w-48 items-center gap-1.5 rounded-md border border-border-soft bg-background px-2 text-xs focus-within:border-ring">
          <Search aria-hidden className="size-3.5 shrink-0 text-faint" />
          <input
            type="search"
            aria-label="Search tasks"
            placeholder="Search tasks"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-faint"
          />
        </label>
        <Button type="button" variant="outline" size="sm" className="h-7 gap-1 px-2.5 text-xs" onClick={() => setCreating(true)}>
          <Plus aria-hidden className="size-3.5" />New task
        </Button>
      </div>
      <div ref={rowRef} className="relative flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" onClick={selectedTask ? closeOnEmptySpace : undefined}>
          {body}
          {!showDeleted && (cancelled > 0 || deleted.size > 0) && (
            <div data-slot="tasks-foot" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-4 text-xs text-faint md:px-6">
              {cancelled > 0 && (
                <span className="flex items-center gap-1.5">
                  {cancelled} cancelled
                  <button type="button" className="rounded-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => setShowCancelled(!showCancelled)}>
                    {showCancelled ? "Hide cancelled" : "Show cancelled"}
                  </button>
                </span>
              )}
              {deleted.size > 0 && (
                <button type="button" className="rounded-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => setShowDeleted(true)}>
                  Recently deleted ({deleted.size})
                </button>
              )}
            </div>
          )}
        </div>
        {selectedTask && (
          <TaskDetail
            key={selectedTask}
            taskId={selectedTask}
            agentName={agentName}
            now={now}
            onClose={() => onSelect(null)}
            overlay={view === "board" && !showDeleted}
            rowWidth={rowWidth}
          />
        )}
      </div>
      {creating && <NewTaskDialog agentName={agentName} onDone={(id) => { setCreating(false); if (id) onSelect(id); }} />}
    </div>
  );
}

/** Deleted tasks, newest first, as the board's search narrows them: each
 *  restorable, or deleted forever. Kept until then. */
function DeletedList({ tasks, query, now, onBack }: { tasks: readonly TaskDto[]; query: string; now: number; onBack: () => void }) {
  const restore = useTaskBoardStore((s) => s.restore);
  const deleteForever = useTaskBoardStore((s) => s.deleteForever);
  const sorted = tasks.filter((task) => matchesSearch(task, query)).sort((a, b) => (b.deletedAt ?? "").localeCompare(a.deletedAt ?? ""));
  const fail = (err: unknown) => { toast.error(errorText(err)); };
  const askForever = async (task: TaskDto) => {
    if (!(await confirmAction({ title: `Delete “${task.title}” forever?`, description: "This can't be undone.", confirmLabel: "Delete forever" }))) return;
    await deleteForever(task.id).catch(fail);
  };
  return (
    <div data-slot="tasks-deleted" className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 pt-1 pb-6 md:px-6">
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" className="-ml-2 gap-1 px-2 text-muted-foreground" onClick={onBack}>
          <ArrowLeft aria-hidden className="size-4" />Tasks
        </Button>
      </div>
      <section className="flex flex-col gap-1.5">
        <h2 className="flex items-center gap-2 px-0.5 text-[13px] font-semibold text-foreground">
          Recently deleted <span className="font-normal tabular-nums text-faint">{sorted.length}</span>
        </h2>
        {/* A search that finds none leaves the list out, as the board's
            columns stand empty: "Nothing deleted." is for an empty bin. */}
        {(sorted.length > 0 || !query.trim()) && (
          <div className="overflow-hidden rounded-lg border border-border-soft bg-panel">
            {sorted.length === 0 && <p className="px-3.5 py-2.5 text-xs text-faint">Nothing deleted.</p>}
            {sorted.map((task) => (
              // One line where there is room; on a phone the buttons go
              // under the title, so it keeps the width to be read.
              <div key={task.id} data-slot="task-deleted-row" className="flex flex-wrap items-center justify-end gap-x-2.5 gap-y-1.5 border-t border-border-soft px-3.5 py-2.5 first:border-t-0">
                <div className="flex min-w-48 flex-1 items-center gap-2.5">
                  <TaskStatusIcon status={task.status} />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{task.title}</span>
                  {task.deletedAt && <span className="shrink-0 text-xs tabular-nums text-faint">{formatRelativeTime(task.deletedAt, now)}</span>}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button type="button" variant="outline" size="xs" onClick={() => { void restore(task.id).catch(fail); }}>Restore</Button>
                  <Button type="button" variant="ghost" size="xs" className="text-destructive hover:text-destructive" onClick={() => { void askForever(task); }}>Delete forever</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
