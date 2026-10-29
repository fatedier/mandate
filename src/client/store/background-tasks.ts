import { useEffect, useState } from "react";
import { create } from "zustand";
import {
  API_PATHS,
  type BackgroundTaskChangesDto,
  type BackgroundTaskDetailDto,
  type BackgroundTaskDto,
  type BackgroundTasksPageDto,
  type BackgroundTaskStatus
} from "@shared/api-contracts";
import { errorText } from "@shared/error-text";
import { apiPath } from "@/lib/api-base";
import { readJson } from "@/lib/api-json";

/**
 * Each conversation's background tasks (its subagents, today), for the line
 * where one started, the strip above the composer and the Background tasks
 * list, read as a conversation's messages are: its open tasks and latest
 * done ones the first time a part of its page asks (GET agentThreadTasks),
 * older done ones a page at a time (loadOlder), kept current by
 * backgroundTaskChanged, and, after the stream was down (SSE has no
 * replay), brought up to date with what changed after the number its last
 * read reflected (?since=).
 *
 * Each change of a task takes the next number of all tasks (its seq): of
 * two copies of one, the one with the greater is the later, whatever came
 * first, a read, an event, Stop's answer or a detail.
 *
 * A task's brief and reply are not in the list: its detail (loadDetail)
 * reads them, and brings a task older than the pages read (a line in the
 * transcript names it).
 */

/** `held` with `task` taken in, unless the copy held is as late. A task not
 *  held yet goes first: it is the newest. Nothing changed, `held` itself. */
function withTask(held: BackgroundTaskDto[], task: BackgroundTaskDto): BackgroundTaskDto[] {
  const index = held.findIndex((t) => t.id === task.id);
  if (index < 0) return [task, ...held];
  if (held[index]!.seq >= task.seq) return held;
  const next = [...held];
  next[index] = task;
  return next;
}

const isDone = (task: BackgroundTaskDto) => task.status !== "queued" && task.status !== "running";

/** `live` without the lines of `tasks` that have ended; itself when none is held. */
function withoutEnded(live: Map<string, LiveOutput>, tasks: readonly BackgroundTaskDto[]): Map<string, LiveOutput> {
  const ended = tasks.filter((task) => isDone(task) && live.has(task.id));
  if (ended.length === 0) return live;
  const next = new Map(live);
  for (const task of ended) next.delete(task.id);
  return next;
}

/** Whether done task `a` comes before `b` in the list's order (the later
 *  to end first, the greater id breaking a tie), or is `b`. */
function notAfter(a: BackgroundTaskDto, b: BackgroundTaskDto): boolean {
  const at = a.finishedAt ?? "";
  const bt = b.finishedAt ?? "";
  return at !== bt ? at > bt : a.id >= b.id;
}

/** Whether a task its conversation's tasks do not hold falls where its pages
 *  reach: an open one (every open one is read whole), or one that ended no
 *  earlier than the oldest done one held (one that ended after the read was
 *  taken always has). One that does not is older than the pages: not listed
 *  until a page brings it. */
function withinPages(task: BackgroundTaskDto, held: readonly BackgroundTaskDto[], pages: TaskPages | undefined): boolean {
  if (!isDone(task) || !pages) return true;
  const done = held.filter(isDone);
  if (done.length === 0) return true;
  const oldest = done.reduce((a, b) => (notAfter(a, b) ? b : a));
  return notAfter(task, oldest);
}

/** What a conversation's list knows past the tasks it holds. */
export interface TaskPages {
  /** Where its next page of done tasks starts; null: none left. */
  olderDone: string | null;
  loadingOlder: boolean;
  /** The greatest task number its reads reflect: what changed after it is read after the stream was down. */
  seq: number;
}

/** A task's brief and reply, as its detail shows them (a command's: its
 *  command, and its output's end with how much there is and where). */
export interface TaskDetail {
  brief: string;
  reply: string | null;
  stepCount: number;
  output?: { shownLines: number; totalLines: number; bytes: number; path: string };
  /** The status it had when read: one that has moved on since is read again. */
  status: BackgroundTaskStatus;
}

/** A running command's output as it comes (backgroundTaskOutput): not
 *  stored by the server, gone when it ends. */
export interface LiveOutput {
  lastLine: string;
  bytes: number;
  lines: number;
}

