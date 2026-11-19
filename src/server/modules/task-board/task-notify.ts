import { logError } from "../../platform/logger.js";
import { dayClock } from "../activity/local-days.js";
import type { NotificationService } from "../notifications/notification-service.js";
import { nextDue } from "../schedules/cron.js";
import type { ScheduleClock } from "../schedules/schedule-manager.js";
import type { TaskActor, TaskDto, TaskStatus } from "../../../shared/api/task-board.js";
import { firstLine } from "../../../shared/task-board.js";
import type { TaskBoardService } from "./task-board-service.js";
import { TASK_REVIEW_LEAD } from "../../../shared/api/notifications.js";

const OPEN = new Set<TaskStatus>(["todo", "progress", "review"]);
const DIGEST_CRON = "0 9 * * *";
const DIGEST_DAY = "digest_day";
const DIGEST_KEY = "tasks:due";
/** A morning notice nothing could show is tried again this often. */
const RETRY_MS = 5 * 60_000;
/** What the service did not keep: no window or channel could show it, or the
 *  hour's limit was reached. One kept while the owner looks goes on later. */
const NOT_SHOWN = new Set(["no_channel", "limit"]);

export interface TaskNotifyDeps {
  notifications: Pick<NotificationService, "notify" | "settle">;
  taskBoard: Pick<TaskBoardService, "list" | "state">;
  clock: ScheduleClock;
  /** The machine's zone: where 09:00 and "today" are read. */
  timeZone: () => string;
  agentName: () => string;
}

export interface TaskNotify {
  onStatusChanged(task: TaskDto, from: TaskStatus, by: TaskActor): void;
  onRemoved(id: string): void;
  onOpened(id: string): void;
  start(): void;
  stop(): void;
}

const matterOf = (id: string) => `task:${id}`;

/** "A and 2 more", or "A". */
function headline(titles: readonly string[]): string {
  return titles.length > 1 ? `${titles[0]} and ${titles.length - 1} more` : titles[0]!;
}

/** The morning's notice: what is due today and what is overdue, or null. */
export function dueDigest(tasks: readonly TaskDto[], today: string): { title: string; text: string } | null {
  const order = (a: TaskDto, b: TaskDto) =>
    a.dueDate!.localeCompare(b.dueDate!) || (a.dueTime ?? "99:99").localeCompare(b.dueTime ?? "99:99") || a.createdAt.localeCompare(b.createdAt);
  const open = tasks.filter((t) => OPEN.has(t.status) && !t.deletedAt && t.dueDate).sort(order);
  const dueToday = open.filter((t) => t.dueDate === today).map((t) => t.title);
  const overdue = open.filter((t) => t.dueDate! < today).map((t) => t.title);
  if (dueToday.length > 0) {
    return {
      title: `Due today: ${headline(dueToday)}`,
      text: overdue.length > 0 ? `${overdue.length} overdue: ${overdue.join(", ")}` : dueToday.slice(1).join(", ")
    };
  }
  if (overdue.length > 0) return { title: `Overdue: ${headline(overdue)}`, text: overdue.slice(1).join(", ") };
  return null;
}

/**
 * The board's notifications: the agent's move to In review, withdrawn once
 * the owner opens or deletes the task; and one notice each morning at 09:00
 * of what is due or overdue.
 */
export function createTaskNotify(deps: TaskNotifyDeps): TaskNotify {
  let timer: unknown = null;
  let retry: unknown = null;
  let sending = false;
  const send = (request: Parameters<TaskNotifyDeps["notifications"]["notify"]>[0]) => {
    deps.notifications.notify(request).catch((err: unknown) => logError("task-board-notify", err));
  };
  const settle = (id: string) => {
    deps.notifications.settle(matterOf(id)).catch((err: unknown) => logError("task-board-settle", err));
  };

  const today = () => dayClock(deps.timeZone()).dayOf(new Date(deps.clock.now()).toISOString());
  /** Tried again for `day` only: once it is over, the next day's notice
   *  waits for its own 09:00. */
  const tryAgain = (day: string) => {
    if (timer === null || retry !== null) return;
    retry = deps.clock.setTimeout(() => {
      retry = null;
      if (today() === day) tellDay();
    }, RETRY_MS);
  };

  /** The day's notice, once a day: the day is marked told once the service
   *  kept it, or there was nothing to say. Not kept, it is tried again. */
  const tellDay = () => {
    if (sending) return;
    try {
      const day = today();
      const state = deps.taskBoard.state();
      if (state.getState(DIGEST_DAY) === day) return;
      const digest = dueDigest(deps.taskBoard.list(), day);
      if (!digest) {
        state.setState(DIGEST_DAY, day);
        return;
      }
      sending = true;
      deps.notifications.notify({ source: "system", level: "news", matter: { key: DIGEST_KEY, link: "/tasks" }, ...digest }).then(
        (outcome) => {
          if (outcome.notSent && NOT_SHOWN.has(outcome.notSent)) tryAgain(day);
          else state.setState(DIGEST_DAY, day);
        },
        (err: unknown) => {
          logError("task-board-digest", err);
          tryAgain(day);
        }
      ).finally(() => { sending = false; });
    } catch (err) {
      logError("task-board-digest", err);
    }
  };


  const arm = () => {
    const now = deps.clock.now();
    const next = nextDue(DIGEST_CRON, dayClock(deps.timeZone()).zone, new Date(now)).getTime();
    timer = deps.clock.setTimeout(() => {
      timer = null;
      tellDay();
      arm();
    }, next - now);
  };

  return {
    onStatusChanged(task, from, by) {
      // Out of In review by anyone, opened or not: the notice is answered.
      if (from === "review" && task.status !== "review") return settle(task.id);
      if (by !== "agent" || task.status !== "review" || from === "review") return;
      send({
        source: "system", level: "news",
        matter: { key: matterOf(task.id), link: `/agent?task=${task.id}` },
        title: `${TASK_REVIEW_LEAD}: ${task.title}`,
        text: (task.result ? firstLine(task.result) : "") || `${deps.agentName()} moved it to In review.`
      });
    },
    onRemoved: settle,
    onOpened: settle,
    start() {
      if (timer !== null) return;
      const now = deps.clock.now();
      arm();
      // Started after today's 09:00 (the machine was off then): today's
      // notice now, unless it went already.
      const days = dayClock(deps.timeZone());
      const todayStart = days.startOf(days.dayOf(new Date(now).toISOString()));
      if (nextDue(DIGEST_CRON, days.zone, new Date(todayStart - 1)).getTime() <= now) tellDay();
    },
    stop() {
      if (timer !== null) deps.clock.clearTimeout(timer);
      if (retry !== null) deps.clock.clearTimeout(retry);
      timer = null;
      retry = null;
    }
  };
}
