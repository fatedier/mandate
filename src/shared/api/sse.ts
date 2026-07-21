import type { UiSummaryRequestPayload } from "../ui-context.js";
import type {
  AgentContextUsageDto,
  AgentClientMessageDto,
  AgentScope,
  AgentWakeMetadata,
  AgentWakeReason,
  AgentWakeStatus,
  AgentWakeUserErrorDto
} from "./agents.js";
import type { AppStateErrorDto } from "./state.js";
import type { FeatureDto } from "./features.js";
import type { ProjectStateDto } from "./project-state.js";
import type { ProjectDto } from "./projects.js";
import type { WorkItemDto } from "./work-items.js";
import type { SnapshotFullDto, SnapshotPatchDto } from "./workspace-snapshot.js";

export const SSE_HEARTBEAT_EVENT = "_hb";
export const DEFAULT_SSE_HEARTBEAT_MS = 10000;

export const SSE_EVENTS = {
  error: "error",
  snapshot: "snapshot",
  snapshotFull: "snapshotFull",
  snapshotPatch: "snapshotPatch",
  projectsState: "projectsState",
  projectCreated: "projectCreated",
  projectArchived: "projectArchived",
  projectAdopted: "projectAdopted",
  projectReordered: "projectReordered",
  projectReconciled: "projectReconciled",
  featureCreated: "featureCreated",
  featureArchived: "featureArchived",
  featureRestored: "featureRestored",
  paneCreated: "paneCreated",
  featureTerminalCleanupFailed: "featureTerminalCleanupFailed",
  featureWorktreeCleanupFailed: "featureWorktreeCleanupFailed",
  featureBranchCleanupFailed: "featureBranchCleanupFailed",
  agentMessageAppended: "agentMessageAppended",
  agentMessageDelta: "agentMessageDelta",
  agentMessagePatch: "agentMessagePatch",
  agentMessageStreams: "agentMessageStreams",
  agentWakeStarted: "agentWakeStarted",
  agentContextUsageUpdated: "agentContextUsageUpdated",
  agentWakeFinished: "agentWakeFinished",
  agentCompressionStarted: "agentCompressionStarted",
  agentCompressionFinished: "agentCompressionFinished",
  agentCompressionFailed: "agentCompressionFailed",
  agentSideTransferUpdated: "agentSideTransferUpdated",
  agentUiAction: "agentUiAction",
  canvasUpdated: "canvasUpdated",
  uiSummaryRequest: "uiSummaryRequest",
  workItemCreated: "workItemCreated",
  workItemUpdated: "workItemUpdated"
} as const;

export const UI_ACTIONS = {
  navigate: "navigate",
  openUrl: "open-url"
} as const;

export type SseEventName = typeof SSE_EVENTS[keyof typeof SSE_EVENTS];
export type LifecycleSseEventName =
  | typeof SSE_EVENTS.projectCreated
  | typeof SSE_EVENTS.projectArchived
  | typeof SSE_EVENTS.projectAdopted
  | typeof SSE_EVENTS.projectReordered
  | typeof SSE_EVENTS.projectReconciled
  | typeof SSE_EVENTS.featureCreated
  | typeof SSE_EVENTS.featureArchived
  | typeof SSE_EVENTS.featureRestored
  | typeof SSE_EVENTS.paneCreated
  | typeof SSE_EVENTS.featureTerminalCleanupFailed
  | typeof SSE_EVENTS.featureWorktreeCleanupFailed
  | typeof SSE_EVENTS.featureBranchCleanupFailed;

export type UiActionEvent =
  | { action: typeof UI_ACTIONS.navigate; payload: { path: string } }
  | { action: typeof UI_ACTIONS.openUrl; payload: { url: string } }
  | { action: string; payload?: unknown };

export interface AgentMessageStreamDto {
  threadId: string;
  wakeId: string;
  totalText: string;
}

export interface AgentMessagePatchDto {
  threadId: string;
  wakeId: string;
  /** UTF-16 string offset. Zero replaces the stream; otherwise append here. */
  offset: number;
  deltaText: string;
}

export interface CanvasUpdatedPayload {
  canvasId: string;
  /** Null means the Canvas has no owning Worker. */
  featureId: string | null;
}

