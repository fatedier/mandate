import type {
  AgentMessageAttachment,
  AgentMessageContent,
  AgentMessageSource,
  AgentRole,
  AssistantContent,
  FeatureEventContent
} from "../agent-message-types.js";
import type { ApiErrorResponse } from "./common.js";
import type { WorkItemRefSnapshot } from "./work-items.js";

export type AgentScope = "manager" | "worker";
export type AgentThreadKind = "main" | "side";

export interface AgentThreadDto {
  id: string;
  scope: AgentScope;
  scopeId: string | null;
  kind: AgentThreadKind;
  parentThreadId: string | null;
  ephemeral: boolean;
  forkContextStartSeq: number | null;
  forkContextEndSeq: number | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface AgentWakeMetadata {
  featureEvents?: FeatureEventContent[];
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
  wakeMetadata?: AgentWakeMetadata | null;
  content: AgentMessageContent;
  createdAt: string;
}

/** Browser transcript. Provider continuation data stays in the server store. */
export type AgentClientMessageDto = Omit<AgentMessageDto, "content"> & {
  content: Exclude<AgentMessageContent, AssistantContent> | Omit<AssistantContent, "sdkAssistantMessages">;
};

export type AgentWakeReason =
  | "user"
  | "side-summary"
  | "analyzer-event"
  | "feature-event"
  | "work-item-heartbeat"
  | "watch"
  | "alarm"
  | "work-item-promote";
export type AgentWakeStatus = "running" | "finished" | "limit_reached" | "error" | "canceled";
export type AgentWakeErrorCategory =
  | "provider_overloaded"
  | "rate_limited"
  | "timeout"
  | "context_too_large"
  | "auth_failed"
  | "invalid_request"
  | "provider_error"
  | "unknown";

export interface AgentWakeUserErrorDto {
  message: string;
  category: AgentWakeErrorCategory;
  code?: string;
  retryable: boolean;
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
}

export interface ActiveWakesResponse {
  wakes: ActiveWakeDto[];
}

export interface AgentContextUsageDto {
  inputTokens: number | null;
  budgetTokens: number;
  updatedAt: string | null;
  source: "compression_budget";
}

export interface AgentPostMessageRequest {
  content: string;
  attachments?: AgentMessageAttachment[];
  clientRequestId?: string;
  clientId?: string;
  uiLocation?: unknown;
  /** Optional reference to a work_item this message is "about". The server
   *  enriches it into message.content.metadata.workItemRef so chat can render
   *  a card and the model can see a compact work-item context block. */
  workItemRef?: Pick<WorkItemRefSnapshot, "itemId" | "snapshotAt">;
}

export type AgentPostMessageResponse =
  | {
      threadId: string;
      messageId: string | null;
      wakeId: string | null;
      queued?: boolean;
      queuedReason?: "running_wake";
    }
  | ApiErrorResponse;

export type AgentDeleteQueuedMessageResponse =
  | {
      ok: true;
      removed: boolean;
    }
  | ApiErrorResponse;

export type AgentThreadResponse =
  | {
      thread: AgentThreadDto | null;
      messages: AgentClientMessageDto[];
      hasMore?: boolean;
      contextUsage?: AgentContextUsageDto | null;
    }
  | ApiErrorResponse;

export type AgentSideForkResponse =
  | {
      thread: AgentThreadDto;
      parentThread: AgentThreadDto;
    }
  | ApiErrorResponse;

export type AgentSideTransferStatus =
  | "pending"
  | "delivered"
  | "needs_retarget"
  | "canceled";

export interface AgentSideTransferDto {
  id: string;
  sourceThreadId: string;
  targetThreadId: string;
  clientRequestId: string;
  content: string;
  status: AgentSideTransferStatus;
  deliveredMessageId: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export type AgentCancelWakeResponse =
  | {
      ok: boolean;
      wakeId: string;
      status: AgentWakeStatus;
      message?: string;
    }
  | ApiErrorResponse;
