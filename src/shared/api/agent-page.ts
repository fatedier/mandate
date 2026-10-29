// Your agent's page: the version shown beside its chat, the writes that change
// it, the data it draws from, and what the user gives on it.

/** A published version of the page. `writer` names who wrote it: "agent"
 *  for Your agent's own edit, or the page subagent's title. */
export interface AgentPageVersionDto { revision: number; html: string; writer: string; createdAt: string }

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
export interface AgentPageStateDto { latest: Omit<AgentPageVersionDto, "html"> | null; write: AgentPageWriteDto | null }

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

/** A source's latest value, built in or listed: when it was read, and the
 *  last error (null when the last read worked). */
export interface AgentPageDataDto { name: string; value: unknown; at: string | null; error: string | null }

/** Something the user gave on the page; read once it reached Your agent. */
export interface AgentPageAnswerDto { id: string; value: unknown; at: string; read: boolean }

export const AGENT_PAGE_BUILTINS = ["threads", "workers", "waiting", "usage", "canvases", "questions", "answers"] as const;
export type AgentPageBuiltin = typeof AGENT_PAGE_BUILTINS[number];

export const AGENT_PAGE_LIMITS = {
  versions: 50,
  sources: 20,
  sourceMinEveryMs: 60_000,
  sourceMaxEveryMs: 86_400_000,
  sourceTimeoutMs: 60_000,
  sourceOutputMaxBytes: 65_536,
  sourceConcurrency: 4,
  answerMaxBytes: 8_192,
  /** Answers waiting for Your agent at once: a page cannot flood its next turn. */
  answersUnreadMax: 20
} as const;

/** A listed source's name: letters, digits, - and _. */
export const AGENT_PAGE_SOURCE_NAME = /^[A-Za-z0-9_-]{1,40}$/;
