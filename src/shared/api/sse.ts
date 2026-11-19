import type { PersonalAgentDto, PersonalHandoffDto } from "./personal-agent.js";
import type { NotificationShowEvent, NotificationWithdrawEvent } from "./notifications.js";
import type { BackgroundTaskDto } from "./background-tasks.js";
import type { AgentPageAnswerDto, AgentPageDataDto, AgentPageSourceDto, AgentPageStateDto, AgentPageUpdateDto } from "./agent-page.js";
import type {
  AgentContextUsageDto,
  AgentClientMessageDto,
  AgentMonitorsRevision,
  AgentPendingMonitorDto,
  AgentScope,
  AgentWakeReason,
  AgentWakeStatus,
  AgentWakeUserErrorDto,
  ManagerThreadDto,
  ModelRefDto
} from "./agents.js";
import type { AppStateErrorDto } from "./state.js";
import type { DutyReportOutcome } from "./schedules.js";
import type { SideChatDeletedDto, SideChatsDto, SideChatUpdatedDto } from "./side-chat.js";
import type { TaskBoardDto, TaskRemovedDto, TaskResponse } from "./task-board.js";
import type { StickyNoteResponse, StickyNotesDto } from "./sticky-notes.js";
import type { WorkerDto } from "./workers.js";
import type { ProjectStateDto } from "./project-state.js";
import type { ProjectDto } from "./projects.js";
import type { WorkItemDto } from "./work-items.js";
import type { WorkerPlanDto } from "./plans.js";
import type { CalendarChangedEvent } from "./calendar.js";
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
  projectReordered: "projectReordered",
  projectReconciled: "projectReconciled",
  /** A project's row changed in place (its working directory). */
  projectUpdated: "projectUpdated",
  workerCreated: "workerCreated",
  workerArchived: "workerArchived",
  workerRestored: "workerRestored",
  /** A worker moved to another thread (restored by it, or its owner was gone). */
  workerOwnerChanged: "workerOwnerChanged",
  paneCreated: "paneCreated",
  agentMessageAppended: "agentMessageAppended",
  agentMessageDelta: "agentMessageDelta",
  agentReasoningHeading: "agentReasoningHeading",
  agentMessagePatch: "agentMessagePatch",
  agentMessageDeleted: "agentMessageDeleted",
  agentMessageStreams: "agentMessageStreams",
  agentWakeStarted: "agentWakeStarted",
  agentContextUsageUpdated: "agentContextUsageUpdated",
  agentWakeFinished: "agentWakeFinished",
  /** A thread was switched to another model, or back to Default. */
  agentThreadModelChanged: "agentThreadModelChanged",
  /** A reply was opened in a thread's right panel, or one of those tabs closed. */
  replyTabsChanged: "replyTabsChanged",
  /** A thread was opened beside the personal agent, or one of those tabs closed. */
  threadTabsChanged: "threadTabsChanged",
  /** A pane was pinned to the Terminals page, or unpinned. */
  terminalPinsChanged: "terminalPinsChanged",
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
  workerPlanUpdated: "workerPlanUpdated",
  /** A worker's task record was written: memory extraction rewrote it when
   *  the worker's window was compacted or archived. */
  workerRecordUpdated: "workerRecordUpdated",
  /** Every active plan, sent when a connection opens and before the projects,
   *  so no worker is drawn without its plan. */
  workerPlans: "workerPlans",
  workItemUpdated: "workItemUpdated",
  /** Every open manager thread, sent when a connection opens, before the plans. */
  managerThreads: "managerThreads",
  managerThreadUpdated: "managerThreadUpdated",
  /** Every open manager thread's state and what waits on the user, sent whole
   *  when a connection opens and whenever any of it changes. */
  threadStatus: "threadStatus",
  /** An archived thread was deleted for good. */
  managerThreadDeleted: "managerThreadDeleted",
  /** A handoff the personal agent made changed state. */
  personalHandoffUpdated: "personalHandoffUpdated",
  /** The personal agent's state, sent when a connection opens. */
  personalAgent: "personalAgent",
  personalAgentUpdated: "personalAgentUpdated",
  /** A background task (a subagent or a command) was started or queued, began, or ended. */
  backgroundTaskChanged: "backgroundTaskChanged",
  /** A running background command's last line, at most every
   *  COMMAND_LIMITS.liveLineMs: not stored, no seq. */
  backgroundTaskOutput: "backgroundTaskOutput",
  /** Personal agent's page: a new version, or a page subagent's write began or ended. */
  agentPageUpdated: "agentPageUpdated",
  /** A page source was run, paused, resumed, removed, or listed anew. */
  agentPageSourceChanged: "agentPageSourceChanged",
  /** The page's scheduled updates, whole, after any of them changed: listed
   *  anew, paused, resumed, removed, or run. */
  agentPageUpdatesChanged: "agentPageUpdatesChanged",
  /** The user gave something on the page. */
  agentPageAnswer: "agentPageAnswer",
  /** What became of a duty thread's reply, recorded when its round ended. */
  dutyReportRecorded: "dutyReportRecorded",
  /** The open side chats, sent when a connection opens; one that changed
   *  (opened, renamed, seen, a new row, working or not); one that ended. */
  sideChats: "sideChats",
  sideChatUpdated: "sideChatUpdated",
  sideChatDeleted: "sideChatDeleted",
  taskBoard: "taskBoard",
  taskBoardTaskUpdated: "taskBoardTaskUpdated",
  taskBoardTaskRemoved: "taskBoardTaskRemoved",
  /** The sticky notes, sent when a connection opens; one that changed (written, seen, done, restored). */
  stickyNotes: "stickyNotes",
  stickyNoteUpdated: "stickyNoteUpdated",
  /** Something on the personal agent's calendar changed: a view fetches its range again. */
  calendarChanged: "calendarChanged",
  /** A notice for some windows to show (as a toast or a system notification). */
  notificationShow: "notificationShow",
  /** A notice was seen or settled: windows close what they show of it. */
  notificationWithdraw: "notificationWithdraw"
} as const;