export type SseEventPayloadMap = {
  [SSE_EVENTS.error]: AppStateErrorDto;
  [SSE_EVENTS.snapshot]: unknown;
  [SSE_EVENTS.snapshotFull]: SnapshotFullDto;
  [SSE_EVENTS.snapshotPatch]: SnapshotPatchDto;
  [SSE_EVENTS.projectsState]: ProjectStateDto[];
  [SSE_EVENTS.projectCreated]: ProjectDto;
  [SSE_EVENTS.projectArchived]: { id: string };
  [SSE_EVENTS.projectAdopted]: unknown;
  [SSE_EVENTS.projectReordered]: { ids: string[] };
  [SSE_EVENTS.projectReconciled]: unknown;
  [SSE_EVENTS.featureCreated]: FeatureDto;
  [SSE_EVENTS.featureArchived]: { id: string; projectId?: string | null };
  [SSE_EVENTS.featureRestored]: FeatureDto;
  [SSE_EVENTS.paneCreated]: unknown;
  [SSE_EVENTS.featureTerminalCleanupFailed]: {
    id: string;
    windowName: string;
    error: string;
  };
  [SSE_EVENTS.featureWorktreeCleanupFailed]: {
    id: string;
    worktreePath: string;
    error: string;
  };
  [SSE_EVENTS.featureBranchCleanupFailed]: {
    id: string;
    branch: string;
    error: string;
  };
  [SSE_EVENTS.agentMessageAppended]: {
    threadId: string;
    message: AgentClientMessageDto;
  };
  [SSE_EVENTS.agentMessageDelta]: {
    threadId: string;
    wakeId: string;
    deltaText: string;
    totalText: string;
  };
  [SSE_EVENTS.agentMessagePatch]: AgentMessagePatchDto;
  /** Authoritative active streams on every connection, including an empty list. */
  [SSE_EVENTS.agentMessageStreams]: { streams: AgentMessageStreamDto[] };
  [SSE_EVENTS.agentWakeStarted]: {
    threadId: string;
    wakeId: string;
    reason: AgentWakeReason;
    triggerMessageId?: string | null;
    metadata?: AgentWakeMetadata | null;
    /** Scope of the wake's thread — lets clients map wake activity to a
     *  feature card without a thread lookup. Optional so consumers keep
     *  working against older servers that don't emit it. */
    scope?: AgentScope;
    scopeId?: string | null;
  };
  [SSE_EVENTS.agentContextUsageUpdated]: {
    threadId: string;
    wakeId: string;
    contextUsage: AgentContextUsageDto;
  };
  [SSE_EVENTS.agentWakeFinished]: {
    threadId: string;
    wakeId: string;
    status: Exclude<AgentWakeStatus, "running">;
    stepCount?: number;
    errorMessage?: string | null;
    error?: AgentWakeUserErrorDto | null;
    contextUsage?: AgentContextUsageDto | null;
    /** See agentWakeStarted — same optional scope enrichment. */
    scope?: AgentScope;
    scopeId?: string | null;
  };
  [SSE_EVENTS.agentCompressionStarted]: {
    threadId: string;
    compressionId: string;
    startedAt: string;
    activeMessageCount?: number;
    thresholdTokens?: number;
    reason?: string;
    wakeId?: string;
    triggerMessageId?: string | null;
  };
  [SSE_EVENTS.agentCompressionFinished]: {
    threadId: string;
    compressionId: string;
    status?: "finished";
    summaryMessageId?: string | null;
    replacedCount?: number;
    replacedRange?: unknown;
    contextUsage?: AgentContextUsageDto | null;
    finishedAt?: string;
  };
  [SSE_EVENTS.agentCompressionFailed]: {
    threadId: string;
    compressionId: string;
    status?: "error";
    errorMessage?: string;
    finishedAt?: string;
  };
  [SSE_EVENTS.agentSideTransferUpdated]: import("./agents.js").AgentSideTransferDto;
  [SSE_EVENTS.agentUiAction]: UiActionEvent;
  [SSE_EVENTS.canvasUpdated]: CanvasUpdatedPayload;
  [SSE_EVENTS.uiSummaryRequest]: UiSummaryRequestPayload;
  [SSE_EVENTS.workItemCreated]: { item: WorkItemDto };
  [SSE_EVENTS.workItemUpdated]: { item: WorkItemDto };
};

export type SseEvent = {
  [K in SseEventName]: {
    event: K;
    data: SseEventPayloadMap[K];
  }
}[SseEventName];
