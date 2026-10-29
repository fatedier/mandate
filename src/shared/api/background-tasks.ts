/** What runs in the background for a conversation: a subagent, or a shell
 *  command bash runs in the background. One table, list and stop tool. */
export type BackgroundTaskKind = "subagent" | "command";

/** The kinds of subagent: the general one, which works with the tools of
 *  the agent that started it on whatever job it is given; and Your agent's
 *  page one, which changes its page and nothing else. */
export type SubagentType = "general" | "page";

export type BackgroundTaskStatus = "queued" | "running" | "finished" | "stopped" | "failed" | "interrupted";

/** Who stopped a task: the user (its Stop), the agent that started it
 *  (stop_task), the archive of the conversation it belongs to, or (a
 *  command) its output passing its limit. */
export type BackgroundTaskStoppedBy = "user" | "agent" | "archive" | "output";

export interface BackgroundTaskDto {
  /** "task_…" */
  id: string;
  kind: BackgroundTaskKind;
  /** The conversation that started it. */
  parentThreadId: string;
  /** The thread it runs in: a subagent's; a command has none. */
  childThreadId: string | null;
  type: SubagentType;
  title: string;
  status: BackgroundTaskStatus;
  /** Set on a stopped task only. */
  stoppedBy: BackgroundTaskStoppedBy | null;
  /** Why it failed, on a failed task. Its reply is not here: it is its
   *  conversation's last message, read with its steps. */
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** The number its latest change took, of all tasks': of two copies of a
   *  task, the one with the greater is the later. */
  seq: number;
  /** A command's exit code once it exited by itself; null while it runs,
   *  when it was stopped or killed by a signal, and for a subagent. */
  exitCode: number | null;
  /** A command's command line; null for a subagent. */
  command: string | null;
  /** Where a command's output goes; null for a subagent. */
  outputPath: string | null;
}

/** A conversation's tasks as its list reads them: every open one, then its
 *  done ones a page at a time (BACKGROUND_TASKS_PAGE), the latest to end
 *  first; `olderDone` asks for the next page (null: none left). `seq`: the
 *  greatest task number the read reflects. */
export interface BackgroundTasksPageDto {
  tasks: BackgroundTaskDto[];
  olderDone: string | null;
  seq: number;
}

/** A conversation's tasks changed after a number (?since=), in the order
 *  they changed, and the greatest task number the read reflects. */
export interface BackgroundTaskChangesDto {
  tasks: BackgroundTaskDto[];
  seq: number;
}

/** One task as its detail reads it: the task; the brief it was given; its
 *  reply as its conversation was told it (cut at SUBAGENT_LIMITS.replyMaxChars;
 *  none while it runs, nor when it said nothing); and how many calls it has
 *  made. Its steps themselves are its conversation, read when asked for. */
export interface BackgroundTaskDetailDto {
  task: BackgroundTaskDto;
  /** A subagent's task; a command's command. */
  brief: string;
  /** A subagent's reply; the end of a command's output (read now). */
  reply: string | null;
  stepCount: number;
  /** A command's: how much of its output the reply holds, and where it all is. */
  output?: { shownLines: number; totalLines: number; bytes: number; path: string };
}

/** How many done tasks one read of a conversation's list brings. */
export const BACKGROUND_TASKS_PAGE = 50;

/** Six of one conversation's subagents run at once (the user's number; other
 *  conversations do not count); more wait their turn. A reply reaches the
 *  conversation cut at 20,000 characters, as a worker's relayed reply is. */
export const SUBAGENT_LIMITS = { perThread: 6, replyMaxChars: 20_000 } as const;
