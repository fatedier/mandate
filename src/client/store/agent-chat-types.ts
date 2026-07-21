import type { StoreApi } from "zustand";
import type { AgentMessageAttachment } from "@shared/agent-message-types";
import type {
  AgentContextUsageDto,
  AgentClientMessageDto,
  AgentMessagePatchDto,
  AgentMessageStreamDto,
  AgentWakeMetadata,
  AgentWakeReason,
  AgentWakeUserErrorDto
} from "@shared/api-contracts";

// One desktop layout mode keeps Worker and Chat zoom mutually exclusive.
// Worker zoom leaves the drawer open and mounted, but outside the visible layout.
type DrawerMode = "side" | "fullscreen" | "worker";

export type AgentChatScope = { type: "worker"; featureId: string } | { type: "manager" };

export type AgentMessage = AgentClientMessageDto;

export interface PendingMessage {
  localId: string;
  content: string;
  attachments?: AgentMessageAttachment[];
  status: "sending" | "queued" | "sent" | "failed";
  createdAt: string;
  messageId?: string;
  error?: string;
}

export interface WakeError {
  wakeId: string;
  status: "error" | "limit_reached";
  message: string;
  category?: AgentWakeUserErrorDto["category"];
  code?: string;
  retryable?: boolean;
  detail?: string;
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
  wakeMetadataById: Map<string, AgentWakeMetadata>;
  wakePhase: {
    wakeId: string | null;
    phase: "thinking" | "running-tool" | "idle";
    activeToolCallId?: string;
    activeToolName?: string;
  };
  compressionPhase: {
    compressionId: string;
    startedAt: string;
  } | null;
  pendingUserMessages: Map<string, PendingMessage>;
  contextUsage: AgentContextUsage | null;
  unreadAssistantCount: number;
  /** Set when the most recent wake failed; cleared when a new wake starts or user dismisses. */
  lastWakeError: WakeError | null;
}

export interface AgentChatStore {
  drawerOpen: boolean;
  drawerScope: AgentChatScope | null;
  drawerMode: DrawerMode;
  threadsByScope: Map<string, ThreadState>;
  /** Active incremental streams, including conversations not loaded yet. */
  messageStreams: Map<string, NonNullable<ThreadState["streamingAssistant"]>>;
  sideThread: ThreadState | null;
  sideParentScope: AgentChatScope | null;
  sideActive: boolean;
  sideTransferNeedsRetargetId: string | null;
  pendingChatRef: {
    scope: AgentChatScope;
    ref: { itemId: string; title: string; snapshotAt: string };
  } | null;

  openDrawer: (scope: AgentChatScope) => void;
  /** Open the drawer and stage a one-shot work_item ref pill so the user
   *  can type their question before sending. */
  openDrawerWithWorkItemRef: (
    scope: AgentChatScope,
    ref: { itemId: string; title: string; snapshotAt: string }
  ) => void;
  /** Clear the pending ref — called when ChatInput sends, or when user
   *  dismisses the pill manually. */
  clearChatRef: () => void;
  closeDrawer: () => void;
  setDrawerMode: (mode: DrawerMode) => void;
  startSideConversation: (scope: AgentChatScope) => Promise<void>;
  showMainConversation: () => void;
  showSideConversation: () => void;
  closeSideConversation: () => Promise<void>;
  sendSideMessage: (
    content: string,
    attachments?: AgentMessageAttachment[]
  ) => Promise<"sent" | "queued" | "failed">;
  retrySideFailedMessage: (localId: string) => Promise<void>;
  deleteSideQueuedMessage: (localId: string) => Promise<void>;
  dismissSideWakeError: () => void;
  cancelSideWake: () => Promise<void>;
  getSideSummaryDraft: () => Promise<string>;
  transferSideSummary: (content: string) => Promise<{
    status: "pending" | "delivered" | "needs_retarget";
    transferId: string;
  }>;
  retargetSideSummary: (transferId: string) => Promise<"pending" | "delivered">;
  /** Resolves with the terminal status of the optimistic send. Never rejects —
   *  failures are recorded on the pending message AND reported via the return
   *  value so inline reply UIs (e.g. QuestionCallout) can surface them. */
  sendMessage: (
    scope: AgentChatScope,
    content: string,
    attachments?: AgentMessageAttachment[],
    workItemRef?: { itemId: string; snapshotAt: string }
  ) => Promise<"sent" | "queued" | "failed">;
  retryFailedMessage: (scope: AgentChatScope, localId: string) => Promise<void>;
  deleteQueuedMessage: (scope: AgentChatScope, localId: string) => Promise<void>;
  ensureThreadLoaded: (scope: AgentChatScope) => Promise<void>;
  loadOlder: (scope: AgentChatScope) => Promise<void>;
  onMessageAppended: (threadId: string, message: AgentMessage, fromHistory?: boolean) => void;
  onMessageDelta: (threadId: string, wakeId: string, deltaText: string, totalText: string) => void;
  onMessagePatch: (patch: AgentMessagePatchDto) => boolean;
  onMessageStreams: (streams: AgentMessageStreamDto[]) => void;
  onWakeStarted: (
    threadId: string,
    wakeId: string,
    reason: AgentWakeReason,
    metadata?: AgentWakeMetadata | null
  ) => void;
  onContextUsageUpdated: (
    threadId: string,
    wakeId: string,
    contextUsage: AgentContextUsage
  ) => void;
  onWakeFinished: (
    threadId: string,
    wakeId: string,
    status: string,
    errorMessage?: string | null,
    contextUsage?: AgentContextUsage | null,
    error?: AgentWakeUserErrorDto | null
  ) => void;
  onCompressionStarted: (threadId: string, compressionId: string, startedAt: string) => void;
  onCompressionFinished: (
    threadId: string,
    compressionId: string,
    contextUsage?: AgentContextUsage | null
  ) => void;
  onCompressionFailed: (threadId: string, compressionId: string) => void;
  onSideTransferUpdated: (transfer: import("@shared/api-contracts").AgentSideTransferDto) => void;
  dismissWakeError: (scope: AgentChatScope) => void;
  cancelWake: (scope: AgentChatScope) => Promise<void>;
  startNewChat: (scope: AgentChatScope) => Promise<void>;
  /** Refetch any messages newer than what we have for every loaded scope.
   *  Called on SSE reconnect to recover events that fired during the dead
   *  window (server doesn't replay). Safe to call repeatedly — onMessageAppended
   *  dedupes by message id. */
  refetchIncrementalForOpenScopes: () => Promise<void>;
}

export type AgentChatSet = StoreApi<AgentChatStore>["setState"];
export type AgentChatGet = () => AgentChatStore;
