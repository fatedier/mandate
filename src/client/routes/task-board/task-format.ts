import type { TaskDto, TaskStatus } from "@shared/api/task-board";
import type { ThreadDot } from "@shared/thread-dot";
import { firstLine } from "@shared/task-board";
import { NO_VALUE } from "@/lib/filter-parts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The statuses that are still to do; Done and Cancelled are closed. */
export const OPEN_STATUSES: ReadonlySet<TaskStatus> = new Set(["todo", "progress", "review"]);
export const isOpen = (task: Pick<TaskDto, "status">) => OPEN_STATUSES.has(task.status);

const pad = (n: number) => String(n).padStart(2, "0");

/** Today, here, as a due date is written (YYYY-MM-DD). */
export function localDay(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The date `n` days after `day`. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + n));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** The days a Due offers at a press: Today, Tomorrow, Next week. */
export const quickDays = (now: number): Array<[string, string]> => {
  const today = localDay(now);
  return [["Today", today], ["Tomorrow", addDays(today, 1)], ["Next week", addDays(today, 7)]];
};

/** Whole days from `from` to `to` (both dates, no time of day). */
function daysBetween(from: string, to: string): number {
  const utc = (day: string) => {
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/** A due date as the board shows it: short on a card ("Overdue · Nov 8",
 *  "Today", "Tomorrow", "Fri, Nov 13", "Nov 20"), long in the detail ("Tue,
 *  Nov 10", "Sun, Nov 8 · overdue"), with the year when it is not this one
 *  and a time after either; red when past, amber today. */
export function formatDueLabel(dueDate: string, dueTime: string | null, now: number): { short: string; long: string; tone: "overdue" | "today" | null } {
  const [y, m, d] = dueDate.split("-").map(Number) as [number, number, number];
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
  const today = localDay(now);
  const date = `${MONTHS[m - 1]} ${d}${String(y) === today.slice(0, 4) ? "" : `, ${y}`}`;
  const n = daysBetween(today, dueDate);
  const time = dueTime ? ` · ${dueTime}` : "";
  const short = n < 0 ? `Overdue · ${date}` : n === 0 ? "Today" : n === 1 ? "Tomorrow" : n < 7 ? `${weekday}, ${date}` : date;
  return {
    short: `${short}${time}`,
    long: `${weekday}, ${date}${n < 0 ? " · overdue" : ""}${time}`,
    tone: n < 0 ? "overdue" : n === 0 ? "today" : null
  };
}

export type DueGroup = "overdue" | "today" | "week" | "later" | "none";
export const DUE_GROUPS: ReadonlyArray<{ id: DueGroup; label: string }> = [
  { id: "overdue", label: "Overdue" },
  { id: "today", label: "Today" },
  { id: "week", label: "This week" },
  { id: "later", label: "Later" },
  { id: "none", label: "No due date" }
];

/** Where a task sits in the Due agenda. */
export function dueGroupOf(task: Pick<TaskDto, "dueDate">, today: string): DueGroup {
  if (!task.dueDate) return "none";
  const n = daysBetween(today, task.dueDate);
  return n < 0 ? "overdue" : n === 0 ? "today" : n < 7 ? "week" : "later";
}

/** A column's (and a list group's) order: Done and Cancelled the latest
 *  there first; the others by due date (byDue). */
export function columnOrder(status: TaskStatus): (a: TaskDto, b: TaskDto) => number {
  if (status === "done" || status === "cancelled") return (a, b) => b.statusAt.localeCompare(a.statusAt) || a.createdAt.localeCompare(b.createdAt);
  return byDue;
}

/** Earliest due first, a time before none, then oldest. */
export function byDue(a: TaskDto, b: TaskDto): number {
  return (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999")
    || (a.dueTime ?? "99:99").localeCompare(b.dueTime ?? "99:99")
    || a.createdAt.localeCompare(b.createdAt);
}

/** The one line a card or row says under its title: the Result once the
 *  work is back (In review, Done), else the latest comment and who wrote it. */
export function taskNote(task: TaskDto, agentName: string): { who: string; text: string; at: string | null } | null {
  if ((task.status === "review" || task.status === "done") && task.result) return { who: "Result", text: firstLine(task.result), at: null };
  if (task.lastComment) return { who: task.lastComment.by === "owner" ? "You" : agentName, text: firstLine(task.lastComment.text), at: task.lastComment.at };
  return null;
}

/** A linked thread's state, in words. */
export const THREAD_STATE_WORD: Record<ThreadDot, string> = {
  failed: "Failed", needs_you: "Needs you", decision: "Decision", result: "Result", working: "Working", watching: "Watching", idle: "Idle"
};

/** The filters: any ticked label (any case; No label for a task without
 *  one) and any ticked due choice; both must match. */
export function matchesFilters(task: TaskDto, filters: { labels: readonly string[]; due: readonly ("overdue" | "week" | "none")[] }, today: string): boolean {
  if (filters.labels.length > 0) {
    const want = new Set(filters.labels.map((l) => l.toLowerCase()));
    const hit = task.labels.length === 0 ? want.has(NO_VALUE) : task.labels.some((l) => want.has(l.name.toLowerCase()));
    if (!hit) return false;
  }
  if (filters.due.length > 0) {
    const group = dueGroupOf(task, today);
    const hit = filters.due.some((d) => (d === "overdue" ? group === "overdue" && isOpen(task) : d === "week" ? group === "today" || group === "week" : group === "none"));
    if (!hit) return false;
  }
  return true;
}

/** The labels the board has, each once (any case), the automatic ones first,
 *  then by name. */
export function boardLabels(tasks: readonly TaskDto[]): Array<{ name: string; auto: boolean }> {
  const seen = new Map<string, { name: string; auto: boolean }>();
  for (const task of tasks) {
    for (const label of task.labels) {
      const key = label.name.toLowerCase();
      const had = seen.get(key);
      if (!had) seen.set(key, { name: label.name, auto: label.by === "auto" });
      else if (label.by === "auto") had.auto = true;
    }
  }
  return [...seen.values()].sort((a, b) => Number(b.auto) - Number(a.auto) || a.name.localeCompare(b.name));
}

/** The search: in the title or the description, any case. */
export function matchesSearch(task: Pick<TaskDto, "title" | "description">, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || task.title.toLowerCase().includes(q) || task.description.toLowerCase().includes(q);
}
