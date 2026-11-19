import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { ArrowLeft, CalendarDays, Check, MoreHorizontal, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MarkdownView } from "@/components/MarkdownView";
import { ThreadStateMark } from "@/shell/ThreadStateMark";
import { formatRelativeTime } from "@/lib/format";
import { shouldIgnoreGlobalEscape } from "@/lib/keyboard-targets";
import { threadHref } from "@/lib/worker-href";
import { cn } from "@/lib/utils";
import { DETAIL_LEAVES, DETAIL_MIN_WIDTH, detailAutoWidth, useTaskBoardStore } from "@/store/task-board";
import { errorText } from "@shared/error-text";
import { TASK_STATUS_LABEL, TASK_STATUSES } from "@shared/task-board";
import type { PatchTaskBody, TaskDto, TaskThreadDto } from "@shared/api/task-board";
import { DuePicker, DueSheetChoices } from "./DuePicker";
import { BottomSheet, BottomSheetTitle } from "@/components/ui/bottom-sheet";
import { useIsMobile } from "@/hooks/useIsMobile";
import { TaskComments } from "./TaskComments";
import { TaskActionsItems } from "./TaskActions";
import { useDeleteTask } from "./use-delete-task";
import { LabelsField } from "./LabelsField";
import { TaskStatusIcon } from "./TaskStatusIcon";
import { formatDueLabel, THREAD_STATE_WORD } from "./task-format";

/** A description or Result longer than this folds, Show more opening it. */
const FOLD_LINES = 9;
const FOLD_CHARS = 520;
const folds = (text: string) => text.split("\n").length > FOLD_LINES || text.length > FOLD_CHARS;

const ICON_BUTTON = "inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-chrome transition-colors hover:bg-sel hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:size-11";
const FIELD_BUTTON = "inline-flex h-7 max-w-full items-center gap-1.5 rounded-md px-1.5 -ml-1.5 text-[13px] transition-colors hover:bg-sel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60";

interface TaskDetailProps {
  taskId: string;
  agentName: string;
  now: number;
  onClose: () => void;
  /** In place of the view (a phone): Back instead of Close, no resizing. */
  drill?: boolean;
  /** In a tab of its own (the agent's panel): it fills the tab, which closes
   *  it; neither Back nor Close here, and Esc is not its. */
  tab?: boolean;
  /** Over the view (the board) rather than beside it. */
  overlay?: boolean;
  /** The width of the row the detail sits in: its widest leaves the view
   *  DETAIL_LEAVES. 0 while unmeasured. */
  rowWidth?: number;
  /** Opens a linked thread; absent, the row is a link to the thread's page. */
  openThread?: (threadId: string) => void;
}

/**
 * One task, whole: its title (pressed, renamed), status, due date and when it
 * was made; its description; the agent's Result; the threads that work on it;
 * its comments. Esc closes it. Beside the view it takes half the page until
 * its left edge is dragged, and the width dragged is kept.
 */
