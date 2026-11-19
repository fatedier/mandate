import type { Database } from "bun:sqlite";
import { newId } from "../../platform/ids.js";
import type { AgentStore } from "../agent/agent-store.js";
import { threadDisplayTitle } from "../agent/manager-threads.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import type { Mention } from "../../../shared/mentions.js";
import type { TaskActor, TaskDetailDto, TaskDto, TaskEntryDto, TaskStatus } from "../../../shared/api/task-board.js";
import { isTaskStatus } from "../../../shared/task-board.js";
import { LABEL_REFUSED, labelName } from "../../../shared/labels.js";
import type { ThreadDot } from "../../../shared/thread-dot.js";
import { labelKey, TaskBoardStore, type TaskRow } from "./task-board-store.js";
import { entryDto, toTaskDetailDto, toTaskDto, type TaskViewDeps } from "./task-board-view.js";

/** A request the board refuses: its message is what the caller is told. */
/** A title is one line on the board and in every turn's context. */
const TITLE_MAX = 200;

function checkTitle(title: string): string {
  if (!title) throw new TaskBoardRefusal("a task needs a title");
  if (title.length > TITLE_MAX) throw new TaskBoardRefusal(`a task title is at most ${TITLE_MAX} characters`);
  return title;
}

export class TaskBoardRefusal extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
  }
}

export interface TaskBoardServiceDeps {
  db: Database;
  agentStore: AgentStore;
  sse: Pick<AgentSseEmitter, "emit">;
  threadDots: () => ReadonlyMap<string, ThreadDot>;
  now?: () => number;
  /** After a status change is written. */
  onStatusChanged?: (task: TaskDto, from: TaskStatus, by: TaskActor) => void;
  /** After a task is deleted (it can still be restored). */
  onRemoved?: (id: string) => void;
  /** The owner opened the task. */
  onOpened?: (id: string) => void;
  /** The projects these threads' workers ran in, by name: a task's automatic labels. */
  workRanIn?: (threadIds: readonly string[]) => readonly string[];
  /** The spelling some thread has for a label's name: tasks and threads share their names. */
  threadLabelSpelling?: (name: string) => string | null;
}


const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function checkDue(dueDate: string | null | undefined, dueTime: string | null | undefined): void {
  if (dueDate != null && !DATE.test(dueDate)) throw new TaskBoardRefusal("dueDate must be YYYY-MM-DD");
  if (dueTime != null && !TIME.test(dueTime)) throw new TaskBoardRefusal("dueTime must be HH:MM");
}

/**
 * The only writer of the board. Every change runs in one transaction that
 * also writes its line in the task's stream, and is told once (SSE) after
 * it commits. A status change goes through setStatus alone, so whatever is
 * added later to "a status changed" (a reminder, a next task) has one place.
 */
export class TaskBoardService {
  private readonly store: TaskBoardStore;
  private readonly now: () => number;
  private readonly view: TaskViewDeps;

