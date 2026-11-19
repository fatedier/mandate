// Personal agent's page: the version shown beside its chat, the writes that change
// it, the data it draws from, and what the user gives on it.

/** The page's first page, in its folder: the one it opens on. */
export const AGENT_PAGE_FIRST = "index.html";

/** A published version of the page. `pages` is the HTML of each of its
 *  pages, by path in its folder (AGENT_PAGE_FIRST always among them); its
 *  other files are read by path (API_PATHS.agentPageFilesBase). `writer`
 *  names who wrote it: "agent" for the personal agent's own edit, or the
 *  page subagent's title. */
export interface AgentPageVersionDto { revision: number; pages: Record<string, string>; writer: string; createdAt: string }

/** A page subagent's write: running, then how it ended. */
export type AgentPageWriteStatus = "running" | "published" | "unchanged" | "failed";
export interface AgentPageWriteDto {
  taskId: string;
  title: string;
  status: AgentPageWriteStatus;
  startedAt: string;
  finishedAt: string | null;
  revision: number | null;
  error: string | null;
}

/** What the page pane shows in its header: the latest version, and the
 *  running page subagent, else the last one. */
export interface AgentPageStateDto { latest: Omit<AgentPageVersionDto, "pages"> | null; write: AgentPageWriteDto | null }

/** A data source the page listed in sources.json. */
export interface AgentPageSourceDto {
  name: string;
  run: string;
  everyMs: number;
  cwd: string | null;
  paused: boolean;
  lastRunAt: string | null;
  lastError: string | null;
}

/** How a scheduled update last went: the page subagent it started changed
 *  the page, or changed nothing (or nothing had changed, so none started),
 *  or failed. */
export type AgentPageUpdateOutcome = "updated" | "unchanged" | "failed";

/** A scheduled update updates.json lists: when it runs (`when`, a 5-field
 *  cron; `whenText`, it in words where it has a common shape), what its page
 *  subagent is asked (`task`), and how it last went. */
export interface AgentPageUpdateDto {
  name: string;
  when: string;
  whenText: string;
  task: string;
  paused: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastOutcome: AgentPageUpdateOutcome | null;
  lastError: string | null;
}

/** A source's latest value, built in or listed: when it was read, and the
 *  last error (null when the last read worked). */
export interface AgentPageDataDto { name: string; value: unknown; at: string | null; error: string | null }

/** Something the user gave on the page; read once it reached the personal agent. */
export interface AgentPageAnswerDto { id: string; value: unknown; at: string; read: boolean }

export const AGENT_PAGE_BUILTINS = ["threads", "workers", "waiting", "usage", "canvases", "questions", "answers", "on_duty", "tasks"] as const;
export type AgentPageBuiltin = typeof AGENT_PAGE_BUILTINS[number];

export const AGENT_PAGE_LIMITS = {
  versions: 5,
  /** Files in the page's folder, all its pages and what they load. */
  siteFiles: 200,
  /** Scheduled updates updates.json may list, and how long a task may be. */
  updates: 10,
  updateTaskMaxChars: 2000,
  sources: 20,
  sourceMinEveryMs: 60_000,
  sourceMaxEveryMs: 86_400_000,
  sourceTimeoutMs: 60_000,
  sourceOutputMaxBytes: 65_536,
  sourceConcurrency: 4,
  answerMaxBytes: 8_192,
  /** Answers waiting for the personal agent at once: a page cannot flood its next turn. */
  answersUnreadMax: 20
} as const;

/** A listed source's name: letters, digits, - and _. */
export const AGENT_PAGE_SOURCE_NAME = /^[A-Za-z0-9_-]{1,40}$/;
