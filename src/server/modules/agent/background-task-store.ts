import type { Database } from "bun:sqlite";
import type {
  BackgroundTaskDto,
  BackgroundTaskKind,
  BackgroundTaskStatus,
  BackgroundTaskStoppedBy,
  SubagentType
} from "../../../shared/api/background-tasks.js";
import { newId } from "../../platform/ids.js";

interface RawBackgroundTask {
  id: string;
  kind: string;
  parent_thread_id: string;
  child_thread_id: string | null;
  type: string;
  title: string;
  status: string;
  stopped_by: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  seq: number;
  exit_code: number | null;
  output_path: string | null;
  command: string | null;
}

/** What a task is read as: every column but a subagent's text (its child's
 *  first message has it) and its reply (its child's last message has it); a
 *  command's text is its command line, read as `command`. */
const COLUMNS = `id, kind, parent_thread_id, child_thread_id, type, title, status, stopped_by,
  error, created_at, started_at, finished_at, seq, exit_code, output_path,
  case when kind = 'command' then task end as command`;

/** Creation order; rowid breaks a tie between two tasks made in one millisecond. */
const OLDEST_FIRST = "order by created_at asc, rowid asc";
const NEWEST_FIRST = "order by created_at desc, rowid desc";

export interface CreateBackgroundTaskInput {
  /** The id the child's thread was made for (it is that thread's scope id);
   *  a new one when absent. */
  id?: string;
  parentThreadId: string;
  childThreadId: string;
  type: SubagentType;
  title: string;
  /** The brief, as the agent that started it wrote it. */
  task: string;
}

/** How a task ended. */
export interface FinishBackgroundTaskInput {
  status: Exclude<BackgroundTaskStatus, "queued" | "running">;
  /** Kept for a stopped task only. */
  stoppedBy?: BackgroundTaskStoppedBy | null;
  reply: string | null;
  error: string | null;
  at: string;
}

function toTask(r: RawBackgroundTask): BackgroundTaskDto {
  return {
    id: r.id,
    kind: r.kind as BackgroundTaskKind,
    parentThreadId: r.parent_thread_id,
    childThreadId: r.child_thread_id,
    type: r.type as SubagentType,
    title: r.title,
    status: r.status as BackgroundTaskStatus,
    stoppedBy: r.stopped_by as BackgroundTaskStoppedBy | null,
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    seq: r.seq,
    exitCode: r.exit_code,
    command: r.command,
    outputPath: r.output_path
  };
}

/** The background tasks conversations start: one row per task, from queued
 *  to how it ended. */
/** The running commands' output files. The open-task index's own predicate
 *  is repeated so SQLite uses it: read every hour, it costs what is open, not
 *  the history of ended tasks. */
export const RUNNING_OUTPUT_PATHS_SQL = `select output_path from background_tasks
  where status in ('queued', 'running') and status = 'running' and kind = 'command' and output_path is not null`;

export class BackgroundTaskStore {
  constructor(private readonly db: Database) {}

  create(input: CreateBackgroundTaskInput): BackgroundTaskDto {
    const id = input.id ?? newId("task");
    const now = new Date().toISOString();
    this.numbered((seq) => this.db.prepare(
      `insert into background_tasks
         (id, kind, parent_thread_id, child_thread_id, type, title, task, status, created_at, seq)
       values (?, 'subagent', ?, ?, ?, ?, ?, 'queued', ?, ?)`
    ).run(id, input.parentThreadId, input.childThreadId, input.type, input.title, input.task, now, seq));
    return this.get(id)!;
  }

  /** A change of a task, written with the next number, which the count then
   *  holds; one that does not happen (no row changed) takes none. */
  private numbered(write: (seq: number) => { changes: number }): { changes: number } {
    return this.db.transaction(() => {
      const seq = this.latestSeq() + 1;
      const result = write(seq);
      if (result.changes > 0) this.db.prepare(`update background_task_seq set n = ?`).run(seq);
      return result;
    }).immediate();
  }

  get(id: string): BackgroundTaskDto | null {
    const row = this.db.prepare(`select ${COLUMNS} from background_tasks where id = ?`)
      .get(id) as RawBackgroundTask | null | undefined;
    return row ? toTask(row) : null;
  }

  getByChildThread(childThreadId: string): BackgroundTaskDto | null {
    const row = this.db.prepare(`select ${COLUMNS} from background_tasks where child_thread_id = ?`)
      .get(childThreadId) as RawBackgroundTask | null | undefined;
    return row ? toTask(row) : null;
  }

  /** A conversation's tasks as its list reads them: with no `before`, every
   *  open one, newest first, then its `limit` latest done ones; with it, the
   *  done ones after that point. Done ones go by when they ended, the latest
   *  first, their ids breaking a tie. `olderDone` points past the last one
   *  read; null when none is left. `seq`: the greatest number of any task
   *  when it was read (changedSince reads what changed after it). */
  pageForThread(parentThreadId: string, { before, limit }: { before: string | null; limit: number }): { tasks: BackgroundTaskDto[]; olderDone: string | null; seq: number } {
    // One read: the number it reflects is the page's own.
    return this.db.transaction(() => ({ ...this.readPage(parentThreadId, before, limit), seq: this.latestSeq() }))();
  }