export function TaskDetail({ taskId, agentName, now, onClose, drill = false, tab = false, overlay = false, rowWidth = 0, openThread }: TaskDetailProps) {
  const task = useTaskBoardStore((s) => s.tasks?.get(taskId) ?? null);
  const entries = useTaskBoardStore((s) => s.details.get(taskId)?.entries ?? null);
  const fetchDetail = useTaskBoardStore((s) => s.fetchDetail);
  const patchTask = useTaskBoardStore((s) => s.patch);
  const deleteTask = useDeleteTask();
  const width = useTaskBoardStore((s) => s.detailWidth);
  const setWidth = useTaskBoardStore((s) => s.setDetailWidth);
  const [renaming, setRenaming] = useState(false);
  const [ask, setAsk] = useState(0);
  // Opened from a card's or a row's Rename or Ask: ready for it, once.
  const taskAction = useTaskBoardStore((s) => s.taskAction);
  const [handledAction, setHandledAction] = useState<number | null>(null);
  if (taskAction && taskAction.taskId === taskId && taskAction.nonce !== handledAction) {
    setHandledAction(taskAction.nonce);
    if (taskAction.kind === "rename") setRenaming(true);
    else setAsk((n) => n + 1);
  }
  useEffect(() => {
    if (taskAction && taskAction.taskId === taskId) useTaskBoardStore.getState().clearTaskAction(taskAction.nonce);
  }, [taskAction, taskId]);
  // Rename and Ask put the cursor in a field: they start once the menu has
  // closed, which then does not take focus back to its button (a field
  // opened while the menu still held focus lost it, and a rename ended).
  const afterMenu = useRef<(() => void) | null>(null);
  const updatedAt = task?.updatedAt;

  // Its stream, read on opening and again whenever the task changed (the
  // board's copy says so) or the stream to the server opened again.
  useEffect(() => {
    void fetchDetail(taskId).catch(() => {});
  }, [fetchDetail, taskId, updatedAt]);
  useEffect(() => {
    const again = () => { void fetchDetail(taskId).catch(() => {}); };
    window.addEventListener("mandate:sse-open", again);
    return () => window.removeEventListener("mandate:sse-open", again);
  }, [fetchDetail, taskId]);
  // The owner looking at it: once it shows, and whenever the page comes back
  // into view with it open. What waits on them there (In review) is seen.
  const opened = useTaskBoardStore((s) => s.opened);
  useEffect(() => {
    const seen = () => { if (document.visibilityState === "visible") void opened(taskId).catch(() => {}); };
    seen();
    document.addEventListener("visibilitychange", seen);
    return () => document.removeEventListener("visibilitychange", seen);
  }, [opened, taskId]);

  // Esc closes it, unless something over it takes the key or a field is being typed in.
  useEffect(() => {
    if (tab) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || shouldIgnoreGlobalEscape(event)) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      // Spent here: the panel the task sits in does not also take it.
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, tab]);

  if (!task) return null;
  const patch = (body: PatchTaskBody) => { void patchTask(task.id, body).catch((err: unknown) => toast.error(errorText(err))); };
  const remove = async () => {
    if (await deleteTask(task)) onClose();
  };
  const maxWidth = rowWidth > 0 ? Math.max(DETAIL_MIN_WIDTH, rowWidth - DETAIL_LEAVES) : Infinity;
  const shown = Math.min(Math.max(width ?? detailAutoWidth(rowWidth), DETAIL_MIN_WIDTH), maxWidth);
  const resize = (next: number) => setWidth(Math.min(Math.max(next, DETAIL_MIN_WIDTH), maxWidth));
  // The whole of its place, not a panel beside the view.
  const fills = drill || tab;

  return (
    <aside
      data-slot="task-detail"
      data-task-id={task.id}
      aria-label="Task"
      style={fills ? undefined : { width: shown }}
      className={cn(
        "flex min-h-0 flex-col bg-background",
        fills ? "min-w-0 flex-1" : "relative shrink-0 border-l border-border-soft",
        overlay && !fills && "absolute inset-y-0 right-0 z-20 border-border shadow-lg"
      )}
    >
      {!fills && <ResizeEdge width={shown} onResize={resize} />}
      <header className="flex h-12 shrink-0 items-center gap-1 pr-2.5 pl-4">
        {drill ? (
          <Button type="button" variant="ghost" size="sm" className="-ml-2 gap-1 px-2 text-muted-foreground" onClick={onClose}>
            <ArrowLeft aria-hidden className="size-4" />Tasks
          </Button>
        ) : (
          <span className="text-xs text-faint">Task</span>
        )}
        <span className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="Task actions" title="Task actions" className={ICON_BUTTON}>
              <MoreHorizontal aria-hidden className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onCloseAutoFocus={(event) => {
              const next = afterMenu.current;
              afterMenu.current = null;
              if (!next) return;
              event.preventDefault();
              next();
            }}
          >
            <TaskActionsItems
              task={task}
              agentName={agentName}
              now={now}
              onRename={() => { afterMenu.current = () => setRenaming(true); }}
              onAsk={() => { afterMenu.current = () => setAsk((n) => n + 1); }}
              onDelete={() => { void remove(); }}
            />
          </DropdownMenuContent>
        </DropdownMenu>
        {!fills && (
          <button type="button" aria-label="Close" title="Close" className={ICON_BUTTON} onClick={onClose}>
            <X aria-hidden className="size-4" />
          </button>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-[18px] pt-1 pb-8">
        <Title task={task} renaming={renaming} setRenaming={setRenaming} onRename={(title) => patch({ title })} />
        <Fields task={task} agentName={agentName} now={now} onPatch={patch} />
        <Description key={task.id} taskId={task.id} text={task.description} onSave={(description) => patch({ description })} />
        {task.result && (
          <section data-slot="task-result" className="flex flex-col gap-2">
            <h3 className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
              Result
              <span className="ml-auto text-xs font-normal text-faint">by {agentName}{task.resultAt ? ` · ${formatRelativeTime(task.resultAt, now)}` : ""}</span>
            </h3>
            <div className="rounded-lg border border-border-soft bg-panel px-3 py-2.5">
              <Fold text={task.result} />
            </div>
          </section>
        )}
        <Threads threads={task.threads} agentName={agentName} now={now} openThread={openThread} />
        <TaskComments taskId={task.id} entries={entries} agentName={agentName} now={now} ask={ask} />
      </div>
    </aside>
  );
}

/** The left edge: dragged, or moved with the arrow keys, it sets the width. */
function ResizeEdge({ width, onResize }: { width: number; onResize: (width: number) => void }) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const end = () => {
    drag.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Drag to resize"
      aria-valuenow={Math.round(width)}
      title="Drag to resize"
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        drag.current = { startX: event.clientX, startWidth: width };
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* the move still lands here while over it */ }
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
      onPointerMove={(event) => {
        // Anchored to the right: dragging left widens it.
        if (drag.current) onResize(drag.current.startWidth + (drag.current.startX - event.clientX));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        onResize(width + (event.key === "ArrowLeft" ? 20 : -20));
      }}
      className="group absolute inset-y-0 -left-1 z-[1] flex w-2 cursor-col-resize touch-none select-none justify-center focus-visible:outline-none"
    >
      <div className="w-px bg-transparent transition-colors group-hover:bg-status-review group-focus-visible:bg-ring group-active:bg-status-review" />
    </div>
  );
}

