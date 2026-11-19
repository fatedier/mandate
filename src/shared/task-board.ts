import type { TaskStatus } from "./api/task-board.js";
import { markdownToText } from "./markdown-text.js";

export const TASK_STATUSES: readonly TaskStatus[] = ["backlog", "todo", "progress", "review", "done", "cancelled"];
/** Each status as it is written, to the user and to the agent. */
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "Backlog", todo: "Todo", progress: "In progress", review: "In review", done: "Done", cancelled: "Cancelled"
};
/** The board's columns, in order; Cancelled is kept behind a count. */
export const BOARD_STATUSES: readonly TaskStatus[] = ["backlog", "todo", "progress", "review", "done"];
/** An In progress task with no new line for this long is marked quiet. */
export const QUIET_AFTER_MS = 3 * 24 * 3600 * 1000;

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

/** The first line a reader sees of Markdown, in its words alone: bold, code,
 *  a link, a heading's or a list item's marker leave only their text, and
 *  markup that says nothing (a rule, a fence's opening) is passed over. The
 *  line is read where it stands: a line of a code block keeps its signs. */
export function firstLine(markdown: string): string {
  const head = headOf(markdown);
  let words = said.get(head);
  if (words === undefined) {
    words = markdownToText(head).split("\n").find((line) => line.trim())?.trim() ?? "";
    if (head.length <= HEAD_KEPT_CHARS) {
      if (said.size >= SAID_MAX) said.clear();
      said.set(head, words);
    }
  }
  return words;
}

/** How much of a text is read for its first line: this much, to the end of
 *  the line it falls in. A text may be any length, and a board asks for every
 *  card's line at every draw. */
const HEAD_CHARS = 2000;
/** What each beginning says, kept; one much longer than a beginning (a single
 *  very long line) is read again each time instead. */
const said = new Map<string, string>();
const SAID_MAX = 500;
const HEAD_KEPT_CHARS = 4 * HEAD_CHARS;

function headOf(markdown: string): string {
  const end = markdown.indexOf("\n", HEAD_CHARS);
  return end < 0 ? markdown : markdown.slice(0, end);
}

const TASK_COMMENT_KEY = "taskComment";
const TASK_REMINDER_KEY = "taskReminder";

/** An @agent comment as the agent's chat shows it: the owner's words and the task. */
export interface TaskCommentNote {
  taskId: string;
  text: string;
}

/** The reminder as the agent's chat shows it: the task, and the thread that
 *  reported. No longer sent; a chat that has one still draws it as its line. */
export interface TaskReminderNote {
  taskId: string;
  threadId: string;
  threadTitle: string;
}

export function taskCommentMetadata(note: TaskCommentNote): Record<string, unknown> {
  return { [TASK_COMMENT_KEY]: { taskId: note.taskId, text: note.text } };
}

export function taskReminderMetadata(note: TaskReminderNote): Record<string, unknown> {
  return { [TASK_REMINDER_KEY]: { taskId: note.taskId, threadId: note.threadId, threadTitle: note.threadTitle } };
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** The comment a message carries, or null. */
export function taskCommentOf(metadata: Record<string, unknown> | undefined): TaskCommentNote | null {
  const raw = record(metadata?.[TASK_COMMENT_KEY]);
  return raw && typeof raw.taskId === "string" && typeof raw.text === "string" ? { taskId: raw.taskId, text: raw.text } : null;
}

/** The reminder a message carries, or null. */
export function taskReminderOf(metadata: Record<string, unknown> | undefined): TaskReminderNote | null {
  const raw = record(metadata?.[TASK_REMINDER_KEY]);
  return raw && typeof raw.taskId === "string" && typeof raw.threadId === "string" && typeof raw.threadTitle === "string"
    ? { taskId: raw.taskId, threadId: raw.threadId, threadTitle: raw.threadTitle }
    : null;
}
