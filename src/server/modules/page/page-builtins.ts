import type { Database } from "bun:sqlite";
import type { AgentStore } from "../agent/agent-store.js";
import type { ManagerThreadService } from "../agent/manager-threads.js";
import type { CanvasStore } from "../canvas/canvas-store.js";
import type { WaitingOnUserDeps } from "../personal/waiting-on-user.js";
import { dailyUsage, dailyUsageAway } from "../activity/activity-summary-away.js";
import { logError } from "../../platform/logger.js";
import { workerStateFor, workerStateLine } from "../../../shared/worker-state.js";
import type { AgentPageAnswerDto, AgentPageBuiltin } from "../../../shared/api/agent-page.js";
import type { ThreadStatusSnapshotDto } from "../../../shared/api/thread-status.js";
import type { ScheduleStore } from "../schedules/schedule-store.js";
import { describeCron } from "../schedules/cron.js";
import { TASK_STATUS_WORD } from "../task-board/task-text.js";
import type { TaskDto } from "../../../shared/api/task-board.js";

/** How many days the usage source covers, and how many canvases it lists. */
const USAGE_DAYS = 14;
const CANVASES_MAX = 50;

export interface PageBuiltinDeps extends WaitingOnUserDeps {
  db: Database;
  agentStore: Pick<AgentStore, "getThreadByScope" | "getLatestWakeForThread" | "openPersonalThread" | "openQuestions" | "getThreadById">;
  managerThreads: Pick<ManagerThreadService, "list">;
  canvasStore: Pick<CanvasStore, "listAll">;
  /** What the user gave on the page, newest first. */
  answers?: () => AgentPageAnswerDto[];
  /** Each thread's state and what waits on the user, as the server last
   *  worked them out: the page reads what the sidebar and Home show. */
  statusSnapshot: () => ThreadStatusSnapshotDto;
  /** Schedules and their runs, and the clock their week is counted by:
   *  none, the built-in is empty. */
  schedules?: { store: Pick<ScheduleStore, "all" | "runCountsSince">; now: () => number };
  /** The owner's task board: none, the built-in is empty. */
  tasks?: () => TaskDto[];
}

const OPEN_TASK: ReadonlySet<string> = new Set(["todo", "progress", "review"]);

/** The open tasks, as the board shows them; each status in the agent's
 *  words, as its task tool takes them. */