  /** A conversation's tasks changed after `since`, in the order they changed,
   *  and the greatest number of any task when they were read. */
  changedSince(parentThreadId: string, since: number): { tasks: BackgroundTaskDto[]; seq: number } {
    return this.db.transaction(() => {
      const rows = this.db.prepare(
        `select ${COLUMNS} from background_tasks where parent_thread_id = ? and seq > ? order by seq asc`
      ).all(parentThreadId, since) as RawBackgroundTask[];
      return { tasks: rows.map(toTask), seq: this.latestSeq() };
    })();
  }

  /** The greatest number any change of a task has taken. */
  private latestSeq(): number {
    return (this.db.prepare(`select n from background_task_seq`).get() as { n: number }).n;
  }

  private readPage(parentThreadId: string, before: string | null, limit: number): { tasks: BackgroundTaskDto[]; olderDone: string | null } {
    const open = before === null
      ? (this.db.prepare(
          `select ${COLUMNS} from background_tasks
            where parent_thread_id = ? and status in ('queued', 'running') ${NEWEST_FIRST}`
        ).all(parentThreadId) as RawBackgroundTask[])
      : [];
    const after = before === null ? null : parseDoneCursor(before);
    const done = this.db.prepare(
      `select ${COLUMNS} from background_tasks
        where parent_thread_id = ? and status not in ('queued', 'running')
          and (? is null or finished_at < ? or (finished_at = ? and id < ?))
        order by finished_at desc, id desc limit ?`
    ).all(parentThreadId, after?.finishedAt ?? null, after?.finishedAt ?? null, after?.finishedAt ?? null, after?.id ?? null, limit + 1) as RawBackgroundTask[];
    const shown = done.slice(0, limit);
    const last = shown.at(-1);
    return {
      tasks: [...open, ...shown].map(toTask),
      olderDone: done.length > limit && last ? `${last.finished_at}|${last.id}` : null
    };
  }

  /** Every conversation's queued and running tasks (of one kind, or all),
   *  oldest first: what a restart finds unfinished. */
  listOpen(kind: BackgroundTaskKind | null = null): BackgroundTaskDto[] {
    const rows = this.db.prepare(
      `select ${COLUMNS} from background_tasks
        where status in ('queued', 'running') and (? is null or kind = ?) ${OLDEST_FIRST}`
    ).all(kind, kind) as RawBackgroundTask[];
    return rows.map(toTask);
  }

  /** How many of a conversation's tasks (of one kind, or all) run now: the
   *  subagents' queue counts subagents, the commands' limit commands. */
  countRunning(parentThreadId: string, kind: BackgroundTaskKind | null = null): number {
    const row = this.db.prepare(
      `select count(*) as n from background_tasks
        where parent_thread_id = ? and status = 'running' and (? is null or kind = ?)`
    ).get(parentThreadId, kind, kind) as { n: number };
    return row.n;
  }

  /** The subagent that has waited longest — a conversation's, or any (null),
   *  of one type or any (null): the next to start (a command never waits). */
  oldestQueued(parentThreadId: string | null, type: SubagentType | null = null): BackgroundTaskDto | null {
    const row = this.db.prepare(
      `select ${COLUMNS} from background_tasks
        where (? is null or parent_thread_id = ?) and status = 'queued' and kind = 'subagent'
          and (? is null or type = ?) ${OLDEST_FIRST} limit 1`
    ).get(parentThreadId, parentThreadId, type, type) as RawBackgroundTask | null | undefined;
    return row ? toTask(row) : null;
  }

  /** How many subagents of one type run now: a conversation's, or every one's (null). */
  countRunningSubagents(type: SubagentType, parentThreadId: string | null = null): number {
    const row = this.db.prepare(
      `select count(*) as n from background_tasks
        where (? is null or parent_thread_id = ?) and status = 'running' and kind = 'subagent' and type = ?`
    ).get(parentThreadId, parentThreadId, type) as { n: number };
    return row.n;
  }

  /** A background command, running from the start (it never queues). */
  createCommand(input: { id?: string; parentThreadId: string; title: string; command: string; outputPath: string; pid: number | null; startedAt: string }): BackgroundTaskDto {
    const id = input.id ?? newId("task");
    this.numbered((seq) => this.db.prepare(
      `insert into background_tasks
         (id, kind, parent_thread_id, child_thread_id, type, title, task, status, created_at, started_at, seq, output_path, pid)
       values (?, 'command', ?, null, 'general', ?, ?, 'running', ?, ?, ?, ?, ?)`
    ).run(id, input.parentThreadId, input.title, input.command, input.startedAt, input.startedAt, seq, input.outputPath, input.pid));
    return this.get(id)!;
  }

