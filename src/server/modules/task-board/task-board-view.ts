import type { AgentStore } from "../agent/agent-store.js";
import { threadDisplayTitle } from "../agent/manager-threads.js";
import type { TaskDetailDto, TaskDto, TaskEntryDto, TaskLabelDto, TaskMarks, TaskStatus, TaskThreadDto } from "../../../shared/api/task-board.js";
import { QUIET_AFTER_MS, firstLine } from "../../../shared/task-board.js";
import type { ThreadDot } from "../../../shared/thread-dot.js";
import { labelKey, type EntryRow, type LabelRow, type LinkRow, type TaskRow } from "./task-board-store.js";

export interface TaskViewDeps {
  agentStore: Pick<AgentStore, "getThreadById" | "firstUserLine" | "latestReply">;
  threadDots: () => ReadonlyMap<string, ThreadDot>;
  now: () => number;
  /** The projects these threads' workers ran in, by name, in order. */
  workRanIn?: (threadIds: readonly string[]) => readonly string[];
}

/** A task's labels: where its threads' workers ran first (each once), then
 *  the hand ones not already among them. */
export function taskLabels(deps: TaskViewDeps, threadIds: readonly string[], hand: readonly LabelRow[]): TaskLabelDto[] {
  const seen = new Set<string>();
  const labels: TaskLabelDto[] = [];
  for (const name of deps.workRanIn?.(threadIds) ?? []) {
    if (seen.has(labelKey(name))) continue;
    seen.add(labelKey(name));
    labels.push({ name, by: "auto" });
  }
  for (const label of hand) {
    if (seen.has(labelKey(label.name))) continue;
    seen.add(labelKey(label.name));
    labels.push({ name: label.name, by: label.by });
  }
  return labels;
}

const OPEN: readonly TaskStatus[] = ["todo", "progress", "review"];
const NO_MARKS: TaskMarks = { needsYou: false, failed: false, quiet: false };

/** A linked thread as it stands, read from the thread: its dot, and the
 *  first line of its latest end-of-turn reply. A thread that no longer
 *  exists is left out. */
function threadRow(deps: TaskViewDeps, link: LinkRow, dots: ReadonlyMap<string, ThreadDot>): TaskThreadDto | null {
  const thread = deps.agentStore.getThreadById(link.threadId);
  if (!thread) return null;
  const reply = deps.agentStore.latestReply(link.threadId);
  const text = reply?.content.type === "assistant" ? reply.content.text ?? "" : "";
  return {
    threadId: link.threadId,
    title: threadDisplayTitle(deps.agentStore as AgentStore, link.threadId),
    dot: dots.get(link.threadId) ?? "idle",
    archived: Boolean(thread.archivedAt),
    lastReply: text.trim() ? firstLine(text) : null,
    lastReplyAt: text.trim() && reply ? reply.createdAt : null
  };
}

/** Marks no one sets: from the linked threads, and from time. A closed task has none. */
export function taskMarks(status: TaskStatus, threads: readonly TaskThreadDto[], lastLineAt: string, now: number): TaskMarks {
  if (!OPEN.includes(status)) return NO_MARKS;
  return {
    needsYou: threads.some((t) => !t.archived && (t.dot === "needs_you" || t.dot === "decision")),
    failed: threads.some((t) => !t.archived && t.dot === "failed"),
    quiet: status === "progress" && now - Date.parse(lastLineAt) >= QUIET_AFTER_MS
  };
}

/** The owner's comments after the agent's latest line. */
export function unansweredCount(entries: readonly EntryRow[]): number {
  let count = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.by === "agent") break;
    if (entry.kind === "comment") count++;
  }
  return count;
}

export function entryDto(row: EntryRow): TaskEntryDto {
  const { taskId: _taskId, ...rest } = row;
  return rest;
}

/** A task as both homes and the agent read it: its threads read from the
 *  threads, its marks from them and from time, its last comment from its
 *  stream. */
export function toTaskDto(deps: TaskViewDeps, row: TaskRow, links: LinkRow[], entries: EntryRow[], hand: readonly LabelRow[] = []): TaskDto {
  const dots = deps.threadDots();
  const threads = links.map((link) => threadRow(deps, link, dots)).filter((t): t is TaskThreadDto => t !== null);
  const comment = [...entries].reverse().find((e) => e.kind === "comment");
  const lastLineAt = entries.at(-1)?.createdAt ?? row.createdAt;
  // Every move is a line with its status (a comment of the agent's carries it too).
  const movedAt = [...entries].reverse().find((e) => e.status !== null)?.createdAt;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    dueDate: row.dueDate,
    dueTime: row.dueTime,
    result: row.result,
    resultAt: row.resultAt,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt,
    statusAt: movedAt ?? row.createdAt,
    deletedAt: row.deletedAt,
    threads,
    labels: taskLabels(deps, links.map((link) => link.threadId), hand),
    marks: taskMarks(row.status, threads, lastLineAt, deps.now()),
    lastComment: comment ? { by: comment.by, text: comment.text, at: comment.createdAt } : null,
    unanswered: unansweredCount(entries)
  };
}

export function toTaskDetailDto(deps: TaskViewDeps, row: TaskRow, links: LinkRow[], entries: EntryRow[], hand: readonly LabelRow[] = []): TaskDetailDto {
  return { ...toTaskDto(deps, row, links, entries, hand), entries: entries.map(entryDto) };
}
