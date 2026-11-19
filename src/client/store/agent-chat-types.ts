import type { DutyReportOutcome } from "@shared/api/schedules";
import type { StoreApi } from "zustand";
import type { AgentMessageAttachment } from "@shared/agent-message-types";
import type { AnsweredQuestion } from "@shared/questions";
import type { Mention } from "@shared/mentions";
import type { PageQuote } from "@shared/page-quotes";
import type {
  AgentContextUsageDto,
  AgentClientMessageDto,
  AgentMessagePatchDto,
  AgentMessageStreamDto,
  AgentMonitorsRevision,
  AgentPendingMonitorDto,
  AgentScope,
  AgentWakeReason
} from "@shared/api-contracts";

/** A conversation: one manager thread, the personal agent's or a side chat,
 *  addressed by id, or one worker's; or a subagent's, read only: its steps,
 *  loaded so that live events reach them. Nothing is ever sent to a subagent's. */
export type AgentChatScope =
  | { type: "worker"; workerId: string }
  | { type: "manager"; threadId: string }
  | { type: "personal"; threadId: string }
  | { type: "side_chat"; threadId: string }
  | { type: "subagent"; threadId: string };

/** Anything with a thread in `threadsByScope`: every per-thread action takes
 *  one of these. */
export type ChatThreadScope = AgentChatScope;

export type AgentMessage = AgentClientMessageDto;

export interface PendingMessage {
  localId: string;
  content: string;
  attachments?: AgentMessageAttachment[];
  status: "sending" | "queued" | "sent" | "failed";
  createdAt: string;
  messageId?: string;
  error?: string;
  /** The questions it answers, for its bubble to quote while it is on its way. */
  answers?: AnsweredQuestion[];
  /** What its `@<label>` words name: drawn as tags while it is on its way, and
   *  sent again by a retry. */
  mentions?: Mention[];
  /** The page's items it quotes: drawn above its words while it is on its
   *  way, and sent again by a retry. */
  pageQuotes?: PageQuote[];
}

export type AgentContextUsage = AgentContextUsageDto;

export interface ThreadState {
  threadId: string | null;
  messages: AgentMessage[];
  oldestSeqLoaded: number | null;
  hasMoreOlder: boolean;
  streamingAssistant: { wakeId: string; totalText: string } | null;
  /** Runtime lookup for wakes observed over SSE. Persisted messages also carry
   *  `wakeReason`, but streaming replies need the reason before the final
   *  message append arrives. */
  wakeReasonsById: Map<string, AgentWakeReason>;
  wakePhase: {
    wakeId: string | null;
    phase: "thinking" | "idle";
    /** When the wake began, once the client has heard. */
    startedAt?: string;
  };
  compressionPhase: {
    compressionId: string;
    startedAt: string;
  } | null;
  pendingUserMessages: Map<string, PendingMessage>;
  contextUsage: AgentContextUsage | null;
  /** What the agent is still waiting on: its pending monitors. */
  monitors: AgentPendingMonitorDto[];
  /** The revision that set is current as of (a read's monitorsRevision, an
   *  event's revision): an earlier one never replaces it. */
  monitorsRevision: AgentMonitorsRevision | null;
  /** A page of it has arrived: an empty conversation is loaded too. */
  loaded: boolean;
  /** The messages this page was told are deleted. A read that set out
   *  before one went can land after: what it carries of them is not taken
   *  back in (withoutDeleted). Absent until one is. */
  deletedIds?: ReadonlySet<string>;
}

export interface AgentChatStore {
  /** Every loaded conversation, keyed by scopeKey(). */
  threadsByScope: Map<string, ThreadState>;
  /** Active incremental streams, including conversations not loaded yet. */
  messageStreams: Map<string, NonNullable<ThreadState["streamingAssistant"]>>;
  /** Report marks heard live, by message id: one heard before its reply is
   *  loaded (a page on its way) still shows once it is. */
  dutyMarks: Map<string, DutyReportOutcome>;
  /** Conversations a second view reads whole (History): their loaded rows
   *  are not trimmed while it holds them. A count per scope key. */
  wholeHeld: Map<string, number>;
  /** Holds a conversation whole; the function returned lets go. */
  holdWhole: (key: string) => () => void;