export type SseEventName = typeof SSE_EVENTS[keyof typeof SSE_EVENTS];
export type LifecycleSseEventName =
  | typeof SSE_EVENTS.projectCreated
  | typeof SSE_EVENTS.projectArchived
  | typeof SSE_EVENTS.projectReordered
  | typeof SSE_EVENTS.projectReconciled
  | typeof SSE_EVENTS.projectUpdated
  | typeof SSE_EVENTS.workerCreated
  | typeof SSE_EVENTS.workerArchived
  | typeof SSE_EVENTS.workerRestored
  | typeof SSE_EVENTS.workerOwnerChanged
  | typeof SSE_EVENTS.paneCreated;

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
  workerId: string | null;
}

export type SseEventPayloadMap = {
  [SSE_EVENTS.error]: AppStateErrorDto;
  [SSE_EVENTS.snapshot]: unknown;
  [SSE_EVENTS.snapshotFull]: SnapshotFullDto;
  [SSE_EVENTS.snapshotPatch]: SnapshotPatchDto;
  [SSE_EVENTS.projectsState]: ProjectStateDto[];
  [SSE_EVENTS.projectCreated]: ProjectDto;
  [SSE_EVENTS.projectArchived]: { id: string };
  [SSE_EVENTS.projectReordered]: { ids: string[] };
  [SSE_EVENTS.projectReconciled]: unknown;
  [SSE_EVENTS.projectUpdated]: ProjectDto;
  [SSE_EVENTS.workerCreated]: WorkerDto;
  [SSE_EVENTS.workerArchived]: { id: string; projectId: string };
  [SSE_EVENTS.workerRestored]: WorkerDto;
  [SSE_EVENTS.workerOwnerChanged]: { id: string; ownerThreadId: string };
  [SSE_EVENTS.paneCreated]: unknown;
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
  /** Messages the owner deleted from a conversation: gone from every page. */
  [SSE_EVENTS.agentMessageDeleted]: { threadId: string; messageIds: string[] };
  /** Authoritative active streams on every connection, including an empty list. */
  [SSE_EVENTS.agentMessageStreams]: { streams: AgentMessageStreamDto[] };
  [SSE_EVENTS.agentWakeStarted]: {
    threadId: string;
    wakeId: string;
    reason: AgentWakeReason;
    triggerMessageId?: string | null;
    /** The wake's own start, so a clock shows how long it has been working. */
    startedAt: string;
    /** Scope of the wake's thread — lets clients map wake activity to a
     *  worker card without a thread lookup. Absent when the thread could not
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
  [SSE_EVENTS.replyTabsChanged]: { threadId: string };
  [SSE_EVENTS.threadTabsChanged]: Record<string, never>;
  [SSE_EVENTS.terminalPinsChanged]: Record<string, never>;
  [SSE_EVENTS.agentWakeModel]: { threadId: string; wakeId: string; model: ModelRefDto };
  [SSE_EVENTS.agentWakeFinished]: {
    threadId: string;
    wakeId: string;
    status: Exclude<AgentWakeStatus, "running">;
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
    /** Whose thread it is ("worker" carries the worker id), for a page that
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
  };
  [SSE_EVENTS.agentCompressionFinished]: {
    threadId: string;
    compressionId: string;
    /** Absent when there was nothing to compact. */
    contextUsage?: AgentContextUsageDto;
  };
  [SSE_EVENTS.agentCompressionFailed]: {
    threadId: string;
    compressionId: string;
    errorMessage: string;
    /** What started the run ("manual" for one a person asked for). */
    reason?: string;
  };
  [SSE_EVENTS.canvasUpdated]: CanvasUpdatedPayload;
  [SSE_EVENTS.workItemCreated]: { item: WorkItemDto };
  [SSE_EVENTS.workerPlanUpdated]: { plan: WorkerPlanDto };
  [SSE_EVENTS.workerRecordUpdated]: { workerId: string };
  [SSE_EVENTS.workerPlans]: { plans: WorkerPlanDto[] };
  [SSE_EVENTS.workItemUpdated]: { item: WorkItemDto };
  [SSE_EVENTS.managerThreads]: { threads: ManagerThreadDto[] };
  [SSE_EVENTS.managerThreadUpdated]: { thread: ManagerThreadDto };
  [SSE_EVENTS.threadStatus]: ThreadStatusSnapshotDto;
  [SSE_EVENTS.managerThreadDeleted]: { threadId: string };
  [SSE_EVENTS.personalHandoffUpdated]: { handoff: PersonalHandoffDto };
  [SSE_EVENTS.personalAgent]: { agent: PersonalAgentDto };
  [SSE_EVENTS.personalAgentUpdated]: { agent: PersonalAgentDto };
  [SSE_EVENTS.backgroundTaskChanged]: { task: BackgroundTaskDto };
  [SSE_EVENTS.backgroundTaskOutput]: { taskId: string; parentThreadId: string; lastLine: string; bytes: number; lines: number };
  [SSE_EVENTS.agentPageUpdated]: { state: AgentPageStateDto };
  /** `data` left out: a run read what the last one did (its value and error). */
  [SSE_EVENTS.agentPageSourceChanged]: { name: string; source: AgentPageSourceDto | null; data?: AgentPageDataDto | null };
  [SSE_EVENTS.agentPageUpdatesChanged]: { updates: AgentPageUpdateDto[] };
  [SSE_EVENTS.agentPageAnswer]: { answer: AgentPageAnswerDto };
  [SSE_EVENTS.dutyReportRecorded]: { threadId: string; messageId: string; outcome: DutyReportOutcome };
  [SSE_EVENTS.sideChats]: SideChatsDto;
  [SSE_EVENTS.sideChatUpdated]: SideChatUpdatedDto;
  [SSE_EVENTS.sideChatDeleted]: SideChatDeletedDto;
  [SSE_EVENTS.taskBoard]: TaskBoardDto;
  [SSE_EVENTS.taskBoardTaskUpdated]: TaskResponse;
  [SSE_EVENTS.taskBoardTaskRemoved]: TaskRemovedDto;
  [SSE_EVENTS.stickyNotes]: StickyNotesDto;
  [SSE_EVENTS.stickyNoteUpdated]: StickyNoteResponse;
  [SSE_EVENTS.calendarChanged]: CalendarChangedEvent;
  [SSE_EVENTS.notificationShow]: NotificationShowEvent;
  [SSE_EVENTS.notificationWithdraw]: NotificationWithdrawEvent;
};

export type SseEvent = {
  [K in SseEventName]: {
    event: K;
    data: SseEventPayloadMap[K];
  }
}[SseEventName];
