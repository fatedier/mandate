import type { Mention } from "../mentions.js";
import type { ThreadDot } from "../thread-dot.js";

/** The owner's task board: tasks the owner creates and closes; the personal
 *  agent links threads, moves the status and writes the Result. Backlog holds
 *  what is kept for later: not open, as Done and Cancelled are not. */
export type TaskStatus = "backlog" | "todo" | "progress" | "review" | "done" | "cancelled";
export type TaskActor = "owner" | "agent";

/** One line of a task's stream: a comment, or a change of status, of a
 *  thread link, or of the Result. A comment by the agent that moved the
 *  status carries that status. Kinds a reader does not know are shown as a
 *  plain line, so new kinds can be added. */
export interface TaskEntryDto {
  id: string;
  seq: number;
  kind: "comment" | "status" | "link" | "unlink" | "result";
  by: TaskActor;
  text: string;
  status: TaskStatus | null;
  threadId: string | null;
  threadTitle: string | null;
  newThread: boolean;
  createdAt: string;
}

/** A thread linked to a task, as it stands: read from the thread, never copied. */
export interface TaskThreadDto {
  threadId: string;
  title: string;
  dot: ThreadDot;
  archived: boolean;
  /** The latest reply's first line, in its words (firstLine): text to draw as it is. */
  lastReply: string | null;
  lastReplyAt: string | null;
}

/** A label on a task: by the owner, by the agent, or automatic (a project
 *  its linked threads' workers ran in). */
export interface TaskLabelDto {
  name: string;
  by: TaskActor | "auto";
}

export interface TaskMarks {
  needsYou: boolean;
  failed: boolean;
  quiet: boolean;
}

export interface TaskDto {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  /** YYYY-MM-DD, the machine's time zone. */
  dueDate: string | null;
  /** HH:MM. */
  dueTime: string | null;
  result: string | null;
  resultAt: string | null;
  createdAt: string;
  createdBy: TaskActor;
  updatedAt: string;
  /** When it came into its status: its last move, or its creation. */
  statusAt: string;
  deletedAt: string | null;
  threads: TaskThreadDto[];
  /** The automatic ones first, then the others in the order added. */
  labels: TaskLabelDto[];
  marks: TaskMarks;
  lastComment: { by: TaskActor; text: string; at: string } | null;
  /** The owner's comments after the agent's latest line. */
  unanswered: number;
}

export interface TaskDetailDto extends TaskDto {
  entries: TaskEntryDto[];
}

export interface CreateTaskBody {
  title: string;
  description?: string;
  dueDate?: string | null;
  dueTime?: string | null;
}

export interface PatchTaskBody {
  title?: string;
  description?: string;
  dueDate?: string | null;
  dueTime?: string | null;
  status?: TaskStatus;
}

export interface CommentBody {
  text: string;
  mentions?: Mention[];
}

export interface TaskBoardDto {
  tasks: TaskDto[];
}

export interface TaskResponse {
  task: TaskDto;
}

export interface TaskDetailResponse {
  task: TaskDetailDto;
}

export interface TaskEntryResponse {
  entry: TaskEntryDto;
}

export interface TaskBoardDeletedResponse {
  deleted: number;
}

export interface TaskRemovedDto {
  id: string;
}