  /** Resolves with the terminal status of the optimistic send. Never rejects —
   *  failures are recorded on the pending message AND reported via the return
   *  value so inline reply UIs (e.g. QuestionCallout) can surface them. */
  sendMessage: (
    scope: ChatThreadScope,
    content: string,
    attachments?: AgentMessageAttachment[],
    mentions?: Mention[],
    pageQuotes?: PageQuote[]
  ) => Promise<"sent" | "queued" | "failed">;
  /** Sends a suggested answer of an open question as the user's message.
   *  Resolves with null once it went, or with why it did not (the question
   *  closed meanwhile): nothing is left to retry then. */
  answerQuestion: (scope: ChatThreadScope, question: AnsweredQuestion, label: string) => Promise<string | null>;
  /** Skips an open question: it closes without an answer. Resolves with null
   *  once it went, or with why it did not (the question closed meanwhile). */
  skipQuestion: (scope: ChatThreadScope, questionId: string) => Promise<string | null>;
  /** Asks a turn that stopped (on a repeated failing call, or cut off at the
   *  output limit) to go on: the user's message, sent by the control, so it answers
   *  none of the questions the turn had asked. */
  continueTurn: (scope: ChatThreadScope) => Promise<void>;
  retryFailedMessage: (scope: ChatThreadScope, localId: string) => Promise<void>;
  deleteQueuedMessage: (scope: ChatThreadScope, localId: string) => Promise<void>;
  /** Deletes a message of the owner's the agent has not answered; rejects
   *  with the server's words when it will not. */
  deleteMessage: (messageId: string) => Promise<void>;
  /** Messages deleted from a conversation (the stream said so, or this
   *  page's delete): they leave it. */
  onMessagesDeleted: (threadId: string, messageIds: readonly string[]) => void;
  ensureThreadLoaded: (scope: ChatThreadScope) => Promise<void>;
  /** Loads the page before the oldest loaded. Its write goes through `apply`
   *  (the transcript wraps it to keep the reader's place); by default, run as
   *  is. Resolved, it added older messages or reached the start; a page it
   *  cannot take rejects (see ApplyOlder). */
  loadOlder: (scope: ChatThreadScope, apply?: (write: () => void) => void) => Promise<void>;
  onMessageAppended: (threadId: string, message: AgentMessage, fromHistory?: boolean) => void;
  onMessagePatch: (patch: AgentMessagePatchDto) => boolean;
  /** What became of a duty thread's reply, recorded as its round ended. */
  onDutyReport: (threadId: string, messageId: string, outcome: DutyReportOutcome) => void;
  onMessageStreams: (streams: AgentMessageStreamDto[]) => void;
  onWakeStarted: (
    threadId: string,
    wakeId: string,
    reason: AgentWakeReason,
    startedAt: string,
    /** The wake's thread's scope, when the server could read it: a worker
     *  conversation started after its page read none is bound by it. */
    scope?: AgentScope,
    scopeId?: string | null
  ) => void;
  onContextUsageUpdated: (
    threadId: string,
    wakeId: string,
    contextUsage: AgentContextUsage
  ) => void;
  onWakeFinished: (threadId: string, wakeId: string, contextUsage?: AgentContextUsage | null) => void;
  /** What the thread's agent is still waiting on changed (agentMonitorsChanged). */
  onMonitorsChanged: (threadId: string, monitors: AgentPendingMonitorDto[], revision: AgentMonitorsRevision) => void;
  onCompressionStarted: (threadId: string, compressionId: string, startedAt: string) => void;
  onCompressionFinished: (
    threadId: string,
    compressionId: string,
    contextUsage?: AgentContextUsage | null
  ) => void;
  onCompressionFailed: (threadId: string, compressionId: string) => void;
  /** Runs a failed wake again as it was first run. */
  retryWake: (scope: ChatThreadScope, wakeId: string) => Promise<void>;
  cancelWake: (scope: ChatThreadScope) => Promise<void>;
  /** Refetch any messages newer than what we have for every loaded scope.
   *  Called on SSE reconnect to recover events that fired during the dead
   *  window (server doesn't replay). Safe to call repeatedly — onMessageAppended
   *  dedupes by message id. */
  refetchIncrementalForOpenScopes: () => Promise<void>;
  /** A view showing this conversation holds it; the function returned lets
   *  go. One no view has held for RELEASE_AFTER_MS since its last close is
   *  dropped from the store (a subagent's: its views hold it), so it is
   *  neither kept nor read again at a reconnect; a read still on its way for
   *  it writes nothing, and shown again it is read anew. */
  holdThread: (scope: ChatThreadScope) => () => void;
}

export type AgentChatSet = StoreApi<AgentChatStore>["setState"];
export type AgentChatGet = () => AgentChatStore;
