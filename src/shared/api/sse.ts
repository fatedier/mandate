import type { GlobalAgentDto, GlobalHandoffDto } from "./global-agent.js";
import type { BackgroundTaskDto } from "./background-tasks.js";
import type { AgentPageAnswerDto, AgentPageDataDto, AgentPageSourceDto, AgentPageStateDto } from "./agent-page.js";
import type {
  AgentContextUsageDto,
  AgentClientMessageDto,
  AgentMonitorsRevision,
  AgentPendingMonitorDto,
  AgentScope,
  AgentWakeMetadata,
  AgentWakeReason,
  AgentWakeStatus,
  AgentWakeUserErrorDto,
  ManagerThreadDto,
  ModelRefDto
} from "./agents.js";
import type { AppStateErrorDto } from "./state.js";
import type { FeatureDto } from "./features.js";
import type { ProjectStateDto } from "./project-state.js";
import type { ProjectDto } from "./projects.js";
import type { WorkItemDto } from "./work-items.js";
import type { FeaturePlanDto } from "./plans.js";
import type { ThreadStatusSnapshotDto } from "./thread-status.js";
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
  /** A project's row changed in place (its working directory). */
  projectUpdated: "projectUpdated",
  featureCreated: "featureCreated",
  featureArchived: "featureArchived",
  featureRestored: "featureRestored",
  /** A worker moved to another thread (restored by it, or its owner was gone). */
  featureOwnerChanged: "featureOwnerChanged",
  paneCreated: "paneCreated",
  featureTerminalCleanupFailed: "featureTerminalCleanupFailed",
  featureWorktreeCleanupFailed: "featureWorktreeCleanupFailed",
  featureBranchCleanupFailed: "featureBranchCleanupFailed",
  agentMessageAppended: "agentMessageAppended",
  agentMessageDelta: "agentMessageDelta",
  agentReasoningHeading: "agentReasoningHeading",
  agentMessagePatch: "agentMessagePatch",
  agentMessageStreams: "agentMessageStreams",
  agentWakeStarted: "agentWakeStarted",
  agentContextUsageUpdated: "agentContextUsageUpdated",
  agentWakeFinished: "agentWakeFinished",
  /** A thread was switched to another model, or back to Default. */
  agentThreadModelChanged: "agentThreadModelChanged",
  /** A turn's model call started on a model other than its last: the model
   *  the turn runs on now (a fallback's, after its primary failed). */
  agentWakeModel: "agentWakeModel",
  /** What a thread's agent is still waiting on changed: a monitor was
   *  registered, changed, fired, timed out or cancelled. */
  agentMonitorsChanged: "agentMonitorsChanged",
  agentCompressionStarted: "agentCompressionStarted",
  agentCompressionFinished: "agentCompressionFinished",
  agentCompressionFailed: "agentCompressionFailed",
  canvasUpdated: "canvasUpdated",
  workItemCreated: "workItemCreated",
  featurePlanUpdated: "featurePlanUpdated",
  /** A worker's task record was written: memory extraction rewrote it when
   *  the worker's window was compacted or archived. */
  featureRecordUpdated: "featureRecordUpdated",
  /** Every active plan, sent when a connection opens and before the projects,
   *  so no feature is drawn without its plan. */
  featurePlans: "featurePlans",
  workItemUpdated: "workItemUpdated",
  /** Every open manager thread, sent when a connection opens, before the plans. */
  managerThreads: "managerThreads",
  managerThreadUpdated: "managerThreadUpdated",
  /** Every open manager thread's state and what waits on the user, sent whole
   *  when a connection opens and whenever any of it changes. */
  threadStatus: "threadStatus",
  /** An archived thread was deleted for good. */
  managerThreadDeleted: "managerThreadDeleted",
  /** A handoff the global agent made changed state. */
  globalHandoffUpdated: "globalHandoffUpdated",
  /** The global agent's state, sent when a connection opens. */
  globalAgent: "globalAgent",
  globalAgentUpdated: "globalAgentUpdated",
  /** A background task (a subagent or a command) was started or queued, began, or ended. */
  backgroundTaskChanged: "backgroundTaskChanged",
  /** A running background command's last line, at most every
   *  COMMAND_LIMITS.liveLineMs: not stored, no seq. */
  backgroundTaskOutput: "backgroundTaskOutput",
  /** Your agent's page: a new version, or a page subagent's write began or ended. */
  agentPageUpdated: "agentPageUpdated",
  /** A page source was run, paused, resumed, removed, or listed anew. */
  agentPageSourceChanged: "agentPageSourceChanged",
  /** The user gave something on the page. */
  agentPageAnswer: "agentPageAnswer"
} as const;

export type SseEventName = typeof SSE_EVENTS[keyof typeof SSE_EVENTS];
export type LifecycleSseEventName =
  | typeof SSE_EVENTS.projectCreated
  | typeof SSE_EVENTS.projectArchived
  | typeof SSE_EVENTS.projectAdopted
  | typeof SSE_EVENTS.projectReordered
  | typeof SSE_EVENTS.projectReconciled
  | typeof SSE_EVENTS.projectUpdated
  | typeof SSE_EVENTS.featureCreated
  | typeof SSE_EVENTS.featureArchived
  | typeof SSE_EVENTS.featureRestored
  | typeof SSE_EVENTS.featureOwnerChanged
  | typeof SSE_EVENTS.paneCreated
  | typeof SSE_EVENTS.featureTerminalCleanupFailed
  | typeof SSE_EVENTS.featureWorktreeCleanupFailed
  | typeof SSE_EVENTS.featureBranchCleanupFailed;

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

