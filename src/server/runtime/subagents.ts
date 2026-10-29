import type { Database } from "bun:sqlite";
import type { AgentStore, AgentThread, AgentWakeReason } from "../modules/agent/agent-store.js";
import type { BackgroundTaskStore } from "../modules/agent/background-task-store.js";
import type { FeaturesStore } from "../modules/features/features-store.js";
import type { AgentSseEmitter } from "../modules/sse/sse-events.js";
import type { PostWakeInfo } from "../modules/agent/wake-loop.js";
import { subagentAskedBy } from "../modules/agent/subagent-threads.js";
import { newId } from "../platform/ids.js";
import { logError } from "../platform/logger.js";
import {
  SSE_EVENTS,
  SUBAGENT_LIMITS,
  type BackgroundTaskDto,
  type BackgroundTaskStoppedBy,
  type SubagentType
} from "../../shared/api-contracts.js";
import { formatSubagentResultText, subagentResultMetadata, type SubagentOutcome } from "../../shared/subagent-messages.js";
import { subagentTaskMetadata } from "../../shared/subagent-task.js";
import { PAGE_RUN_FAILURE } from "../../shared/page-run-failure.js";
import { latestAssistantTextForWake, limitText } from "./feature-message-relay.js";

/** Why a run failed, in the words its parent reads, where the child's wake
 *  recorded no error of its own. */
export const SUBAGENT_FAILURE = {
  stuck: "it kept repeating a failing call",
  cutOff: "its replies kept reaching the output token limit",
  notStarted: "it could not be started",
  unknown: "unknown error"
} as const;


/** Your agent's page runs: a run's start begins its write; its end
 *  publishes the page and leaves Your agent a note in place of a result.
 *  `ran`: it started (a queued run stopped never did); `tell`: Your agent
 *  hears of it. A note that wakes it is followed by the wake once the write
 *  that ends the run is committed. */
export interface PageRunHooks {
  started(task: { id: string; title: string }): void;
  /** Whether its note wakes Your agent: `asked` (started while it answered
   *  the user), or the update failed however it failed. */
  ended(task: { id: string; title: string }, end: { reply: string | null; failed: string | null; tell: boolean; ran: boolean; asked: boolean }): boolean;
}

export interface SubagentServiceDeps {
  /** A run's row, its child thread and its task message are written together. */
  db: Database;
  tasks: BackgroundTaskStore;
  agentStore: AgentStore;
  featuresStore: Pick<FeaturesStore, "getById">;
  sse: Pick<AgentSseEmitter, "emit">;
  /** The scheduler's, read when called: a child's one wake, a parent's for its results. */
  wake: (threadId: string, reason: AgentWakeReason, triggerMessageId: string | null) => string | null;
  cancelWake: (wakeId: string) => { status: string };
  runningWakeOf: (threadId: string) => { id: string } | null;
  /** The scheduler still holds the thread: a wake runs, or is being ended
   *  (its end retried while the database refuses it), and its end step is
   *  still to come. */
  isThreadBusy?: (threadId: string) => boolean;
  /** Where the parent's shell starts, told to the child with its task; none
   *  when it cannot be said. */
  workingDirOf?: (parent: AgentThread) => string | null;
  /** The conversation's queued and running set changed (the pending-monitor feed). */
  onTasksChanged?: (parentThreadId: string) => void;
  /** Your agent's page; without it no page run starts. */
  page?: PageRunHooks;
  now?: () => Date;
  /** How long a refused end step waits before it is tried again, each time
   *  (RETRY_DELAYS_MS); a test passes short ones. */
  retryDelaysMs?: readonly number[];
}

/** As a wake's own end is tried again while the database refuses it. */
const RETRY_DELAYS_MS: readonly number[] = [500, 1000, 2000, 4000];

