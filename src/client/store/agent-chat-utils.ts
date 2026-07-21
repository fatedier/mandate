import type { AgentMessage } from "./agent-chat";
import type { AgentChatScope, PendingMessage, ThreadState } from "./agent-chat";
import type { AgentWakeMetadata, AgentWakeReason } from "@shared/api-contracts";

const MAX_MESSAGES_PER_THREAD = 500;

export function scopeKey(scope: AgentChatScope): string {
  if (scope.type === "manager") return "manager";
  return `worker:${scope.featureId}`;
}

export function scopeFromKey(key: string): AgentChatScope | null {
  if (key === "manager") return { type: "manager" };
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
    unreadAssistantCount: 0,
    lastWakeError: null
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
    incrementUnread?: boolean;
  }
): ThreadState {
  if (thread.messages.some((existing) => existing.id === message.id)) {
    return thread;
  }

  let pendingUserMessages = thread.pendingUserMessages;
  let streamingAssistant = thread.streamingAssistant;
  let wakePhase = thread.wakePhase;
  let unreadAssistantCount = thread.unreadAssistantCount;

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
    (message.content.toolCalls?.length ?? 0) === 0
  ) {
    wakePhase = { wakeId: message.wakeId, phase: "idle" };
  }
  if (message.role === "assistant" && options.incrementUnread) {
    unreadAssistantCount += 1;
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
    unreadAssistantCount,
    streamingAssistant,
    wakePhase,
    ...oldestLoadedAfterAppend(thread, messages)
  };
}

function pendingMatchesMessage(
  localId: string,
  pending: PendingMessage,
  message: AgentMessage
): boolean {
  if (pending.messageId === message.id) return true;
  return message.content.type === "text" && message.content.clientRequestId === localId;
}