interface BackgroundTasksState {
  /** Each running command's last line, by its task id. */
  liveLines: Map<string, LiveOutput>;
  /** A running command's output event. */
  applyOutput: (event: { taskId: string; parentThreadId: string } & LiveOutput) => void;
  /** Each conversation's tasks, newest first, by its thread id: present once read. */
  byThread: Map<string, BackgroundTaskDto[]>;
  /** Each conversation's paging, beside its tasks. */
  pages: Map<string, TaskPages>;
  /** Each task's detail read here, by its id. */
  details: Map<string, TaskDetail>;
  /** Tasks read by their id that are older than their conversation's pages. */
  loose: Map<string, BackgroundTaskDto>;
  /** Reads a conversation's next page of done tasks. Resolves with null, or why not. */
  loadOlder: (threadId: string) => Promise<string | null>;
  /** Reads a task's detail (its brief, its reply, how many calls it made);
   *  one read at a time per task. */
  loadDetail: (taskId: string) => Promise<void>;
  /** Reads a conversation's tasks: once, unless `again` (after the stream was
   *  down: what changed after its last read); one read at a time per thread,
   *  shared by whoever asks. */
  load: (threadId: string, options?: { again?: boolean }) => Promise<void>;
  /** A task as the server has it now: an event, Stop's answer or a detail.
   *  Dropped for a conversation not read here: its read, when one comes,
   *  has it. */
  apply: (task: BackgroundTaskDto) => void;
  /** Asks the server to stop a task (POST agentTaskStop). Resolves with null
   *  once it took it, else with why not. One request per task at a time:
   *  asked again meanwhile, it answers as that one does. */
  stop: (taskId: string) => Promise<string | null>;
  /** The tasks whose Stop is on its way, so every Stop of one says so,
   *  wherever its row is drawn (moving between sections draws it anew). */
  stopping: ReadonlySet<string>;
}

/** Reads on their way, each with the tasks heard of meanwhile for a
 *  conversation not read yet (its first read lays them over what it read),
 *  and the read asked for again while it was on its way, which follows it. */
interface Read { request: Promise<void>; early: BackgroundTaskDto[]; again?: Promise<void> }
const reads = new Map<string, Read>();

/** Conversations whose read was asked for and failed: none of their tasks is
 *  held, so nothing else would read them again; a reconnect does. */
const unread = new Set<string>();

/** Tasks a line asked for by their id whose read failed: a reconnect reads them again. */
const unreadTasks = new Set<string>();

/** Stops on their way, by task. */
const stops = new Map<string, Promise<string | null>>();

/** Detail reads on their way, by task. */
const detailReads = new Map<string, Promise<void>>();

async function readPage(threadId: string, before: string | null = null): Promise<BackgroundTasksPageDto> {
  const body = await readJson<Partial<BackgroundTasksPageDto>>(await fetch(apiPath(API_PATHS.agentThreadTasks(threadId, { before }))));
  if (!Array.isArray(body.tasks)) throw new Error("The server answered without the conversation's tasks.");
  return { tasks: body.tasks, olderDone: typeof body.olderDone === "string" ? body.olderDone : null, seq: typeof body.seq === "number" ? body.seq : 0 };
}

async function readChanges(threadId: string, since: number): Promise<BackgroundTaskChangesDto> {
  const body = await readJson<Partial<BackgroundTaskChangesDto>>(await fetch(apiPath(API_PATHS.agentThreadTasks(threadId, { since }))));
  if (!Array.isArray(body.tasks)) throw new Error("The server answered without the conversation's tasks.");
  return { tasks: body.tasks, seq: typeof body.seq === "number" ? body.seq : since };
}