export interface SubagentService {
  /** Records the run, makes its hidden child with the task as its first
   *  message, and starts it when fewer than SUBAGENT_LIMITS.perThread of the
   *  parent's general runs run; else it waits its turn. A page run (Your
   *  agent's only) runs when no other page run does, in the order started. */
  /** `wakeWhenDone`: a page run whose end wakes its parent (started while
   *  it answered the user); one that fails wakes it anyway. */
  start(input: { parentThreadId: string; title: string; task: string; type?: SubagentType; wakeWhenDone?: boolean }): { task: BackgroundTaskDto; status: "started" | "queued" };
  /** A queued run ends at once; a running one has its wake stopped and is
   *  still running until that wake's end records who stopped it. Null for a
   *  run that is not there, has ended, or (requesterThreadId given) is
   *  another conversation's. */
  stop(taskId: string, by: BackgroundTaskStoppedBy, requesterThreadId?: string): BackgroundTaskDto | null;
  /** The end step: called from the post-wake hook for a subagent thread. */
  onChildWakeEnded(childThreadId: string, wake: { wakeId: string; status: PostWakeInfo["status"] }): void;
  /** Every queued and running run of a conversation that is archived or
   *  retired, stopped by "archive": the queued at once, the running when
   *  their wakes end. Nobody is told and nothing of it starts; safe to call
   *  from inside a wake the retired guard refuses. */
  stopAllFor(parentThreadId: string): void;
  /** After the start-up wakes: each run a restart cut short ends
   *  interrupted and its open parent is told and woken; then each
   *  conversation's queued runs start, oldest first. */
  recoverAtStartup(): void;
  /** A run of this conversation is queued or running. */
  hasOpenTasks(parentThreadId: string): boolean;
  /** Puts right what a refused write left undone: a running run whose
   *  child's wake has ended ends as that wake did (its end step was refused);
   *  one whose child never got a wake is started again; each conversation's
   *  queued runs take the slots there are; a parent whose wake for a result
   *  could not be made is woken. Never throws. The runtime calls it now and
   *  then; a refused end step calls it again after RETRY_DELAYS_MS. */
  reconcile(): void;
  /** Its waiting retries end. */
  dispose(): void;
}

interface Ending {
  status: SubagentOutcome;
  stoppedBy: BackgroundTaskStoppedBy | null;
  error: string | null;
}

