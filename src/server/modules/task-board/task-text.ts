import { dayClock } from "../activity/local-days.js";
import type { TaskDetailDto, TaskDto } from "../../../shared/api/task-board.js";
import type { TaskStatus } from "../../../shared/api/task-board.js";

/** How the agent's texts of tasks are written: in the machine's zone, now. */
export interface TaskTextClock {
  timeZone: string;
  now: number;
}

const OPEN = new Set(["todo", "progress", "review"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A due date as the agent reads it: "Nov 8" short, "Sun, Nov 8" long, a
 *  time after it when set, overdue once its day is past in the machine's zone. */
export function dueText(task: Pick<TaskDto, "dueDate" | "dueTime">, clock: TaskTextClock): { short: string; long: string; overdue: boolean } | null {
  if (!task.dueDate) return null;
  const [y, m, d] = task.dueDate.split("-").map(Number) as [number, number, number];
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
  const time = task.dueTime ? ` ${task.dueTime}` : "";
  const today = dayClock(clock.timeZone).dayOf(new Date(clock.now).toISOString());
  return { short: `${MONTHS[m - 1]} ${d}${time}`, long: `${weekday}, ${MONTHS[m - 1]} ${d}${time}`, overdue: task.dueDate < today };
}

/** Each status in the agent's words, lowercase: what it reads here and
 *  writes with its tool (the board stores its own names, the UI its labels). */
export const TASK_STATUS_WORD: Record<TaskStatus, string> = {
  backlog: "backlog", todo: "todo", progress: "in progress", review: "in review", done: "done", cancelled: "cancelled"
};

/** A task's labels as the agent reads them, the automatic ones marked. */
function labelWords(task: TaskDto): string {
  return task.labels.map((l) => (l.by === "auto" ? `${l.name} (automatic)` : l.name)).join(", ");
}

/** One task on one line, as the runtime context and the tool's answers give
 *  it; parts left out when empty. */
export function renderTaskLine(task: TaskDto, clock: TaskTextClock): string {
  const parts = [`${task.title} (${task.id})`, TASK_STATUS_WORD[task.status]];
  const due = dueText(task, clock);
  if (due) parts.push(`due ${due.short}${due.overdue ? ", overdue" : ""}`);
  if (task.threads.length > 0) parts.push(`threads: ${task.threads.map((t) => t.title).join(", ")}`);
  if (task.labels.length > 0) parts.push(`labels: ${labelWords(task)}`);
  if (task.unanswered > 0) parts.push(`${task.unanswered} unanswered comment${task.unanswered === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** The runtime context's Tasks section: the open tasks, one per line. */
export function renderTasksSection(tasks: readonly TaskDto[], clock: TaskTextClock): string {
  const open = tasks.filter((t) => OPEN.has(t.status) && !t.deletedAt);
  return open.length > 0 ? open.map((t) => renderTaskLine(t, clock)).join("\n") : "No open tasks.";
}

function stamp(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")} ${get("day")} ${get("hour")}:${get("minute")}`;
}

/** What a reader of a task is told: the personal agent gets the comments
 *  it has not answered; a manager (through a mention), the latest one. */
export type TaskReader = "personal" | "manager";

const CUT_MARK: Record<TaskReader, string> = {
  personal: "[… cut; read the rest with task_board read]",
  manager: "[… cut]"
};

/** The task as a block of text: the tool's read, a mention, an @agent
 *  comment. Past `max` characters the description is cut first, then the
 *  comments, each with the reader's marker. */
export function renderTaskBlock(task: TaskDetailDto, reader: TaskReader, opts: TaskTextClock & { agentName: string; max?: number }): string {
  const due = dueText(task, opts);
  const head = [
    `[Task "${task.title}" (${task.id})]`,
    `Status: ${TASK_STATUS_WORD[task.status]} · Due: ${due ? `${due.long}${due.overdue ? ", overdue" : ""}` : "none"} · Threads: ${task.threads.length > 0 ? task.threads.map((t) => t.title).join(", ") : "none"}`,
    `Labels: ${task.labels.length > 0 ? labelWords(task) : "none"}`
  ];
  const comments = reader === "personal" ? unanswered(task) : task.entries.filter((e) => e.kind === "comment").slice(-1);
  const commentLines = comments.length > 0
    ? comments.map((e) => `- ${e.by === "owner" ? "The user" : opts.agentName}, ${stamp(e.createdAt, opts.timeZone)}: ${e.text}`)
    : ["none"];
  const commentsHead = reader === "personal" ? "Comments not yet answered:" : "Latest comment:";
  const build = (description: string, result: string, lines: string[]) => [
    ...head, "Description:", description || "none", "Result:", result, commentsHead, ...lines
  ].join("\n");
  const max = opts.max ?? Infinity;
  let description = task.description;
  let result = task.result ?? "none yet";
  let text = build(description, result, commentLines);
  if (text.length <= max) return text;
  // Cut from the end of the longer of the description and the Result first,
  // then the other, then the comments, each with the reader's marker.
  const mark = CUT_MARK[reader];
  const shrink = (value: string, over: number) => {
    const keep = value.length - over - mark.length - 1;
    return keep > 0 ? `${value.slice(0, keep)}\n${mark}` : mark;
  };
  const descriptionFirst = description.length >= result.length;
  for (const part of descriptionFirst ? ["description", "result"] as const : ["result", "description"] as const) {
    if (part === "description") description = shrink(description, text.length - max);
    else result = shrink(result, text.length - max);
    text = build(description, result, commentLines);
    if (text.length <= max) return text;
  }
  const lines: string[] = [];
  for (const line of commentLines) {
    if (build(description, result, [...lines, line, mark]).length > max) break;
    lines.push(line);
  }
  text = build(description, result, [...lines, mark]);
  return text.length <= max ? text : text.slice(0, max);
}

function unanswered(task: TaskDetailDto): TaskDetailDto["entries"] {
  const out: TaskDetailDto["entries"] = [];
  for (let i = task.entries.length - 1; i >= 0; i--) {
    const entry = task.entries[i]!;
    if (entry.by === "agent") break;
    if (entry.kind === "comment") out.unshift(entry);
  }
  return out;
}
