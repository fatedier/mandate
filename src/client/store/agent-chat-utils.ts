import type { AgentMessage } from "./agent-chat";
import type { ChatThreadScope, PendingMessage, ThreadState } from "./agent-chat-types";
import type { AgentActiveWakeDto, AgentMonitorsRevision, AgentPendingMonitorDto, AgentWakeMetadata, AgentWakeReason } from "@shared/api-contracts";

const MAX_MESSAGES_PER_THREAD = 500;

export function scopeKey(scope: ChatThreadScope): string {
  return scope.type === "worker" ? `worker:${scope.featureId}` : `${scope.type}:${scope.threadId}`;
}

export function scopeFromKey(key: string): ChatThreadScope | null {
  if (key.startsWith("manager:")) return { type: "manager", threadId: key.slice("manager:".length) };
  if (key.startsWith("global:")) return { type: "global", threadId: key.slice("global:".length) };
  if (key.startsWith("subagent:")) return { type: "subagent", threadId: key.slice("subagent:".length) };
  if (key.startsWith("worker:")) {
    return { type: "worker", featureId: key.slice("worker:".length) };
  }
  return null;
}

export function newThreadState(): ThreadState {
  return {
    threadId: null,
    messages: [],
    oldestSeqLoaded: null,
    hasMoreOlder: false,
    streamingAssistant: null,
    wakeReasonsById: new Map(),
    wakeMetadataById: new Map(),
    wakePhase: { wakeId: null, phase: "idle" },
    compressionPhase: null,
    pendingUserMessages: new Map(),
    contextUsage: null,
    monitors: [],
    monitorsRevision: null,
    loaded: false
  };
}

export function mergeWakeReasons(
  current: Map<string, AgentWakeReason>,
  messages: AgentMessage[]
): Map<string, AgentWakeReason> {
  let next = current;
  for (const message of messages) {
    if (!message.wakeId || !message.wakeReason) continue;
    if (next.get(message.wakeId) === message.wakeReason) continue;
    if (next === current) next = new Map(current);
    next.set(message.wakeId, message.wakeReason);
  }
  return next;
}

export function withWakeReason(
  current: Map<string, AgentWakeReason>,
  wakeId: string,
  reason: AgentWakeReason
): Map<string, AgentWakeReason> {
  if (current.get(wakeId) === reason) return current;
  const next = new Map(current);
  next.set(wakeId, reason);
  return next;
}

export function mergeWakeMetadata(
  current: Map<string, AgentWakeMetadata>,
  messages: AgentMessage[]
): Map<string, AgentWakeMetadata> {
  let next = current;
  for (const message of messages) {
    if (!message.wakeId || !message.wakeMetadata) continue;
    if (next.get(message.wakeId) === message.wakeMetadata) continue;
    if (next === current) next = new Map(current);
    next.set(message.wakeId, message.wakeMetadata);
  }
  return next;
}

export function withWakeMetadata(
  current: Map<string, AgentWakeMetadata>,
  wakeId: string,
  metadata?: AgentWakeMetadata | null
): Map<string, AgentWakeMetadata> {
  if (!metadata) return current;
  if (current.get(wakeId) === metadata) return current;
  const next = new Map(current);
  next.set(wakeId, metadata);
  return next;
}