export function createSubagentService(deps: SubagentServiceDeps): SubagentService {
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  /** The thread a subagent runs in; this service only ever reads subagents. */
  const childOf = (task: BackgroundTaskDto): string => {
    if (!task.childThreadId) throw new Error(`background task ${task.id} is not a subagent`);
    return task.childThreadId;
  };
  // A stop asked for while the child's wake still ran: who asked, until the
  // wake's end records it (the wake ends canceled whoever asked).
  const pendingStops = new Map<string, BackgroundTaskStoppedBy>();
  const changed = (task: BackgroundTaskDto) => {
    deps.sse.emit(SSE_EVENTS.backgroundTaskChanged, { task });
    deps.onTasksChanged?.(task.parentThreadId);
  };
  const isOpen = (threadId: string) => {
    const thread = deps.agentStore.getThreadById(threadId);
    return Boolean(thread && !thread.archivedAt);
  };
  // Parents whose wake for a result could not be made: their mail waits.
  const unwoken = new Set<string>();
  const retries = new Set<ReturnType<typeof setTimeout>>();
  // Ended with the runtime: no retry is set, and none set before runs.
  let disposed = false;
  /** One write: a busy database takes all of it or none, and what it
   *  refused is done again (reconcile). Inside another write, part of it. */
  const atomically = <T>(write: () => T): T => (deps.db.inTransaction ? write() : deps.db.transaction(write).immediate());

  /** Into the parent's mail, with its reply as recorded (its wake comes
   *  after: wakeParent). An archived parent is told nothing. Whether it was written. */
  const enqueueResult = (task: BackgroundTaskDto, outcome: SubagentOutcome, reply: string | null): boolean => {
    if (!isOpen(task.parentThreadId)) return false;
    const durationMs = runDuration(task);
    deps.agentStore.enqueueMailboxMessage({
      threadId: task.parentThreadId,
      role: "user",
      source: "subagent-result",
      sourceThreadId: childOf(task),
      content: {
        type: "text",
        // What the model reads, worded in full: the wake-message adapter adds nothing.
        text: formatSubagentResultText({ title: task.title, outcome, durationMs, reply, error: task.error }),
        // What the result card draws; it never reads the text.
        metadata: subagentResultMetadata({ taskId: task.id, outcome, title: task.title, durationMs, reply, error: task.error })
      }
    });
    return true;
  };

  /** A wake for a parent with a result in its mail (a busy parent reads it
   *  at its next step, or is woken for it when released). One that could not
   *  be made is made again at a reconcile. */
  const wakeParent = (parentThreadId: string): void => {
    // Read meanwhile by a turn of its own: nothing waits for it any more.
    if (!deps.agentStore.queuedMailboxSources(parentThreadId).some((source) => source === "subagent-result" || source === "page-result")) {
      unwoken.delete(parentThreadId);
      return;
    }
    try {
      deps.wake(parentThreadId, "subagent-result", null);
      unwoken.delete(parentThreadId);
    } catch (err) {
      unwoken.add(parentThreadId);
      logError(`subagent result: could not wake ${parentThreadId}`, err);
    }
  };

  /** Records how a run ended and tells its parent unless nobody is to be
   *  told. Its end and its result's mail are one write. Null when it had
   *  already ended. */
  const settle = (task: BackgroundTaskDto, ending: Ending, wakeId: string | null, at = now()): BackgroundTaskDto | null => {
    const text = wakeId ? latestAssistantTextForWake(deps.agentStore, childOf(task), wakeId) : null;
    // Its own agent stopped it and knows; an archive leaves nobody to tell.
    const tell = ending.status !== "stopped" || ending.stoppedBy === "user";
    const reply = text ? limitText(text, SUBAGENT_LIMITS.replyMaxChars) : null;
    const written = atomically(() => {
      const ended = deps.tasks.finish(task.id, {
        status: ending.status,
        ...(ending.stoppedBy ? { stoppedBy: ending.stoppedBy } : {}),
        reply,
        error: ending.error,
        at
      });
      if (!ended) return null;
      if (ended.type === "page") {
        // Its page is published and Your agent left a note, which wakes it
        // when the user waited on this run or it failed.
        const asked = deps.agentStore.subagentTaskOfThread(childOf(ended))?.wakesParent === true;
        const wakes = deps.page?.ended(ended, { reply, failed: pageFailure(ending), tell: tell && isOpen(ended.parentThreadId), ran: ended.startedAt !== null, asked }) ?? false;
        return { ended, told: wakes };
      }
      return { ended, told: tell && enqueueResult(ended, ending.status, reply) };
    });
    if (!written) return null;
    changed(written.ended);
    if (written.told) wakeParent(written.ended.parentThreadId);
    return written.ended;
  };

  /** When a run a restart cut short last did something: its child's last
   *  message, else its start (its task, given before a queued run started,
   *  is no step of it). Its end is put there, not at the restart: the time
   *  Mandate was down is no run time. */
  const lastStepAt = (task: BackgroundTaskDto): string => {
    const last = deps.agentStore.getMessagesPage(childOf(task), { limit: 1 })[0]?.createdAt;
    const from = task.startedAt ?? task.createdAt;
    return last && Date.parse(last) > Date.parse(from) ? last : from;
  };

  /** A run ends: recorded, told, and its slot freed for the next queued run
   *  of its kind: its parent's, or the next page run. */
  const end = (task: BackgroundTaskDto, ending: Ending, wakeId: string | null): BackgroundTaskDto | null => {
    const ended = settle(task, ending, wakeId);
    if (ended) {
      if (ended.type === "page") startQueuedPage();
      else startQueued(ended.parentThreadId);
    }
    return ended;
  };

  /** Wakes a running run's child; a child that cannot be woken ends it
   *  failed. A wake the database refused to make is made again at a
   *  reconcile. A refusal may have ended it already: it is returned as it now is. */
  const wakeChild = (running: BackgroundTaskDto): BackgroundTaskDto => {
    let woke: string | null;
    try {
      woke = deps.wake(childOf(running), "subagent-task", null);
    } catch (err) {
      logError(`subagent ${running.id}: could not wake its child`, err);
      return running;
    }
    if (woke) return running;
    return end(running, { status: "failed", stoppedBy: null, error: SUBAGENT_FAILURE.notStarted }, null) ?? deps.tasks.get(running.id) ?? running;
  };

  /** Marks it running and wakes its child. A page run's write begins with it. */
  const run = (task: BackgroundTaskDto): BackgroundTaskDto => {
    const running = atomically(() => {
      const marked = deps.tasks.markRunning(task.id, now());
      if (marked.type === "page") deps.page?.started(marked);
      return marked;
    });
    changed(running);
    return wakeChild(running);
  };

  /** A conversation's waiting runs end stopped by "archive", by their rows:
   *  none ran, so there is nothing to read, and nobody is told. */
  const stopQueued = (parentThreadId: string): void => {
    const at = now();
    for (const task of deps.tasks.listOpen("subagent")) {
      if (task.parentThreadId !== parentThreadId || task.status !== "queued") continue;
      const ended = deps.tasks.finish(task.id, { status: "stopped", stoppedBy: "archive", reply: null, error: null, at });
      if (ended) changed(ended);
    }
  };

  /** Fills the parent's free slots with its oldest waiting runs. A parent no
   *  longer open starts none: its waiting runs end as an archive ends them
   *  (archived by its row alone, nothing stopped them). */
  const startQueued = (parentThreadId: string): void => {
    if (!isOpen(parentThreadId)) {
      stopQueued(parentThreadId);
      return;
    }
    while (deps.tasks.countRunningSubagents("general", parentThreadId) < SUBAGENT_LIMITS.perThread) {
      const next = deps.tasks.oldestQueued(parentThreadId, "general");
      if (!next) return;
      run(next);
    }
  };

  /** The oldest waiting page run, when none runs: one at a time for all of
   *  Mandate. One whose conversation is no longer open ends as an archive
   *  ends it. */
  const startQueuedPage = (): void => {
    while (deps.tasks.countRunningSubagents("page") === 0) {
      const next = deps.tasks.oldestQueued(null, "page");
      if (!next) return;
      if (!isOpen(next.parentThreadId)) {
        stopQueued(next.parentThreadId);
        continue;
      }
      run(next);
    }
  };

  /** A running run's stop: its wake is cancelled, and that wake's end
   *  records who stopped it (the run is still running until then). With no
   *  wake left to cancel, it ends here. */
  const stopRunning = (task: BackgroundTaskDto, by: BackgroundTaskStoppedBy): BackgroundTaskDto | null => {
    // A stop already on its way counts: a second, by the user or its agent,
    // changes neither who stopped it nor who is told. An archive's does: it
    // leaves nobody to tell.
    if (pendingStops.has(task.id)) {
      if (by === "archive") pendingStops.set(task.id, by);
      return task;
    }
    const wake = deps.runningWakeOf(childOf(task));
    if (wake) {
      // Recorded first: the wake's end may come inside the cancel.
      pendingStops.set(task.id, by);
      let status: string;
      try {
        status = deps.cancelWake(wake.id).status;
      } catch (err) {
        // Not stopped, and whoever asked hears so: nothing stands for it.
        pendingStops.delete(task.id);
        throw err;
      }
      // Its wake ends canceled, and that end records who stopped it.
      if (status === "running") return task;
      pendingStops.delete(task.id);
    }
    // No wake runs it any more, so no end step will come: it ends here.
    return end(task, { status: "stopped", stoppedBy: by, error: null }, deps.agentStore.getLatestWakeForThread(childOf(task))?.id ?? null);
  };

  /** The end step of a child's ended wake. A stop asked for is let go of
   *  only once the run's end is written. */
  const endChildWake = (childThreadId: string, wake: { wakeId: string; status: PostWakeInfo["status"] }): void => {
    const task = deps.tasks.getByChildThread(childThreadId);
    if (!task) return;
    if (task.status === "running") end(task, endingOf(deps.agentStore, childThreadId, wake, pendingStops.get(task.id) ?? null), wake.wakeId);
    pendingStops.delete(task.id);
  };

  /** Each part apart: one refused leaves the others done. Whether all were. */
  const reconcile = (): boolean => {
    let whole = true;
    const attempt = (what: string, part: () => void) => {
      try {
        part();
      } catch (err) {
        whole = false;
        logError(`subagents: could not ${what}`, err);
      }
    };
    for (const task of deps.tasks.listOpen("subagent")) {
      if (task.status !== "running") continue;
      // Its wake runs (or waits to), or is still being ended: its end step will come.
      const child = childOf(task);
      if (deps.isThreadBusy?.(child) || deps.runningWakeOf(child) || deps.agentStore.getRunningWakeForThread(child)) continue;
      const latest = deps.agentStore.getLatestWakeForThread(child);
      if (latest && latest.status !== "running") {
        // Its wake ended and its end step did not finish: done again, as that wake ended.
        attempt(`end ${task.id}`, () => endChildWake(child, { wakeId: latest.id, status: latest.status as PostWakeInfo["status"] }));
      } else if (!latest) {
        // Marked running, its child's wake never made: made again.
        attempt(`start ${task.id}`, () => { wakeChild(task); });
      }
    }
    for (const parentThreadId of new Set(deps.tasks.listOpen("subagent").map((task) => task.parentThreadId))) {
      attempt(`start the queued runs of ${parentThreadId}`, () => startQueued(parentThreadId));
    }
    attempt("start the queued page run", startQueuedPage);
    for (const parentThreadId of [...unwoken]) wakeParent(parentThreadId);
    return whole && unwoken.size === 0;
  };

  /** A refused end step: a reconcile after each delay, until one does it all. */
  const retryLater = (attempt = 0): void => {
    const delays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
    if (disposed || attempt >= delays.length) return;
    const timer = setTimeout(() => {
      retries.delete(timer);
      if (!reconcile()) retryLater(attempt + 1);
    }, delays[attempt]);
    // A retry keeps no process alive.
    timer.unref?.();
    retries.add(timer);
  };

  return {
    start(input) {
      const parent = deps.agentStore.getThreadById(input.parentThreadId);
      if (!parent || parent.archivedAt) throw new Error(`open thread not found: ${input.parentThreadId}`);
      if (parent.scope === "subagent") throw new Error("a subagent cannot start another subagent");
      const type = input.type ?? "general";
      if (type === "page" && parent.scope !== "global") throw new Error("Only Your agent has a page.");
      if (type === "page" && !deps.page) throw new Error("Your agent's page is not available.");
      // Drawn first: the child's thread is made for it (its scope id), then
      // the task row names that thread.
      const id = newId("task");
      const askedBy = subagentAskedBy({ agentStore: deps.agentStore, featuresStore: deps.featuresStore }, parent);
      const workingDir = deps.workingDirOf?.(parent) ?? null;
      const written = deps.db.transaction(() => {
        const child = deps.agentStore.createSubagentThread(id);
        const task = deps.tasks.create({ id, parentThreadId: parent.id, childThreadId: child.id, type, title: input.title, task: input.task });
        const message = deps.agentStore.appendMessage({
          threadId: child.id,
          role: "user",
          source: "subagent-task",
          sourceThreadId: parent.id,
          content: { type: "text", text: input.task, metadata: subagentTaskMetadata({ taskId: id, askedBy, ...(workingDir ? { workingDir } : {}), ...(type === "page" && input.wakeWhenDone ? { wakesParent: true } : {}) }) }
        });
        return { task, message };
      }).immediate();
      deps.sse.emit(SSE_EVENTS.agentMessageAppended, { threadId: childOf(written.task), message: written.message });
      changed(written.task);
      if (type === "page") {
        // Behind any page run already waiting: in the order started.
        startQueuedPage();
        const current = deps.tasks.get(written.task.id) ?? written.task;
        return { task: current, status: current.status === "queued" ? "queued" : "started" };
      }
      if (deps.tasks.countRunningSubagents("general", parent.id) >= SUBAGENT_LIMITS.perThread) return { task: written.task, status: "queued" };
      return { task: run(written.task), status: "started" };
    },

    stop(taskId, by, requesterThreadId) {
      const task = deps.tasks.get(taskId);
      if (!task || task.kind !== "subagent" || (requesterThreadId !== undefined && task.parentThreadId !== requesterThreadId)) return null;
      if (task.status === "queued") return end(task, { status: "stopped", stoppedBy: by, error: null }, null);
      return task.status === "running" ? stopRunning(task, by) : null;
    },

    onChildWakeEnded(childThreadId, wake) {
      // Refused (a busy database): logged, never thrown, and done again.
      try {
        endChildWake(childThreadId, wake);
      } catch (err) {
        logError(`subagent: the end step of ${childThreadId} was refused`, err);
        retryLater();
      }
    },

    stopAllFor(parentThreadId) {
      const running = deps.tasks.listOpen("subagent").filter((task) => task.parentThreadId === parentThreadId && task.status === "running");
      // The queued first: none of them starts in a slot a running one frees.
      stopQueued(parentThreadId);
      for (const task of running) stopRunning(task, "archive");
    },

    recoverAtStartup() {
      const open = deps.tasks.listOpen("subagent");
      // Their wakes were ended at start-up, and none is resumed: each run the
      // restart cut short ends interrupted, its parent told. All of them
      // before any queued run starts.
      for (const task of open) {
        if (task.status !== "running") continue;
        settle(task, { status: "interrupted", stoppedBy: null, error: null }, deps.agentStore.getLatestWakeForThread(childOf(task))?.id ?? null, lastStepAt(task));
      }
      // Then each conversation's queued runs, oldest first, in the slots left;
      // an archived conversation's end instead. Then the next page run.
      for (const parentThreadId of new Set(open.map((task) => task.parentThreadId))) startQueued(parentThreadId);
      startQueuedPage();
    },

    hasOpenTasks(parentThreadId) {
      return deps.tasks.countRunning(parentThreadId) > 0 || deps.tasks.oldestQueued(parentThreadId) !== null;
    },

    reconcile() {
      reconcile();
    },

    dispose() {
      disposed = true;
      for (const timer of retries) clearTimeout(timer);
      retries.clear();
    }
  };
}

