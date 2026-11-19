import type { Database } from "bun:sqlite";
import { newId } from "../../platform/ids.js";
import type { TaskActor, TaskEntryDto, TaskStatus } from "../../../shared/api/task-board.js";
import { labelKey } from "../../../shared/labels.js";

export interface TaskRow {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  dueDate: string | null;
  dueTime: string | null;
  result: string | null;
  resultAt: string | null;
  createdAt: string;
  createdBy: TaskActor;
  updatedAt: string;
  deletedAt: string | null;
}

export interface LinkRow {
  taskId: string;
  threadId: string;
  linkedAt: string;
}

export type EntryRow = Omit<TaskEntryDto, "threadTitle"> & { taskId: string; threadTitle: string | null };

/** A label put on a task by hand (the owner's or the agent's). */
export interface LabelRow {
  name: string;
  by: TaskActor;
}

export { labelKey };

interface RawTask {
  id: string; title: string; description: string; status: string; due_date: string | null; due_time: string | null;
  result: string | null; result_at: string | null; created_at: string; created_by: string; updated_at: string; deleted_at: string | null;
}
interface RawEntry {
  id: string; task_id: string; seq: number; kind: string; by_actor: string; text: string; status: string | null;
  thread_id: string | null; thread_title: string | null; new_thread: number; created_at: string;
}

const task = (r: RawTask): TaskRow => ({
  id: r.id, title: r.title, description: r.description, status: r.status as TaskStatus, dueDate: r.due_date, dueTime: r.due_time,
  result: r.result, resultAt: r.result_at, createdAt: r.created_at, createdBy: r.created_by as TaskActor, updatedAt: r.updated_at, deletedAt: r.deleted_at
});
const entry = (r: RawEntry): EntryRow => ({
  id: r.id, taskId: r.task_id, seq: r.seq, kind: r.kind as EntryRow["kind"], by: r.by_actor as TaskActor, text: r.text,
  status: (r.status as TaskStatus | null) ?? null, threadId: r.thread_id, threadTitle: r.thread_title, newThread: r.new_thread === 1, createdAt: r.created_at
});

/** Rows in and out; no events, no rules. TaskBoardService is the only writer. */
export class TaskBoardStore {
  constructor(private readonly db: Database) {}

  insertTask(row: TaskRow): void {
    this.db.prepare(
      `insert into task_board_tasks (id, title, description, status, due_date, due_time, result, result_at, created_at, created_by, updated_at, deleted_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(row.id, row.title, row.description, row.status, row.dueDate, row.dueTime, row.result, row.resultAt, row.createdAt, row.createdBy, row.updatedAt, row.deletedAt);
  }

  getTask(id: string): TaskRow | null {
    const r = this.db.prepare(`select * from task_board_tasks where id = ?`).get(id) as RawTask | null;
    return r ? task(r) : null;
  }

  /** Live tasks, or the deleted ones; oldest first. */
  listTasks(deleted: boolean): TaskRow[] {
    return (this.db.prepare(
      `select * from task_board_tasks where deleted_at is ${deleted ? "not null" : "null"} order by created_at, rowid`
    ).all() as RawTask[]).map(task);
  }

  updateTask(id: string, fields: Partial<Omit<TaskRow, "id" | "createdAt" | "createdBy">>): void {
    const columns: Record<string, string> = {
      title: "title", description: "description", status: "status", dueDate: "due_date", dueTime: "due_time",
      result: "result", resultAt: "result_at", updatedAt: "updated_at", deletedAt: "deleted_at"
    };
    const keys = Object.keys(fields).filter((k) => k in columns);
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${columns[k]} = ?`).join(", ");
    const values = keys.map((k) => (fields as Record<string, string | null>)[k] ?? null);
    this.db.prepare(`update task_board_tasks set ${sets} where id = ?`).run(...values, id);
  }