export const useBackgroundTasksStore = create<BackgroundTasksState>((set, get) => ({
  byThread: new Map(),
  pages: new Map(),
  details: new Map(),
  loose: new Map(),
  liveLines: new Map(),

  // Kept only for a command held here and running: one of a conversation not
  // read here, or one that ended, would never be dropped.
  applyOutput: (event) => {
    const state = get();
    const task = state.byThread.get(event.parentThreadId)?.find((t) => t.id === event.taskId) ?? state.loose.get(event.taskId);
    if (!task || task.status !== "running") return;
    set((s) => ({ liveLines: new Map(s.liveLines).set(event.taskId, { lastLine: event.lastLine, bytes: event.bytes, lines: event.lines }) }));
  },

  load: (threadId, options = {}) => {
    const pending = reads.get(threadId);
    if (pending && !options.again) return pending.request;
    // Asked again (after the stream was down) while a read is on its way:
    // that one may have been taken before what the outage hid. One more
    // follows it, however many ask.
    if (pending) return (pending.again ??= pending.request.catch(() => {}).then(() => get().load(threadId, { again: true })));
    if (get().byThread.has(threadId) && !options.again) return Promise.resolve();
    const entry: Read = { request: Promise.resolve(), early: [] };
    reads.set(threadId, entry);
    const since = get().pages.get(threadId)?.seq;
    const request = since === undefined
      ? readPage(threadId).then((read) => set((state) => {
          // What it read, with what was heard of while it was on its way.
          let tasks = read.tasks;
          for (const task of [...(state.byThread.get(threadId) ?? []), ...entry.early]) tasks = withTask(tasks, task);
          return {
            byThread: new Map(state.byThread).set(threadId, tasks),
            pages: new Map(state.pages).set(threadId, { olderDone: read.olderDone, loadingOlder: false, seq: read.seq }),
            liveLines: withoutEnded(state.liveLines, tasks)
          };
        }))
      : readChanges(threadId, since).then((read) => set((state) => {
          // Everything that changed after its last read changed after its
          // pages were read: each is where they reach.
          let tasks = state.byThread.get(threadId) ?? [];
          for (const task of read.tasks) tasks = withTask(tasks, task);
          const pages = state.pages.get(threadId)!;
          return {
            byThread: new Map(state.byThread).set(threadId, tasks),
            pages: new Map(state.pages).set(threadId, { ...pages, seq: Math.max(pages.seq, read.seq) }),
            // An end missed while the stream was down: its live line goes.
            liveLines: withoutEnded(state.liveLines, tasks)
          };
        }));
    entry.request = request
      .then(() => { unread.delete(threadId); }, (err: unknown) => {
        if (!get().byThread.has(threadId)) unread.add(threadId);
        throw err;
      })
      .finally(() => {
        if (reads.get(threadId) === entry) reads.delete(threadId);
      });
    return entry.request;
  },

  apply: (task) => {
    // An ended command's live line goes: its row says how it ended.
    if (isDone(task) && get().liveLines.has(task.id)) set((s) => {
      const liveLines = new Map(s.liveLines);
      liveLines.delete(task.id);
      return { liveLines };
    });
    const state = get();
    const threadId = task.parentThreadId;
    const held = state.byThread.get(threadId);
    if (!held) reads.get(threadId)?.early.push(task);
    const listedCopy = held?.find((t) => t.id === task.id);
    const loose = state.loose.get(task.id);
    // Nothing later than a copy held.
    if ((listedCopy && listedCopy.seq >= task.seq) || (loose && loose.seq >= task.seq)) return;
    // A detail read before it moved on is read again; a command's stays shown
    // meanwhile (its output so far), as its status no longer matches it.
    const detail = state.details.get(task.id);
    if (detail && detail.status !== task.status && task.kind !== "command") set((s) => {
      const details = new Map(s.details);
      details.delete(task.id);
      return { details };
    });
    if (loose) set((s) => ({ loose: new Map(s.loose).set(task.id, task) }));
    if (!held) return;
    set((s) => ({ byThread: new Map(s.byThread).set(threadId, withTask(s.byThread.get(threadId) ?? held, task)) }));
  },

  loadOlder: async (threadId) => {
    const page = get().pages.get(threadId);
    if (!page?.olderDone || page.loadingOlder) return null;
    const setPage = (change: Partial<TaskPages>) => set((s) => {
      const current = s.pages.get(threadId);
      return current ? { pages: new Map(s.pages).set(threadId, { ...current, ...change }) } : {};
    });
    setPage({ loadingOlder: true });
    try {
      const read = await readPage(threadId, page.olderDone);
      set((s) => {
        // Older than every task held: after them, in the page's order.
        const held = s.byThread.get(threadId) ?? [];
        let merged = [...held, ...read.tasks.filter((task) => !held.some((t) => t.id === task.id))];
        for (const task of read.tasks) merged = withTask(merged, task);
        const current = s.pages.get(threadId);
        return {
          byThread: new Map(s.byThread).set(threadId, merged),
          // Its number reflects its own tasks only: what changed elsewhere is read from the first page's.
          ...(current ? { pages: new Map(s.pages).set(threadId, { ...current, olderDone: read.olderDone, loadingOlder: false }) } : {})
        };
      });
      return null;
    } catch (err) {
      setPage({ loadingOlder: false });
      return errorText(err);
    }
  },

  loadDetail: (taskId) => {
    const pending = detailReads.get(taskId);
    if (pending) return pending;
    const request = (async () => {
      // A read taken before its task moved on, answered after that was
      // heard, is behind what is shown: read again (the server has it by
      // then: what was heard came from it). A task moves on twice at most.
      for (let attempt = 0; ; attempt++) {
        const body = await readJson<Partial<BackgroundTaskDetailDto>>(await fetch(apiPath(API_PATHS.agentTask(taskId))));
        if (!body.task || typeof body.brief !== "string") throw new Error("The server answered without the task.");
        const task = body.task;
        const state = get();
        const held = state.byThread.get(task.parentThreadId);
        const shown = held?.find((t) => t.id === taskId) ?? state.loose.get(taskId);
        if (shown && shown.seq > task.seq && attempt < 2) continue;
        // Where its conversation's pages reach, it is in its list (one not
        // held yet started after the list was read). Older than them, it is
        // kept on its own until a page brings it.
        const listed = held !== undefined && (held.some((t) => t.id === taskId) || withinPages(task, held, state.pages.get(task.parentThreadId)));
        set((s) => {
          const loose = s.loose.get(taskId);
          return {
            details: new Map(s.details).set(taskId, {
              brief: body.brief!, reply: body.reply ?? null, stepCount: body.stepCount ?? 0, status: task.status,
              ...(body.output ? { output: body.output } : {})
            }),
            loose: listed || (loose && loose.seq >= task.seq) ? s.loose : new Map(s.loose).set(taskId, task)
          };
        });
        if (listed) get().apply(task);
        return;
      }
    })().finally(() => detailReads.delete(taskId));
    detailReads.set(taskId, request);
    return request;
  },

  stopping: new Set(),

  stop: (taskId) => {
    const pending = stops.get(taskId);
    if (pending) return pending;
    set((state) => ({ stopping: new Set(state.stopping).add(taskId) }));
    // Run after it is recorded: whatever happens, its end finds it.
    const request = Promise.resolve().then(async () => {
      try {
        const response = await fetch(apiPath(API_PATHS.agentTaskStop(taskId)), { method: "POST" });
        const body = await readJson<{ task: BackgroundTaskDto }>(response);
        get().apply(body.task);
        return null;
      } catch (err) {
        return errorText(err);
      } finally {
        stops.delete(taskId);
        set((state) => {
          const stopping = new Set(state.stopping);
          stopping.delete(taskId);
          return { stopping };
        });
      }
    });
    stops.set(taskId, request);
    return request;
  }
}));