/** Why a page run did not publish, or null when it finished. */
function pageFailure(ending: Ending): string | null {
  switch (ending.status) {
    case "finished":
      return null;
    case "failed":
      return ending.error ?? SUBAGENT_FAILURE.unknown;
    case "interrupted":
      return PAGE_RUN_FAILURE.interrupted;
    case "stopped":
      return ending.stoppedBy === "agent"
        ? PAGE_RUN_FAILURE.stoppedByAgent
        : ending.stoppedBy === "archive" ? PAGE_RUN_FAILURE.archived : PAGE_RUN_FAILURE.stoppedByUser;
  }
}

/** How a child's ended wake ends its run. A stop asked for wins, however the
 *  wake then ended: whoever asked was told it stopped. */
function endingOf(
  agentStore: AgentStore,
  childThreadId: string,
  wake: { wakeId: string; status: PostWakeInfo["status"] },
  stoppedBy: BackgroundTaskStoppedBy | null
): Ending {
  if (stoppedBy) return { status: "stopped", stoppedBy, error: null };
  const failed = (error: string): Ending => ({ status: "failed", stoppedBy: null, error });
  switch (wake.status) {
    case "canceled":
      // Stopped on its own turn (the chat's Stop): a person did it.
      return { status: "stopped", stoppedBy: "user", error: null };
    case "error":
      return failed(agentStore.getWakeById(wake.wakeId)?.errorMessage?.trim() || SUBAGENT_FAILURE.unknown);
    case "stuck":
      return failed(SUBAGENT_FAILURE.stuck);
    case "finished":
      return wasCutOff(agentStore, childThreadId, wake.wakeId)
        ? failed(SUBAGENT_FAILURE.cutOff)
        : { status: "finished", stoppedBy: null, error: null };
  }
}

/** A wake whose replies kept stopping at the output token limit ends
 *  `finished`, with a cut_off failure row (wake-loop endRanWake). */
function wasCutOff(agentStore: AgentStore, threadId: string, wakeId: string): boolean {
  return agentStore.getMessages(threadId).some((m) =>
    m.wakeId === wakeId && m.content.type === "wake_failure" && m.content.status === "cut_off");
}

/** From its start to its end; none for one that never started (its wait
 *  in the queue is no run time). */
function runDuration(task: BackgroundTaskDto): number {
  if (!task.startedAt) return 0;
  const from = Date.parse(task.startedAt);
  const to = Date.parse(task.finishedAt ?? task.startedAt);
  return Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, to - from) : 0;
}
