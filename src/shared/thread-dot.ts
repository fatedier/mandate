/** A thread's one mark, and whether it has stopped, read from the same
 *  signals. It speaks for the thread alone: a worker's failure, stop or
 *  finished plan is its manager's to hear, and colours nothing here. Decision
 *  and result: the manager stop check found the thread's latest reply leaves the user
 *  one (only while that is current). */
export type ThreadDot = "failed" | "needs_you" | "decision" | "result" | "working" | "watching" | "idle";

/** What the manager stop check makes of a stopped thread's latest reply. */
export type StopVerdict = "decision" | "result" | "nothing";

/** What an agent waits on to wake by itself: a pane (a watch), a command (a
 *  monitor), a subagent's result, a command it runs in the background, or an
 *  alarm it set (schedule_wake). */
export type WaitKind = "pane" | "command" | "subagent" | "background-command" | "alarm";

/** The one wait that names what an agent waits on: a pane before a command,
 *  before a subagent's result, before a command in the background, before an
 *  alarm. So "alarm" means its alarms are all it waits on. */
export function leadWait(waits: ReadonlyArray<{ kind: WaitKind }>): WaitKind | null {
  for (const kind of ["pane", "command", "subagent", "background-command"] as const) {
    if (waits.some((wait) => wait.kind === kind)) return kind;
  }
  return waits.length > 0 ? "alarm" : null;
}

export interface ThreadWorkerSignal {
  waiting: "failed" | "stopped" | null;
  /** Its plan holds a question (isAsking). */
  asking?: boolean;
  running: boolean;
  /** What it waits on (leadWait); `true` for a wait other than an alarm. */
  watching?: WaitKind | boolean | null;
  /** A step of its plan is in progress: it says it is still at work. */
  stepInProgress?: boolean;
}

/** What a thread's own conversation adds to its workers' signals. `asking`:
 *  its manager asked the user a question they have not answered. `verdict`:
 *  the manager stop check's, while it is current (the thread stopped on that reply
 *  and the user has not read it). */
export interface ThreadSignal {
  running: boolean;
  failed?: boolean;
  watching?: WaitKind | boolean | null;
  asking?: boolean;
  verdict?: "decision" | "result" | null;
}

/** Whether what a worker waits on keeps its thread open. Its pane, command,
 *  subagent or background command does until it ends. An alarm can as well be
 *  a reminder set past the end of the work, so it does only while the worker
 *  says it is still at work, a plan step in progress, and waits on nobody but
 *  itself: a worker that asked, failed or was stopped leaves the next move
 *  to someone else. */
export function workerKeepsOpen(worker: Pick<ThreadWorkerSignal, "watching" | "stepInProgress" | "waiting" | "asking">): boolean {
  if (!worker.watching) return false;
  if (worker.watching !== "alarm") return true;
  return Boolean(worker.stepInProgress) && !worker.waiting && !worker.asking;
}

/** Whether what a thread's manager waits on keeps the thread open: anything
 *  but an alarm, since a manager has no plan that says it is still at work. */
export function threadKeepsOpen(thread: Pick<ThreadSignal, "watching">): boolean {
  return Boolean(thread.watching) && thread.watching !== "alarm";
}

/** Nothing in the thread runs or will wake by itself to go on with its work:
 *  whatever is still open in it (a worker's question nobody took up) is now
 *  the user's to move. */
export function threadRests(
  thread: Pick<ThreadSignal, "running" | "watching">,
  workers: ReadonlyArray<Pick<ThreadWorkerSignal, "running" | "watching" | "stepInProgress" | "waiting" | "asking">>
): boolean {
  return !thread.running && !threadKeepsOpen(thread) && !workers.some((w) => w.running || workerKeepsOpen(w));
}

/** A thread's one dot. Failed: its own turn failed or stopped (red, and
 *  first: it outranks a question in the same thread). Needs you: its manager
 *  asked the user (the moment it asks, at work or not, since the question is
 *  in front of them and can be answered), or a worker's question nobody above
 *  it took up, which is the thread's to show only once nothing in it runs or
 *  will wake by itself, since then only the user can move it. Then the stop
 *  check's verdict while it is current; otherwise working when the manager
 *  or any worker runs; otherwise watching when one of them waits on something
 *  that wakes it; otherwise idle: nothing will happen until the user acts. */
export function threadDot(thread: ThreadSignal, workers: ThreadWorkerSignal[]): ThreadDot {
  const moving = thread.running || workers.some((w) => w.running);
  const willWake = Boolean(thread.watching) || workers.some((w) => Boolean(w.watching));
  if (thread.failed) return "failed";
  if (thread.asking || (threadRests(thread, workers) && workers.some((w) => w.asking))) return "needs_you";
  if (thread.verdict) return thread.verdict;
  if (moving) return "working";
  if (willWake) return "watching";
  return "idle";
}

/** How a thread has stopped, for whoever waits on it. */
export type ThreadStop = "failed" | "needs_you" | "stopped";

/** Null while the thread's manager or any worker runs, or waits on something
 *  that keeps the thread open (threadKeepsOpen, workerKeepsOpen). Unlike the
 *  mark, what needs the user does not outrank what is still working: a thread
 *  has stopped only when all of it has. Then: its own turn failed; a question
 *  is open (its manager's, or a worker's nobody took up); otherwise it has
 *  stopped. A worker's failure is its manager's, which has had its turn on it
 *  by now. */
export function threadStop(thread: ThreadSignal, workers: ThreadWorkerSignal[]): ThreadStop | null {
  if (thread.running || workers.some((w) => w.running)) return null;
  if (threadKeepsOpen(thread) || workers.some(workerKeepsOpen)) return null;
  if (thread.failed) return "failed";
  if (thread.asking || workers.some((w) => w.asking)) return "needs_you";
  return "stopped";
}

/** The same for one worker on its own. */
export function workerStop(worker: ThreadWorkerSignal): ThreadStop | null {
  if (worker.running || workerKeepsOpen(worker)) return null;
  if (worker.waiting === "failed") return "failed";
  if (worker.asking || worker.waiting === "stopped") return "needs_you";
  return "stopped";
}
