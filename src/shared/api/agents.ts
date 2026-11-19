import type { Mention } from "../mentions.js";
import type { PageQuote } from "../page-quotes.js";
import type {
  AgentMessageAttachment,
  AgentMessageContent,
  AgentMessageSource,
  AgentRole,
  AssistantContent
} from "../agent-message-types.js";
import type { OpenQuestion } from "../questions.js";
import type { ApiErrorResponse } from "./common.js";
import type { DutyReportOutcome, DutySummaryDto } from "./schedules.js";

/** "subagent": a subagent's thread, one bounded job for the conversation
 *  that started it (its task row links the two). "side_chat": a side chat,
 *  the personal agent's conversation forked to talk one topic over apart
 *  from it, until the user sends it back or discards it. */
export type AgentScope = "manager" | "worker" | "personal" | "subagent" | "side_chat";
/** The conversations a person has with an agent: each has its own model
 *  route and input checks. A subagent's thread works for one of them and
 *  follows it; a side chat is the personal agent's, and follows it. */
export type ConversationScope = Exclude<AgentScope, "subagent" | "side_chat">;
export interface AgentThreadDto {
  id: string;
  scope: AgentScope;
  scopeId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** Manager threads only: the stored title (null until named). */
  title: string | null;
  /** Manager threads only: last message seq the user has seen. */
  seenSeq: number;
}

export interface AgentWakeMetadata {
  recovery?: {
    wakeIds: string[];
    originalReason: AgentWakeReason;
    originalTriggerMessageId: string | null;
  };
}

export interface AgentMessageDto {
  id: string;
  threadId: string;
  seq: number;
  role: AgentRole;
  source: AgentMessageSource;
  sourceThreadId: string | null;
  wakeId: string | null;
  /** Derived from `wakeId` when present. Lets clients explain automatic
   *  replies without issuing per-message wake lookups. */
  wakeReason?: AgentWakeReason | null;
  /** Metadata captured on the wake, used to explain automatic replies. */
  /** When the message's wake began: how long a turn took, from its messages. */
  wakeStartedAt?: string | null;
  /** The message's wake was stopped by a person (it ended `canceled`); absent
   *  otherwise, a wake still running included. */
  wakeInterrupted?: boolean;
  content: AgentMessageContent;
  createdAt: string;
  /** A duty thread's reply: what became of it (reported to the personal agent, kept
   *  silent, ...). Absent on every other message. */
  dutyReport?: DutyReportOutcome;
}

/** Browser transcript. Provider continuation data stays in the server store. */
export type AgentClientMessageDto = Omit<AgentMessageDto, "content"> & {
  content: Exclude<AgentMessageContent, AssistantContent> | Omit<AssistantContent, "sdkAssistantMessages" | "reasoning">;
};

export type AgentWakeReason =
  | "user"
  | "sweep"
  | "pane-monitor"
  | "command-monitor"
  | "alarm"
  | "worker-report"
  | "thread-notice"
  /** A subagent's one wake: its task. */
  | "subagent-task"
  /** A subagent's result reached the conversation that started it. */
  | "subagent-result"
  /** A background command's end reached the conversation that started it. */
  | "command-result"
  /** A schedule's check found something for its duty thread, or a schedule
   *  has news for the personal agent. */
  | "schedule"
  /** An entry on the personal agent's calendar came due. */
  | "calendar";
export type AgentWakeStatus = "running" | "finished" | "stuck" | "error" | "canceled";
export type AgentWakeErrorCategory =
  | "provider_overloaded"
  | "rate_limited"
  | "timeout"
  | "context_too_large"
  | "auth_failed"
  | "invalid_request"
  /** The provider's safety check flagged the content (OpenAI's cyber_policy). */
  | "content_flagged"
  | "provider_error"
  | "unknown";

export interface AgentWakeUserErrorDto {
  message: string;
  category: AgentWakeErrorCategory;
  code?: string;
  detail?: string;
}

export interface AgentWakeDto {
  id: string;
  threadId: string;
  reason: AgentWakeReason;
  triggerMessageId: string | null;
  status: AgentWakeStatus;
  stepCount: number;
  errorMessage: string | null;
  metadata?: AgentWakeMetadata | null;
  startedAt: string;
  finishedAt: string | null;
}