function Title({ task, renaming, setRenaming, onRename }: { task: TaskDto; renaming: boolean; setRenaming: (on: boolean) => void; onRename: (title: string) => void }) {
  const [draft, setDraft] = useState(task.title);
  const [editingFor, setEditingFor] = useState<string | null>(null);
  // A rename starts from the title as it is now.
  if (renaming && editingFor !== task.id) {
    setEditingFor(task.id);
    setDraft(task.title);
  }
  if (!renaming && editingFor !== null) setEditingFor(null);
  // Enter or Esc ends the rename; the blur that follows as the field goes
  // adds nothing.
  const ended = useRef(false);
  const end = (keep: boolean) => {
    if (ended.current) return;
    ended.current = true;
    setRenaming(false);
    const title = draft.trim();
    if (keep && title && title !== task.title) onRename(title);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") { event.preventDefault(); end(true); }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); end(false); }
  };
  if (renaming) {
    return (
      <input
        data-slot="task-title-input"
        aria-label="Rename"
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => { ended.current = false; }}
        onBlur={() => end(true)}
        className="-mx-1.5 rounded-md border border-ring/60 bg-background px-1.5 py-1 text-lg font-semibold leading-snug text-foreground outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      data-slot="task-title"
      title="Rename"
      onClick={() => setRenaming(true)}
      className="-mx-1.5 cursor-text rounded-md px-1.5 py-1 text-left text-lg font-semibold leading-snug text-foreground transition-colors hover:bg-sel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      {task.title}
    </button>
  );
}