/** A canvas changed, or was deleted: lists and open views refetch it. */
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
  [SSE_EVENTS.projectUpdated]: ProjectDto;
  [SSE_EVENTS.featureCreated]: FeatureDto;
  [SSE_EVENTS.featureArchived]: { id: string; projectId?: string | null };
  [SSE_EVENTS.featureRestored]: FeatureDto;
  [SSE_EVENTS.featureOwnerChanged]: { id: string; ownerThreadId: string };
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
  /** The heading a running step's reasoning summary has reached; sent when it changes. */
  [SSE_EVENTS.agentReasoningHeading]: { threadId: string; wakeId: string; heading: string };
  [SSE_EVENTS.agentMessagePatch]: AgentMessagePatchDto;
  /** Authoritative active streams on every connection, including an empty list. */
  [SSE_EVENTS.agentMessageStreams]: { streams: AgentMessageStreamDto[] };
  [SSE_EVENTS.agentWakeStarted]: {
    threadId: string;
    wakeId: string;
    reason: AgentWakeReason;
    triggerMessageId?: string | null;
    metadata?: AgentWakeMetadata | null;
    /** The wake's own start, so a clock shows how long it has been working. */
    startedAt: string;
    /** Scope of the wake's thread — lets clients map wake activity to a
     *  feature card without a thread lookup. Absent when the thread could not
     *  be read as the wake started. */
    scope?: AgentScope;
    scopeId?: string | null;
  };
  [SSE_EVENTS.agentContextUsageUpdated]: {
    threadId: string;
    wakeId: string;
    contextUsage: AgentContextUsageDto;
  };
  [SSE_EVENTS.agentThreadModelChanged]: { threadId: string };
  [SSE_EVENTS.agentWakeModel]: { threadId: string; wakeId: string; model: ModelRefDto };
  [SSE_EVENTS.agentWakeFinished]: {
    threadId: string;
    wakeId: string;
    status: Exclude<AgentWakeStatus, "running">;
    stepCount?: number;
    errorMessage?: string | null;
    error?: AgentWakeUserErrorDto | null;
    contextUsage?: AgentContextUsageDto | null;
    /** See agentWakeStarted: absent when the thread could not be read. */
    scope?: AgentScope;
    scopeId?: string | null;
  };
  /** The thread's whole current set, in the order registered, and its
   *  revision: a thread read with the same or a later one is as new. */
  [SSE_EVENTS.agentMonitorsChanged]: {
    threadId: string;
    /** Whose thread it is ("worker" carries the feature id), for a page that
     *  never read it; null when the store no longer has the thread. */
    scope: AgentScope | null;
    scopeId: string | null;
    monitors: AgentPendingMonitorDto[];
    revision: AgentMonitorsRevision;
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
    /** What started the run, as on the started event ("manual" for one a
     *  person asked for). */
    reason?: string;
    finishedAt?: string;
  };
  [SSE_EVENTS.canvasUpdated]: CanvasUpdatedPayload;
  [SSE_EVENTS.workItemCreated]: { item: WorkItemDto };
  [SSE_EVENTS.featurePlanUpdated]: { plan: FeaturePlanDto };
  [SSE_EVENTS.featureRecordUpdated]: { featureId: string };
  [SSE_EVENTS.featurePlans]: { plans: FeaturePlanDto[] };
  [SSE_EVENTS.workItemUpdated]: { item: WorkItemDto };
  [SSE_EVENTS.managerThreads]: { threads: ManagerThreadDto[] };
  [SSE_EVENTS.managerThreadUpdated]: { thread: ManagerThreadDto };
  [SSE_EVENTS.threadStatus]: ThreadStatusSnapshotDto;
  [SSE_EVENTS.managerThreadDeleted]: { threadId: string };
  [SSE_EVENTS.globalHandoffUpdated]: { handoff: GlobalHandoffDto };
  [SSE_EVENTS.globalAgent]: { agent: GlobalAgentDto };
  [SSE_EVENTS.globalAgentUpdated]: { agent: GlobalAgentDto };
  [SSE_EVENTS.backgroundTaskChanged]: { task: BackgroundTaskDto };
  [SSE_EVENTS.backgroundTaskOutput]: { taskId: string; parentThreadId: string; lastLine: string; bytes: number; lines: number };
  [SSE_EVENTS.agentPageUpdated]: { state: AgentPageStateDto };
  /** `data` left out: a run read what the last one did (its value and error). */
  [SSE_EVENTS.agentPageSourceChanged]: { name: string; source: AgentPageSourceDto | null; data?: AgentPageDataDto | null };
  [SSE_EVENTS.agentPageAnswer]: { answer: AgentPageAnswerDto };
};

export type SseEvent = {
  [K in SseEventName]: {
    event: K;
    data: SseEventPayloadMap[K];
  }
}[SseEventName];