/** One running wake with its thread's scope, as returned by
 *  GET /api/agents/active-wakes. Clients rebuild their live-activity map
 *  from this list at boot and after SSE reconnects. */
export interface ActiveWakeDto {
  threadId: string;
  wakeId: string;
  scope: AgentScope;
  scopeId: string | null;
  startedAt: string;
}

export interface ActiveWakesResponse {
  wakes: ActiveWakeDto[];
}

export interface AgentContextUsageDto {
  inputTokens: number | null;
  budgetTokens: number;
  updatedAt: string | null;
}

/** What a conversation is doing when a command arrives: nothing; a turn (a
 *  wake is in flight, including one compacting at its own gate); or a
 *  compaction started by hand, which holds the thread with no turn. */
export type AgentCommandState = "idle" | "running" | "compacting";

/** A command a conversation's composer offers. `blocked` names the states it
 *  cannot run in, with the short reason the list shows beside it. */
export interface AgentCommandDto {
  name: string;
  description: string;
  blocked: Partial<Record<AgentCommandState, string>>;
}

export type AgentCommandsResponse = { commands: AgentCommandDto[] } | { error: string };

/** The whole draft, and how many attachments it carries. */
export interface AgentRunCommandRequest {
  text: string;
  attachments: number;
}

/** `taken`: the draft was consumed (clear it); false is a refusal and the
 *  draft stays. `message`: the line to show, null when the effect speaks for
 *  itself. Not `ok`: the client's JSON reader throws on `ok: false`. */
export type AgentRunCommandResponse = { taken: boolean; message: string | null };

export interface AgentPostMessageRequest {
  content: string;
  attachments?: AgentMessageAttachment[];
  clientRequestId?: string;
  /** The open questions this message answers by a pick of a suggested
   *  answer (their ids). Absent: the message names no question, and
   *  answers none. A manager thread's and the personal agent's route take it. */
  answers?: string[];
  /** The control that sent this message for the user: Continue, under a turn
   *  that stopped. It answers no question. */
  control?: "continue";
  /** What its `@<label>` words name (threads, so far): checked by the server,
   *  kept in message.content.metadata.mentions, read by the model as a line
   *  each before the words. A manager thread's and the personal agent's route
   *  take them. */
  mentions?: Mention[];
  /** The items of the personal agent's page the message quotes: kept in
   *  message.content.metadata.pageQuotes, read by the model as a line each
   *  before the words. With them the words may be empty. Only the personal
   *  agent's route takes them. */
  pageQuotes?: PageQuote[];
}

export type AgentPostMessageResponse =
  | {
      threadId: string;
      messageId: string | null;
      wakeId: string | null;
      /** When the started wake began, on the server's clock. */
      wakeStartedAt?: string | null;
      /** Behind a running turn, or behind a side chat's summary still being written. */
      queued?: boolean;
    }
  | ApiErrorResponse;

export type AgentDeleteQueuedMessageResponse =
  | {
      ok: true;
      removed: boolean;
    }
  | ApiErrorResponse;

/** The wake a thread is running, as its page reports it. */
/** A model as Settings names it: `provider/model`, and its two parts. */
export interface ModelRefDto {
  ref: string;
  providerName: string;
  model: string;
}

/** A thread's model as its composer shows and sets it. */
export interface ThreadModelDto {
  /** What its route runs on first: what Default means. */
  default: ModelRefDto;
  /** The model it was switched to; null: Default. */
  override: ModelRefDto | null;
  /** The chat models Settings lists, by provider, both in Settings' order. */
  choices: Array<{ providerName: string; models: ModelRefDto[] }>;
}

export interface AgentActiveWakeDto {
  wakeId: string;
  startedAt: string;
  /** The model its current call runs on, once one started. */
  model?: ModelRefDto;
}

/** Which pending-monitor set is newer: the server's boot, then a count of
 *  changes since it. A later boot is newer whatever its count, so a restart
 *  never reads as older; equal revisions are the same set. */
export interface AgentMonitorsRevision {
  boot: number;
  seq: number;
}

/** What the thread's agent is still waiting on: a monitor registered and not
 *  yet fired, timed out or cancelled, which the chat shows as a waiting line;
 *  or a subagent it started, queued or running, whose result will wake it. */