function Fields({ task, agentName, now, onPatch }: { task: TaskDto; agentName: string; now: number; onPatch: (body: PatchTaskBody) => void }) {
  const due = task.dueDate ? formatDueLabel(task.dueDate, task.dueTime, now) : null;
  const phone = useIsMobile();
  const [sheet, setSheet] = useState<"status" | "due" | null>(null);
  const statusButton = (
    <button type="button" data-slot="task-status" onClick={phone ? () => setSheet("status") : undefined} className={cn(FIELD_BUTTON, "text-foreground")}>
      <TaskStatusIcon status={task.status} />{TASK_STATUS_LABEL[task.status]}
    </button>
  );
  const dueButton = (
    <button
      type="button"
      data-slot="task-due-field"
      onClick={phone ? () => setSheet("due") : undefined}
      className={cn(FIELD_BUTTON, due?.tone === "overdue" ? "text-destructive" : due?.tone === "today" ? "text-amber" : due ? "text-foreground" : "text-faint")}
    >
      <CalendarDays aria-hidden className="size-3.5" />{due ? due.long : "Set due date"}
    </button>
  );
  const row = (label: string, value: ReactNode) => (
    <>
      <span className="text-[13px] text-faint">{label}</span>
      <span className="min-w-0">{value}</span>
    </>
  );
  return (
    <div className="grid grid-cols-[96px_1fr] items-center gap-x-2.5 gap-y-1">
      {row("Status", phone ? statusButton : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>{statusButton}</DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {TASK_STATUSES.map((status) => (
              <DropdownMenuItem key={status} onSelect={() => { if (status !== task.status) onPatch({ status }); }}>
                <TaskStatusIcon status={status} />{TASK_STATUS_LABEL[status]}
                {status === task.status && <Check aria-hidden className="ml-auto size-3.5" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
      {row("Due", phone ? dueButton : (
        <DuePicker value={{ dueDate: task.dueDate, dueTime: task.dueTime }} onChange={(next) => onPatch(next)} now={now}>{dueButton}</DuePicker>
      ))}
      {row("Labels", <LabelsField task={task} agentName={agentName} />)}
      {phone && (
        <>
          <BottomSheet
            open={sheet === "status"}
            onOpenChange={(open) => { if (!open) setSheet(null); }}
            slot="task-status-sheet"
            bodyClassName="flex flex-col px-2 pb-4"
            header={<div className="flex h-8 items-center px-4"><BottomSheetTitle className="text-sm font-semibold">Status</BottomSheetTitle></div>}
          >
            {TASK_STATUSES.map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => { setSheet(null); if (status !== task.status) onPatch({ status }); }}
                className="flex h-11 items-center gap-3 rounded-md px-3 text-left text-sm text-foreground hover:bg-sel"
              >
                <TaskStatusIcon status={status} className="size-4" />{TASK_STATUS_LABEL[status]}
                {status === task.status && <Check aria-hidden className="ml-auto size-4 text-status-review" />}
              </button>
            ))}
          </BottomSheet>
          <BottomSheet
            open={sheet === "due"}
            onOpenChange={(open) => { if (!open) setSheet(null); }}
            slot="task-due-sheet"
            bodyClassName="px-4 pb-4"
            header={<div className="flex h-8 items-center px-4"><BottomSheetTitle className="text-sm font-semibold">Due</BottomSheetTitle></div>}
          >
            <DueSheetChoices value={{ dueDate: task.dueDate, dueTime: task.dueTime }} now={now} onChange={(next, done) => { onPatch(next); if (done) setSheet(null); }} />
          </BottomSheet>
        </>
      )}
      {row("Created", (
        <span className="text-[13px] text-muted-foreground">{formatRelativeTime(task.createdAt, now)} · by {task.createdBy === "owner" ? "You" : agentName}</span>
      ))}
    </div>
  );
}

/** Markdown, folded past nine lines with Show more. */
function Fold({ text, slot }: { text: string; slot?: string }) {
  const [open, setOpen] = useState(false);
  const long = folds(text);
  const folded = long && !open;
  return (
    <div className="flex flex-col gap-1">
      <div
        data-slot={slot}
        data-folded={folded ? "true" : "false"}
        className={cn(folded && "max-h-[200px] overflow-hidden [mask-image:linear-gradient(#000_65%,transparent)]")}
      >
        <MarkdownView text={text} dense />
      </div>
      {long && (
        <button type="button" onClick={() => setOpen(!open)} className="self-start rounded-xs text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/** A description being edited, by its task, while its editor is gone (the
 *  tab hidden, the panel maximized): it comes back as it was left. */
const descriptionDrafts = new Map<string, string>();

/** The owner's description: Markdown, any length, folded when long; edited in place. */
function Description({ taskId, text, onSave }: { taskId: string; text: string; onSave: (description: string) => void }) {
  const kept = descriptionDrafts.get(taskId);
  const [editing, setEditingState] = useState(kept !== undefined);
  const [draft, setDraftState] = useState(kept ?? text);
  const setDraft = (value: string) => {
    descriptionDrafts.set(taskId, value);
    setDraftState(value);
  };
  const setEditing = (on: boolean) => {
    if (!on) descriptionDrafts.delete(taskId);
    setEditingState(on);
  };
  const start = () => {
    setDraft(text);
    setEditing(true);
  };
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex h-7 items-center gap-2 text-[13px] font-semibold text-foreground">
        Description
        {text && !editing && (
          <button type="button" aria-label="Edit description" title="Edit description" onClick={start} className={cn(ICON_BUTTON, "ml-auto")}>
            <Pencil aria-hidden className="size-3.5" />
          </button>
        )}
      </h3>
      {editing ? (
        <>
          <textarea
            data-slot="task-description-input"
            autoFocus
            value={draft}
            placeholder="Paste or write as much as you like. Markdown works."
            onChange={(event) => setDraft(event.target.value)}
            rows={10}
            className="min-h-40 w-full resize-y rounded-md border border-border-soft bg-background px-3 py-2 text-sm outline-none focus:border-ring"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
            <Button type="button" size="sm" onClick={() => { setEditing(false); if (draft !== text) onSave(draft); }}>Save</Button>
          </div>
        </>
      ) : text ? (
        <Fold text={text} slot="task-description" />
      ) : (
        <button type="button" onClick={start} className="self-start rounded-md px-1.5 py-1 -mx-1.5 text-left text-[13px] text-faint transition-colors hover:bg-sel hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
          Add a description…
        </button>
      )}
    </section>
  );
}

/** The threads that work on the task, read-only: each with its dot, its
 *  state and the first line of its latest reply. */
function Threads({ threads, agentName, now, openThread }: { threads: readonly TaskThreadDto[]; agentName: string; now: number; openThread?: (threadId: string) => void }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
        Threads <span className="font-normal tabular-nums text-faint">{threads.length}</span>
        <span className="ml-auto text-xs font-normal text-faint">{agentName} keeps these</span>
      </h3>
      {threads.length === 0 ? (
        <p className="text-xs text-faint">No thread works on it yet. Mention @{agentName} in a comment when it should start.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border-soft">
          {threads.map((thread) => {
            const state = thread.archived ? "Archived" : THREAD_STATE_WORD[thread.dot];
            // The server's line, already in its words: read as Markdown again, names like `__init__` would lose their marks.
            const reply = thread.lastReply;
            return (
              <Link
                key={thread.threadId}
                to={threadHref(thread.threadId)}
                data-slot="task-thread-row"
                onClick={openThread ? (event) => { event.preventDefault(); openThread(thread.threadId); } : undefined}
                className="flex flex-col gap-0.5 border-t border-border-soft px-2.5 py-2 transition-colors first:border-t-0 hover:bg-sel/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
              >
                <span className="flex min-w-0 items-center gap-2 text-[13px] text-foreground">
                  <ThreadStateMark dot={thread.archived ? "idle" : thread.dot} />
                  <span className="min-w-0 truncate">{thread.title}</span>
                  <span
                    data-slot="task-thread-state"
                    className={cn("ml-auto shrink-0 text-xs", thread.dot === "needs_you" && !thread.archived ? "font-semibold text-status-input-fg" : "text-faint")}
                  >
                    {state}
                  </span>
                </span>
                {reply && (
                  <span className="truncate pl-[18px] text-xs text-faint">
                    {reply}{thread.lastReplyAt ? ` · ${formatRelativeTime(thread.lastReplyAt, now)}` : ""}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}