const NONE: BackgroundTaskDto[] = [];

/** A conversation's tasks, newest first, read the first time a part of its
 *  page asks. None until then, and for no thread. */
export function useBackgroundTasks(threadId: string | null): BackgroundTaskDto[] {
  const tasks = useBackgroundTasksStore((s) => (threadId === null ? undefined : s.byThread.get(threadId)) ?? NONE);
  useEffect(() => {
    if (threadId !== null) void useBackgroundTasksStore.getState().load(threadId).catch(() => {});
  }, [threadId]);
  return tasks;
}

/** A task by its id: its conversation's copy, or one read on its own (a
 *  line names a task older than the pages read). Null until one is read. */
export function useBackgroundTask(threadId: string, taskId: string): BackgroundTaskDto | null {
  const listed = useBackgroundTasks(threadId).find((t) => t.id === taskId) ?? null;
  const loose = useBackgroundTasksStore((s) => s.loose.get(taskId) ?? null);
  const listRead = useBackgroundTasksStore((s) => s.byThread.has(threadId));
  useEffect(() => {
    // Its conversation's list read without it: it is older than its pages.
    if (listRead && !listed && !loose) {
      useBackgroundTasksStore.getState().loadDetail(taskId).then(() => unreadTasks.delete(taskId), () => unreadTasks.add(taskId));
    }
  }, [listRead, listed, loose, taskId]);
  return listed ?? loose;
}

/** A task's detail, read when shown and again once the task has moved on;
 *  meanwhile the one read before. `error`: why it could not be read, until
 *  `retry`. */
export function useTaskDetail(task: Pick<BackgroundTaskDto, "id" | "status">): { detail: TaskDetail | null; error: string | null; retry: () => void } {
  const detail = useBackgroundTasksStore((s) => s.details.get(task.id) ?? null);
  const fresh = detail !== null && detail.status === task.status;
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<{ id: string; status: BackgroundTaskStatus; attempt: number; message: string } | null>(null);
  useEffect(() => {
    if (fresh) return;
    let live = true;
    useBackgroundTasksStore.getState().loadDetail(task.id).catch((err: unknown) => {
      if (live) setFailure({ id: task.id, status: task.status, attempt, message: errorText(err) });
    });
    return () => { live = false; };
  }, [task.id, task.status, fresh, attempt]);
  const error = !fresh && failure && failure.id === task.id && failure.status === task.status && failure.attempt === attempt ? failure.message : null;
  return { detail, error, retry: () => setAttempt((n) => n + 1) };
}

/** After the stream was down: every conversation read here reads what
 *  changed after its last read, for the events it missed; one whose first
 *  read failed is read, and one whose first read is on its way reads what
 *  changed after it once it has answered (taken, maybe, before what the
 *  outage hid); and each task a line could not read by its id is read. */
export async function refetchBackgroundTasks(): Promise<void> {
  const store = useBackgroundTasksStore.getState();
  const threads = new Set([...store.byThread.keys(), ...unread, ...reads.keys()]);
  await Promise.all([
    ...[...threads].map((threadId) => store.load(threadId, { again: true }).catch(() => {})),
    ...[...unreadTasks].map((taskId) => store.loadDetail(taskId).then(() => unreadTasks.delete(taskId), () => {}))
  ]);
}