/** One scheduled check of a command monitor. */
export interface AgentMonitorRunDto {
  at: string;
  /** Null when it timed out or could not run. */
  exitCode: number | null;
  timedOut: boolean;
  /** A `changed` monitor's output differed from the last. */
  changed: boolean;
  /** Its output's last line, cut. */
  line: string;
}

export type AgentPendingMonitorDto =
  | {
      kind: "pane";
      id: string;
      windowKey: string;
      paneId: string;
      /** The pane's name when the monitor was registered: the chat may not have
       *  loaded the call that named it. Null when it had none. */
      paneName: string | null;
      /** How long the pane must stay quiet to wake the agent. */
      stableMs: number;
      timeoutAt: string;
      note: string;
      /** When it was registered: how long the agent has waited on it. */
      createdAt: string;
    }
  | {
      kind: "command";
      id: string;
      command: string;
      description: string | null;
      everyMs: number;
      wakeWhen: "changed" | "succeeds";
      timeoutAt: string;
      note: string;
      /** When it was registered: how long the agent has waited on it. */
      createdAt: string;
      /** Its scheduled checks since it was set, the last and the next, and
       *  the last five, newest first: the chat's card. */
      runCount: number;
      lastRunAt: string | null;
      nextRunAt: string;
      recentRuns: AgentMonitorRunDto[];
    }
  | {
      /** The chat draws no waiting line for it: the strip above the
       *  composer shows the conversation's subagents. */
      kind: "subagent";
      /** The background task's id. */
      id: string;
      title: string;
      status: "queued" | "running";
      /** When it was asked for: how long the agent has waited on it. */
      createdAt: string;
    }
  | {
      /** A command bash runs in the background. Not "command", the monitor's
       *  kind: the strip above the composer shows it, as it shows a subagent. */
      kind: "background-command";
      /** The background task's id. */
      id: string;
      title: string;
      status: "running";
      /** When it started: how long the agent has waited on it. */
      createdAt: string;
    }
  | {
      /** An alarm the agent set (schedule_wake): it wakes the agent at its
       *  time, as a monitor would when it fires. */
      kind: "alarm";
      id: string;
      fireAt: string;
      /** What the agent will do once woken. */
      note: string;
      /** When it was set: how long the agent has waited on it. */
      createdAt: string;
    };

/** A thread that waits on something, with whose thread it is (scope "worker"
 *  carries the worker id): GET /api/agents/pending-monitors lists every one,
 *  for the sidebar's watching state. Scope is null for a thread the store no
 *  longer has. */
export interface AgentPendingMonitorThreadDto {
  threadId: string;
  scope: AgentScope | null;
  scopeId: string | null;
  monitors: AgentPendingMonitorDto[];
}

/** GET /api/agents/pending-monitors: every waiting thread as of `revision`,
 *  the count agentMonitorsChanged carries too. */
export interface AgentPendingMonitorsResponse {
  threads: AgentPendingMonitorThreadDto[];
  revision: AgentMonitorsRevision;
}

export type AgentThreadResponse =
  | {
      thread: AgentThreadDto | null;
      messages: AgentClientMessageDto[];
      hasMore: boolean;
      contextUsage?: AgentContextUsageDto | null;
      activeWake?: AgentActiveWakeDto | null;
      /** What the agent is still waiting on, in the order registered. */
      monitors?: AgentPendingMonitorDto[];
      /** The revision `monitors` is current as of; agentMonitorsChanged
       *  carries the same kind, so the later of the two is newer. */
      monitorsRevision?: AgentMonitorsRevision;
      /** Whether a compaction started by hand is in flight (it runs with no
       *  wake, so activeWake does not say). */
      compacting?: boolean;
      /** When the server read the thread: a wake that began before then and
       *  is not activeWake had finished by then; so had a compaction, when
       *  nothing holds the thread. */
      readAt?: string;
      /** On a read on from where the page was (?since=): the ids of the
       *  thread's messages a person deleted, which the page may still hold.
       *  Absent when there are none. */
      deleted?: string[];
    }
  | ApiErrorResponse;