function readTasks(deps: PageBuiltinDeps): unknown {
  return (deps.tasks?.() ?? []).filter((t) => OPEN_TASK.has(t.status)).map((t) => ({
    id: t.id, title: t.title, status: TASK_STATUS_WORD[t.status], dueDate: t.dueDate, dueTime: t.dueTime, marks: t.marks,
    threads: t.threads.map((th) => ({ title: th.title, dot: th.dot })),
    labels: t.labels.map((l) => l.name), lastComment: t.lastComment, result: t.result, link: `/tasks/${encodeURIComponent(t.id)}`
  }));
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Each schedule with its duty thread, and how it ran over the last 7 days. */
function readSchedules(deps: PageBuiltinDeps): unknown {
  const schedules = deps.schedules;
  if (!schedules) return [];
  const since = new Date(schedules.now() - WEEK_MS).toISOString();
  return schedules.store.all().map((s) => {
    const counts = schedules.store.runCountsSince(s.id, since);
    return {
      // One whose thread is not open yet (an older version's, at the start): no link.
      id: s.id, name: s.name, threadId: s.threadId || null, threadTitle: s.threadId ? deps.agentStore.getThreadById(s.threadId)?.title ?? null : null,
      link: s.threadId ? threadLink(s.threadId) : null, status: s.status, cronText: describeCron(s.cron), nextDueAt: s.nextDueAt,
      lastOutcome: s.lastOutcome, runs7d: counts.runs, wakes7d: counts.wakes
    };
  });
}

const threadLink = (threadId: string) => `/threads/${encodeURIComponent(threadId)}`;
const workerLink = (threadId: string | null, workerId: string) =>
  (threadId ? `${threadLink(threadId)}?worker=${encodeURIComponent(workerId)}` : "/home");

/** A built-in source's value, read when asked: in the shapes the agent-page
 *  skill names, from what Mandate shows elsewhere (the thread list, Home,
 *  Activity, the canvases). Usage is read on a thread of its own: a promise. */
export function readBuiltin(name: AgentPageBuiltin, deps: PageBuiltinDeps): unknown {
  switch (name) {
    case "threads": return readThreads(deps);
    case "workers": return readWorkers(deps);
    case "waiting": return readWaiting(deps);
    case "usage": return readUsage(deps);
    case "canvases": return deps.canvasStore.listAll(CANVASES_MAX).map((canvas) => ({
      id: canvas.id, title: canvas.title, kind: canvas.kind, updatedAt: canvas.updatedAt, link: `/canvas/${encodeURIComponent(canvas.id)}`
    }));
    case "questions": {
      const personal = deps.agentStore.openPersonalThread();
      return personal ? deps.agentStore.openQuestions(personal.id).map((q) => ({ id: q.id, question: q.question, askedAt: q.askedAt })) : [];
    }
    case "answers": return deps.answers?.() ?? [];
    case "on_duty": return readSchedules(deps);
    case "tasks": return readTasks(deps);
  }
}

/** Two weeks of calls, read on Activity's worker thread (a page that
 *  follows it would hold the server's thread for each read); on the
 *  server's thread when the worker cannot. */
async function readUsage(deps: PageBuiltinDeps): Promise<{ days: Awaited<ReturnType<typeof dailyUsageAway>> }> {
  try {
    return { days: await dailyUsageAway({ dbPath: deps.db.filename, days: USAGE_DAYS }) };
  } catch (err) {
    logError("page usage", err, "reading usage in a worker failed; reading it on the server's thread");
    return { days: dailyUsage(deps.db, USAGE_DAYS) };
  }
}

function readThreads(deps: PageBuiltinDeps) {
  const states = new Map(deps.statusSnapshot().threads.map((thread) => [thread.threadId, thread.state]));
  return deps.managerThreads.list().map((thread) => ({
    id: thread.id, title: thread.title, state: states.get(thread.id) ?? "idle", lastActivityAt: thread.lastActivityAt, link: threadLink(thread.id)
  }));
}

function readWorkers(deps: PageBuiltinDeps) {
  const plans = deps.planStore.statesOfActive();
  return deps.workersStore.listAllActive().map((row) => {
    const item = deps.workStore.getByWorker(row.id);
    const plan = plans.get(row.id) ?? null;
    const worker = deps.agentStore.getThreadByScope("worker", row.id);
    const running = worker ? deps.isBusy?.(worker.id) ?? false : false;
    const failure = { at: item?.failedAt ?? null, message: item?.failedMessage ?? null, kind: item?.failedKind ?? null };
    const line = workerStateLine(plan, failure, running);
    return {
      id: row.id,
      name: row.name,
      threadId: row.ownerThreadId ?? null,
      state: workerStateFor(plan, failure.at, failure.kind, running),
      line: [line.lead, line.text].filter(Boolean).join(" "),
      link: workerLink(row.ownerThreadId ?? null, row.id)
    };
  });
}

/** Home's list, its kind carried as data, without the personal agent's own
 *  questions (they are the "questions" source). */
function readWaiting(deps: PageBuiltinDeps) {
  return deps.statusSnapshot().waiting.flatMap((entry) => {
    if (entry.kind === "agent") return [];
    const link = entry.kind === "worker" ? workerLink(entry.threadId, entry.workerId ?? "") : entry.threadId ? threadLink(entry.threadId) : "/home";
    return [{ waiting: entry.waiting, title: entry.threadTitle ?? entry.workerName ?? "", text: entry.text, link }];
  });
}