  entries(taskId: string): EntryRow[] {
    return (this.db.prepare(`select * from task_board_entries where task_id = ? order by seq`).all(taskId) as RawEntry[]).map(entry);
  }

  addEntry(input: Omit<EntryRow, "id" | "seq">): EntryRow {
    const next = (this.db.prepare(`select coalesce(max(seq), 0) + 1 as seq from task_board_entries where task_id = ?`).get(input.taskId) as { seq: number }).seq;
    const row: EntryRow = { ...input, id: newId("tke"), seq: next };
    this.db.prepare(
      `insert into task_board_entries (id, task_id, seq, kind, by_actor, text, status, thread_id, thread_title, new_thread, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(row.id, row.taskId, row.seq, row.kind, row.by, row.text, row.status, row.threadId, row.threadTitle, row.newThread ? 1 : 0, row.createdAt);
    return row;
  }

  links(taskId: string): LinkRow[] {
    return (this.db.prepare(`select task_id, thread_id, linked_at from task_board_threads where task_id = ? order by linked_at, rowid`).all(taskId) as Array<{ task_id: string; thread_id: string; linked_at: string }>)
      .map((r) => ({ taskId: r.task_id, threadId: r.thread_id, linkedAt: r.linked_at }));
  }

  taskIdsOfThread(threadId: string): string[] {
    return (this.db.prepare(`select task_id from task_board_threads where thread_id = ? order by linked_at, rowid`).all(threadId) as Array<{ task_id: string }>).map((r) => r.task_id);
  }

  /** False when the link was there already. */
  addLink(taskId: string, threadId: string, at: string): boolean {
    return this.db.prepare(`insert or ignore into task_board_threads (task_id, thread_id, linked_at) values (?, ?, ?)`).run(taskId, threadId, at).changes > 0;
  }

  removeLink(taskId: string, threadId: string): boolean {
    return this.db.prepare(`delete from task_board_threads where task_id = ? and thread_id = ?`).run(taskId, threadId).changes > 0;
  }

  labels(taskId: string): LabelRow[] {
    return (this.db.prepare(`select name, by_actor from task_board_labels where task_id = ? order by added_at, rowid`).all(taskId) as Array<{ name: string; by_actor: string }>)
      .map((r) => ({ name: r.name, by: r.by_actor as TaskActor }));
  }

  /** The spelling the board already has for a name, on any task. */
  labelSpelling(name: string): string | null {
    return (this.db.prepare(`select name from task_board_labels where name_key = ? order by added_at, rowid limit 1`).get(labelKey(name)) as { name: string } | null)?.name ?? null;
  }

  /** A label on, or its author changed when it is there. */
  putLabel(taskId: string, name: string, by: TaskActor, at: string): void {
    this.db.prepare(
      `insert into task_board_labels (task_id, name, name_key, by_actor, added_at) values (?, ?, ?, ?, ?)
        on conflict (task_id, name_key) do update set by_actor = excluded.by_actor`
    ).run(taskId, name, labelKey(name), by, at);
  }

  removeLabel(taskId: string, name: string): boolean {
    return this.db.prepare(`delete from task_board_labels where task_id = ? and name_key = ?`).run(taskId, labelKey(name)).changes > 0;
  }

  /** A task, with its lines, thread links and labels. */
  deleteTask(id: string): void {
    this.db.prepare(`delete from task_board_entries where task_id = ?`).run(id);
    this.db.prepare(`delete from task_board_threads where task_id = ?`).run(id);
    this.db.prepare(`delete from task_board_labels where task_id = ?`).run(id);
    this.db.prepare(`delete from task_board_tasks where id = ?`).run(id);
  }

  getState(key: string): string | null {
    return (this.db.prepare(`select value from task_board_state where key = ?`).get(key) as { value: string } | null)?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.db.prepare(`insert into task_board_state (key, value) values (?, ?) on conflict(key) do update set value = excluded.value`).run(key, value);
  }
}