export type AgentRetryWakeResponse =
  | { ok: true; wakeId: string }
  | ApiErrorResponse;

export type AgentCancelWakeResponse =
  | {
      ok: boolean;
      wakeId: string;
      status: AgentWakeStatus;
      message?: string;
    }
  | ApiErrorResponse;

/** A label on a manager thread: a free name, and who put it on. */
export interface ThreadLabelDto {
  name: string;
  by: "owner" | "agent";
}

/** POST /api/agents/manager/threads/:threadId/labels and DELETE …/labels/:name:
 *  the thread's labels after the change. */
export type ThreadLabelsResponse = { labels: ThreadLabelDto[] } | ApiErrorResponse;

/** An archived manager thread, as its list and its delete dialog show it. */
export interface ArchivedThreadDto {
  id: string;
  title: string;
  archivedAt: string;
  /** When it was last active, as ManagerThreadDto.lastActivityAt: its last
   *  message, else when it began. Not its archiving. */
  lastActivityAt: string;
  /** The workers it owned, which a delete takes along. */
  workers: number;
  /** Its and its workers' reports and designs. */
  canvases: number;
  /** Its labels, in the order they were put on. */
  labels: ThreadLabelDto[];
  /** The projects its workers ran in, by name (as ManagerThreadDto.projects). */
  projects: string[];
}

export interface ManagerThreadDto {
  id: string;
  /** Display title: stored title, else the first user line (≤60 + "…"), else "New thread". */
  title: string;
  /** True once a title is stored (name_thread or the user). */
  named: boolean;
  createdAt: string;
  lastActivityAt: string;
  /** Seq of the newest row the user would read; 0 when none. */
  lastVisibleSeq: number;
  seenSeq: number;
  running: boolean;
  /** Its newest wake ended in an error, or was stopped: nothing has run since. */
  failed: boolean;
  /** Why its newest wake was stopped by the repeat check (it then waits for
   *  a person: reports, alarms and mail do not wake it); null otherwise. */
  stopReason: string | null;
  /** What its manager asked the user and they have not answered, oldest first. */
  questions: OpenQuestion[];
  archivedAt: string | null;
  /** Its schedules and level while it is on duty; null for any other thread. */
  duty: DutySummaryDto | null;
  /** Its labels, in the order they were put on. */
  labels: ThreadLabelDto[];
  /** The projects its workers ran in, by name: active and archived workers,
   *  each project once, in the order the workers were made. */
  projects: string[];
}

export type CreateManagerThreadResponse =
  | { thread: ManagerThreadDto; message: { threadId: string; messageId: string | null; wakeId: string | null; queued?: boolean } | null }
  | ApiErrorResponse;

export type ManagerThreadResponse = { thread: ManagerThreadDto } | ApiErrorResponse;

/** A worker by its id and name. */
export interface WorkerRefDto { id: string; name: string }

/** A worker a thread's archive stopped at, and what was found in it. */
export interface WorkerFindingsDto extends WorkerRefDto { findings: string[] }

/** The choices sent with a thread's archive (PATCH `archived: true`): the
 *  thread goes together with its workers. */
export interface ArchiveThreadChoices {
  /** The workers whose findings the user was shown and said to archive
   *  anyway, by id. Every other worker is checked. */
  confirmed?: string[];
  /** `false` keeps the workers' worktrees, or branches. */
  removeWorktrees?: boolean;
  deleteBranches?: boolean;
}

/** A thread's archive refused over work that would be lost (409). `archived`
 *  are the workers that had gone before a later one refused, and
 *  `cleanupFailures` what their cleanup could not do. */
export interface ArchiveThreadRefusal {
  error: string;
  workers: WorkerFindingsDto[];
  archived: WorkerRefDto[];
  cleanupFailures: unknown[];
}
/** A worker a thread owns, as the thread's panel lists it. `workerThreadId`
 *  is its newest conversation, archived or not: an archived worker's chat is
 *  read from there. */
export interface ThreadWorkerRefDto {
  workerId: string;
  name: string;
  projectId: string;
  projectName: string;
  workerThreadId: string | null;
  archivedAt: string | null;
}
export type ThreadWorkersResponse = { workers: ThreadWorkerRefDto[] } | ApiErrorResponse;