export function genLocalId(): string {
  return `local-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
}

export function lastSeq(thread: ThreadState): number {
  return thread.messages.length > 0 ? thread.messages[thread.messages.length - 1]!.seq : 0;
}

export function compareTimelineMessages(a: AgentMessage, b: AgentMessage): number {
  return a.seq - b.seq || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

export function mergeMessages(existing: AgentMessage[], incoming: AgentMessage[]): AgentMessage[] {
  const byId = new Map<string, AgentMessage>();
  for (const message of existing) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, message);
  return trimToRecentWindow([...byId.values()]);
}

function trimToRecentWindow(messages: AgentMessage[]): AgentMessage[] {
  const sorted = [...messages].sort(compareTimelineMessages);
  return sorted.length > MAX_MESSAGES_PER_THREAD
    ? sorted.slice(sorted.length - MAX_MESSAGES_PER_THREAD)
    : sorted;
}

function oldestLoadedAfterAppend(
  thread: ThreadState,
  messages: AgentMessage[]
): {
  oldestSeqLoaded: number | null;
  hasMoreOlder: boolean;
} {
  const previousOldest = thread.oldestSeqLoaded ?? thread.messages[0]?.seq ?? null;
  const oldestSeqLoaded = messages[0]?.seq ?? null;
  const trimmedOlder =
    previousOldest !== null && oldestSeqLoaded !== null && oldestSeqLoaded > previousOldest;
  return {
    oldestSeqLoaded,
    hasMoreOlder: thread.hasMoreOlder || trimmedOlder
  };
}

export function reconcilePendingWithMessages(
  pending: Map<string, PendingMessage>,
  messages: AgentMessage[]
): Map<string, PendingMessage> {
  let next = pending;
  for (const message of messages) {
    if (message.role !== "user") continue;
    let foundLocalId: string | null = null;
    for (const [localId, item] of next) {
      if (pendingMatchesMessage(localId, item, message)) {
        foundLocalId = localId;
        break;
      }
    }
    if (foundLocalId !== null) {
      if (next === pending) next = new Map(pending);
      next.delete(foundLocalId);
    }
  }
  return next;
}

export function appendMessageToThread(
  thread: ThreadState,
  message: AgentMessage,
  options: {
    trimMessages: boolean;
  }
): ThreadState {
  if (thread.messages.some((existing) => existing.id === message.id)) {
    return thread;
  }

  let pendingUserMessages = thread.pendingUserMessages;
  let streamingAssistant = thread.streamingAssistant;
  let wakePhase = thread.wakePhase;

  if (message.role === "user") {
    let foundLocalId: string | null = null;
    for (const [localId, pending] of pendingUserMessages) {
      if (pendingMatchesMessage(localId, pending, message)) {
        foundLocalId = localId;
        break;
      }
    }
    if (foundLocalId !== null) {
      pendingUserMessages = new Map(pendingUserMessages);
      pendingUserMessages.delete(foundLocalId);
    }
  }

  if (message.role === "assistant" && streamingAssistant?.wakeId === message.wakeId) {
    streamingAssistant = null;
  }
  if (
    message.role === "assistant" &&
    message.wakeId &&
    wakePhase.wakeId === message.wakeId &&
    message.content.type === "assistant" &&
    (message.content.toolCalls?.length ?? 0) === 0 &&
    message.content.endTurn !== false
  ) {
    wakePhase = { ...wakePhase, phase: "idle" };
  }

  const messages = options.trimMessages
    ? trimToRecentWindow([...thread.messages, message])
    : [...thread.messages, message].sort(compareTimelineMessages);

  return {
    ...thread,
    messages,
    pendingUserMessages,
    wakeReasonsById: mergeWakeReasons(thread.wakeReasonsById, [message]),
    wakeMetadataById: mergeWakeMetadata(thread.wakeMetadataById, [message]),
    streamingAssistant,
    wakePhase,
    ...oldestLoadedAfterAppend(thread, messages)
  };
}

/** Whether a stored message is the one a pending stand-in was sent as. */
export function pendingMatchesMessage(
  localId: string,
  pending: PendingMessage,
  message: AgentMessage
): boolean {
  if (pending.messageId === message.id) return true;
  return message.content.type === "text" && message.content.clientRequestId === localId;
}

/** What a read of a thread's page says its agent waits on, and the revision
 *  that is current as of. Null monitors: the read did not say. */
interface MonitorsRead {
  monitors: AgentPendingMonitorDto[] | null;
  monitorsRevision: AgentMonitorsRevision | null;
}

/** Whether a pending-monitor revision is older than another: an earlier boot,
 *  or fewer changes within the same one. */
export function monitorsRevisionBefore(a: AgentMonitorsRevision, b: AgentMonitorsRevision): boolean {
  return a.boot < b.boot || (a.boot === b.boot && a.seq < b.seq);
}

/** Take a read's pending monitors unless the store holds a later revision
 *  (agentMonitorsChanged sent after the read). Equal revisions are the same
 *  set. */
export function reconcileMonitorsRead(thread: ThreadState, read: MonitorsRead): ThreadState {
  if (!read.monitors) return thread;
  const held = thread.monitorsRevision;
  if (held !== null && (read.monitorsRevision === null || monitorsRevisionBefore(read.monitorsRevision, held))) return thread;
  return { ...thread, monitors: read.monitors, monitorsRevision: read.monitorsRevision };
}

/** What a read of a thread's page says of its wakes, on the server's clock. */
interface WakeRead {
  activeWake: AgentActiveWakeDto | null;
  /** A compaction started by hand is in flight; absent from a read that does not say. */
  compacting?: boolean;
  readAt: string | null;
}

/** Bring the store's wake phase up to what a page read found. Wakes on a thread
 *  run one at a time and every start is on the server's clock, so starts order
 *  them: the read's running wake is taken unless the store holds one that began
 *  later (the read is older), and a read that found nothing running ends a wake
 *  that began before the read. What the store saw finish stays finished. */
export function reconcileWakeRead(thread: ThreadState, read: WakeRead): ThreadState {
  return endMissedCompaction(reconcileWakePhase(thread, read), read);
}

/** A compaction leaves the store by its finished or failed event, and one
 *  missed (the page asleep for the minute it takes, the stream down) would
 *  leave the thread compacting for good. A read that found nothing holding
 *  the thread, no wake and no compaction started by hand, ends one that
 *  began before the read. */
function endMissedCompaction(thread: ThreadState, read: WakeRead): ThreadState {
  const phase = thread.compressionPhase;
  if (!phase || read.activeWake || read.compacting !== false || !read.readAt || phase.startedAt >= read.readAt) return thread;
  return { ...thread, compressionPhase: null };
}

function reconcileWakePhase(thread: ThreadState, read: WakeRead): ThreadState {
  const current = thread.wakePhase;
  const currentStart = current.startedAt ??
    thread.messages.find((message) => message.wakeId === current.wakeId && message.wakeStartedAt)?.wakeStartedAt;
  const active = read.activeWake;
  if (!active) {
    const endedBeforeRead = current.phase !== "idle" && currentStart && read.readAt && currentStart < read.readAt;
    return endedBeforeRead ? { ...thread, wakePhase: { ...current, phase: "idle" } } : thread;
  }
  if (current.wakeId === active.wakeId) {
    if (current.phase === "idle" || current.startedAt) return thread;
    return { ...thread, wakePhase: { ...current, startedAt: active.startedAt } };
  }
  if (currentStart && currentStart >= active.startedAt) return thread;
  return { ...thread, wakePhase: { wakeId: active.wakeId, phase: "thinking", startedAt: active.startedAt } };
}