  constructor(private readonly deps: TaskBoardServiceDeps) {
    this.store = new TaskBoardStore(deps.db);
    this.now = deps.now ?? (() => Date.now());
    this.view = { agentStore: deps.agentStore, threadDots: deps.threadDots, now: this.now, ...(deps.workRanIn ? { workRanIn: deps.workRanIn } : {}) };
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private row(id: string): TaskRow {
    const row = this.store.getTask(id);
    if (!row) throw new TaskBoardRefusal(`no such task: ${id}`, 404);
    return row;
  }

  private liveRow(id: string): TaskRow {
    const row = this.row(id);
    if (row.deletedAt) throw new TaskBoardRefusal(`no such task: ${id}`, 404);
    return row;
  }

  private dto(row: TaskRow): TaskDto {
    return toTaskDto(this.view, row, this.store.links(row.id), this.store.entries(row.id), this.store.labels(row.id));
  }

  /** Writes inside one transaction, then tells of the task once. */
  private write<T>(id: string, change: () => T): T {
    const result = this.deps.db.transaction(change).immediate();
    const row = this.store.getTask(id);
    if (row) this.deps.sse.emit(SSE_EVENTS.taskBoardTaskUpdated, { task: this.dto(row) });
    return result;
  }

  create(input: { title: string; description?: string; dueDate?: string | null; dueTime?: string | null }, by: TaskActor): TaskDto {
    const title = checkTitle(input.title?.trim() ?? "");
    checkDue(input.dueDate, input.dueTime);
    const at = this.iso();
    const row: TaskRow = {
      id: newId("tsk"), title, description: input.description ?? "", status: "todo",
      dueDate: input.dueDate ?? null, dueTime: input.dueDate ? input.dueTime ?? null : null,
      result: null, resultAt: null, createdAt: at, createdBy: by, updatedAt: at, deletedAt: null
    };
    this.write(row.id, () => this.store.insertTask(row));
    return this.dto(this.row(row.id));
  }

  /** The owner's fields; no line is written for them. */
  edit(id: string, patch: { title?: string; description?: string; dueDate?: string | null; dueTime?: string | null }): TaskDto {
    const row = this.liveRow(id);
    const fields: Partial<TaskRow> = {};
    if (patch.title !== undefined) {
      fields.title = checkTitle(patch.title.trim());
    }
    if (patch.description !== undefined) fields.description = patch.description;
    checkDue(patch.dueDate, patch.dueTime);
    if (patch.dueDate !== undefined) fields.dueDate = patch.dueDate;
    if (patch.dueTime !== undefined) fields.dueTime = patch.dueTime;
    // A time without a day means nothing: it goes with the day.
    if ((fields.dueDate === null) || (fields.dueDate === undefined && row.dueDate === null)) fields.dueTime = null;
    fields.updatedAt = this.iso();
    this.write(id, () => this.store.updateTask(id, fields));
    return this.dto(this.row(id));
  }

  /** The one way a status changes. The owner's change is a line; the agent's
   *  is its comment, carrying the status and the note. */
  setStatus(id: string, status: TaskStatus, by: TaskActor, note?: string): { task: TaskDto; changed: boolean } {
    if (!isTaskStatus(status)) throw new TaskBoardRefusal("unknown status");
    // The agent closes a task, or opens one again, only on the owner's word:
    // its prompt and its tool keep it to that; its note says why.
    const row = this.liveRow(id);
    if (row.status === status) return { task: this.dto(row), changed: false };
    const text = note?.trim() ?? "";
    if (by === "agent" && !text) throw new TaskBoardRefusal("a note is required");
    const at = this.iso();
    this.write(id, () => {
      this.store.updateTask(id, { status, updatedAt: at });
      this.store.addEntry({
        taskId: id, kind: by === "agent" ? "comment" : "status", by, text: by === "agent" ? text : "",
        status, threadId: null, threadTitle: null, newThread: false, createdAt: at
      });
    });
    const task = this.dto(this.row(id));
    this.deps.onStatusChanged?.(task, row.status, by);
    return { task, changed: true };
  }

  writeResult(id: string, markdown: string): TaskDto {
    const row = this.liveRow(id);
    const result = markdown.trim();
    if (!result) throw new TaskBoardRefusal("a Result needs text");
    const at = this.iso();
    this.write(id, () => {
      this.store.updateTask(id, { result, resultAt: at, updatedAt: at });
      this.store.addEntry({
        taskId: id, kind: "result", by: "agent", text: row.result ? "updated" : "wrote",
        status: null, threadId: null, threadTitle: null, newThread: false, createdAt: at
      });
    });
    return this.dto(this.row(id));
  }

  private agentMentioned: ((task: TaskDetailDto, entry: TaskEntryDto) => void) | null = null;

  /** What happens when the owner writes @<agent> in a comment: set by the
   *  runtime, which holds the agent's inbox. */
  setAgentMentioned(handler: (task: TaskDetailDto, entry: TaskEntryDto) => void): void {
    this.agentMentioned = handler;
  }

  /** A comment; the owner's with an agent mention wakes the personal agent
   *  once it is written. One without waits for the agent's next pass. */
  comment(id: string, text: string, by: TaskActor, mentions?: Mention[]): TaskEntryDto {
    this.liveRow(id);
    const body = text.trim();
    if (!body) throw new TaskBoardRefusal("a comment needs text");
    const at = this.iso();
    const entry = this.write(id, () => {
      this.store.updateTask(id, { updatedAt: at });
      return this.store.addEntry({ taskId: id, kind: "comment", by, text: body, status: null, threadId: null, threadTitle: null, newThread: false, createdAt: at });
    });
    const dto = entryDto(entry);
    if (by === "owner" && mentions?.some((m) => m.kind === "agent")) {
      const task = this.detail(id);
      if (task) this.agentMentioned?.(task, dto);
    }
    return dto;
  }

  /** False when the thread was linked already. */
  link(id: string, threadId: string, opts: { newThread?: boolean } = {}): boolean {
    this.liveRow(id);
    if (!this.deps.agentStore.getThreadById(threadId)) throw new TaskBoardRefusal(`no such thread: ${threadId}`, 404);
    const at = this.iso();
    const title = threadDisplayTitle(this.deps.agentStore, threadId);
    let added = false;
    this.write(id, () => {
      added = this.store.addLink(id, threadId, at);
      if (!added) return;
      this.store.updateTask(id, { updatedAt: at });
      this.store.addEntry({ taskId: id, kind: "link", by: "agent", text: "", status: null, threadId, threadTitle: title, newThread: Boolean(opts.newThread), createdAt: at });
    });
    return added;
  }

  unlink(id: string, threadId: string): boolean {
    this.liveRow(id);
    const at = this.iso();
    const title = this.deps.agentStore.getThreadById(threadId) ? threadDisplayTitle(this.deps.agentStore, threadId) : null;
    let removed = false;
    this.write(id, () => {
      removed = this.store.removeLink(id, threadId);
      if (!removed) return;
      this.store.updateTask(id, { updatedAt: at });
      this.store.addEntry({ taskId: id, kind: "unlink", by: "agent", text: "", status: null, threadId, threadTitle: title, newThread: false, createdAt: at });
    });
    return removed;
  }

  /** A label on the task, by name: one the board has keeps its spelling;
   *  the owner putting on the agent's makes it theirs. No line is written. */
  addLabel(id: string, name: string, by: TaskActor): TaskDto {
    const trimmed = labelName(name);
    if (trimmed === null) throw new TaskBoardRefusal(LABEL_REFUSED);
    this.liveRow(id);
    const spelling = this.labelSpelling(trimmed) ?? this.deps.threadLabelSpelling?.(trimmed) ?? trimmed;
    this.write(id, () => {
      const had = this.store.labels(id).find((l) => labelKey(l.name) === labelKey(spelling));
      if (had && (had.by === by || by === "agent")) return;
      this.store.putLabel(id, had?.name ?? spelling, by, this.iso());
    });
    return this.dto(this.liveRow(id));
  }

  /** The spelling the board has for a name: a label put on some task by
   *  hand, or an automatic one; null when no task has it. */
  labelSpelling(name: string): string | null {
    return this.store.labelSpelling(name) ?? this.automaticSpelling(name);
  }

  /** The spelling of an automatic label some task has, by name. */
  private automaticSpelling(name: string): string | null {
    if (!this.deps.workRanIn) return null;
    const rows = [...this.store.listTasks(false), ...this.store.listTasks(true)];
    for (const row of rows) {
      const found = this.deps.workRanIn(this.store.links(row.id).map((l) => l.threadId)).find((n) => labelKey(n) === labelKey(name));
      if (found) return found;
    }
    return null;
  }

  /** A hand label off the task; an automatic one cannot be, even where a
   *  hand label of its name lies under it (kept for when the thread goes). */
  removeLabel(id: string, name: string): TaskDto {
    const row = this.liveRow(id);
    const auto = this.dto(row).labels.find((l) => l.by === "auto" && labelKey(l.name) === labelKey(name.trim()));
    if (auto) throw new TaskBoardRefusal(`"${auto.name}" is automatic: it comes from where the task's threads ran, and cannot be removed.`);
    const removed = this.deps.db.transaction(() => this.store.removeLabel(id, name.trim())).immediate();
    if (!removed) throw new TaskBoardRefusal(`That task has no label "${name.trim()}".`);
    const task = this.dto(this.liveRow(id));
    this.deps.sse.emit(SSE_EVENTS.taskBoardTaskUpdated, { task });
    return task;
  }

  /** Hidden at once, to Recently deleted: kept there, restorable, until
   *  the owner deletes it forever. */
  remove(id: string): void {
    this.liveRow(id);
    const at = this.iso();
    this.write(id, () => this.store.updateTask(id, { deletedAt: at, updatedAt: at }));
    this.deps.onRemoved?.(id);
  }

  restore(id: string): void {
    const row = this.row(id);
    if (!row.deletedAt) return;
    this.write(id, () => this.store.updateTask(id, { deletedAt: null, updatedAt: this.iso() }));
  }

  removeAllDone(): number {
    const done = this.store.listTasks(false).filter((t) => t.status === "done");
    for (const task of done) this.remove(task.id);
    return done.length;
  }

  /** A task in Recently deleted, gone for good with its lines, thread
   *  links and labels; the threads stay. One on the board is deleted first. */
  deleteForever(id: string): void {
    const row = this.row(id);
    if (!row.deletedAt) throw new TaskBoardRefusal(`no such task in Recently deleted: ${id}`, 409);
    this.deps.db.transaction(() => this.store.deleteTask(id)).immediate();
    this.deps.sse.emit(SSE_EVENTS.taskBoardTaskRemoved, { id });
  }

  list(opts: { deleted?: boolean } = {}): TaskDto[] {
    return this.store.listTasks(Boolean(opts.deleted)).map((row) => this.dto(row));
  }

  /** The owner opened the task: what was waiting on them there is seen. */
  opened(id: string): void {
    this.deps.onOpened?.(id);
  }

  detail(id: string): TaskDetailDto | null {
    const row = this.store.getTask(id);
    return row ? toTaskDetailDto(this.view, row, this.store.links(id), this.store.entries(id), this.store.labels(id)) : null;
  }

  tasksOfThread(threadId: string): TaskDto[] {
    return this.store.taskIdsOfThread(threadId)
      .map((id) => this.store.getTask(id))
      .filter((row): row is TaskRow => row !== null && row.deletedAt === null)
      .map((row) => this.dto(row));
  }

  /** A thread's turn ended: the tasks it is linked to are told again, with
   *  its latest reply. */
  threadChanged(threadId: string): void {
    for (const id of this.store.taskIdsOfThread(threadId)) {
      const row = this.store.getTask(id);
      if (row && !row.deletedAt) this.deps.sse.emit(SSE_EVENTS.taskBoardTaskUpdated, { task: this.dto(row) });
    }
  }

  state(): Pick<TaskBoardStore, "getState" | "setState"> {
    return this.store;
  }
}