  /** A command ends, once, with its exit code (null: stopped, or killed by a
   *  signal). Null when it had already ended, or is not a command. */
  finishCommand(id: string, input: FinishBackgroundTaskInput & { exitCode: number | null; outputLines?: number | null }): BackgroundTaskDto | null {
    const result = this.numbered((seq) => this.db.prepare(
      `update background_tasks
          set status = ?, stopped_by = ?, reply = ?, error = ?, finished_at = ?, exit_code = ?, output_lines = ?, seq = ?
        where id = ? and kind = 'command' and status = 'running'`
    ).run(
      input.status,
      input.status === "stopped" ? input.stoppedBy ?? null : null,
      input.reply,
      input.error,
      input.at,
      input.exitCode,
      input.outputLines ?? null,
      seq,
      id
    ));
    return result.changes > 0 ? this.get(id) : null;
  }

  /** A command's process group, as recorded: a restart kills it. */
  pidOf(id: string): number | null {
    const row = this.db.prepare(`select pid from background_tasks where id = ?`)
      .get(id) as { pid: number | null } | null | undefined;
    return row?.pid ?? null;
  }

  /** Its process group is gone (the server killed it as it stopped): a
   *  later start has nothing to kill by that id, which may be another's. */
  clearPid(id: string): void {
    this.db.prepare(`update background_tasks set pid = null where id = ? and kind = 'command'`).run(id);
  }

  /** An ended command's line count, as recorded at its end; null when none was. */
  outputLinesOf(id: string): number | null {
    const row = this.db.prepare(`select output_lines from background_tasks where id = ?`)
      .get(id) as { output_lines: number | null } | null | undefined;
    return row?.output_lines ?? null;
  }

  /** The output files running commands still write: retention keeps them. */
  runningOutputPaths(): string[] {
    const rows = this.db.prepare(RUNNING_OUTPUT_PATHS_SQL).all() as Array<{ output_path: string }>;
    return rows.map((row) => row.output_path);
  }

  /** A queued task starts. Returns the task as it now is: running, or, when
   *  it was no longer queued (stopped while it waited), as it was. */
  markRunning(id: string, at: string): BackgroundTaskDto {
    this.numbered((seq) => this.db.prepare(
      `update background_tasks set status = 'running', started_at = ?, seq = ? where id = ? and status = 'queued' and kind = 'subagent'`
    ).run(at, seq, id));
    const task = this.get(id);
    if (!task) throw new Error(`background task not found: ${id}`);
    return task;
  }

  /** A task ends, once: a stop and the end of its wake can both come, and
   *  only the first counts. Null when it had already ended, or there is no
   *  such task. */
  finish(id: string, input: FinishBackgroundTaskInput): BackgroundTaskDto | null {
    const result = this.numbered((seq) => this.db.prepare(
      `update background_tasks
          set status = ?, stopped_by = ?, reply = ?, error = ?, finished_at = ?, seq = ?
        where id = ? and status in ('queued', 'running') and kind = 'subagent'`
    ).run(
      input.status,
      input.status === "stopped" ? input.stoppedBy ?? null : null,
      input.reply,
      input.error,
      input.at,
      seq,
      id
    ));
    return result.changes > 0 ? this.get(id) : null;
  }

  /** Its reply as its conversation was told it; none while it runs. */
  replyOf(id: string): string | null {
    const row = this.db.prepare(`select reply from background_tasks where id = ?`)
      .get(id) as { reply: string | null } | null | undefined;
    return row?.reply ?? null;
  }

  /** The brief its child's first message carries. */
  taskText(id: string): string | null {
    const row = this.db.prepare(`select task from background_tasks where id = ?`)
      .get(id) as { task: string } | null | undefined;
    return row?.task ?? null;
  }

  /** The threads the tasks of these conversations run in, oldest first:
   *  what deleting the conversations deletes with them. */
  childThreadIdsOf(parentThreadIds: readonly string[]): string[] {
    if (parentThreadIds.length === 0) return [];
    const rows = this.db.prepare(
      `select child_thread_id from background_tasks
        where parent_thread_id in (select value from json_each(?)) and child_thread_id is not null ${OLDEST_FIRST}`
    ).all(JSON.stringify(parentThreadIds)) as Array<{ child_thread_id: string }>;
    return rows.map((row) => row.child_thread_id);
  }
}

/** A point in a conversation's done tasks (pageForThread's `olderDone`): when
 *  the last one read ended, and its id. One that is not such a point reads
 *  as the start. */
function parseDoneCursor(cursor: string): { finishedAt: string; id: string } | null {
  const at = cursor.lastIndexOf("|");
  if (at <= 0 || at === cursor.length - 1) return null;
  return { finishedAt: cursor.slice(0, at), id: cursor.slice(at + 1) };
}
