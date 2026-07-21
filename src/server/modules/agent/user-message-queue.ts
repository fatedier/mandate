import type {
  AgentScope, AgentStore, AgentWakeReason, AgentMessage, AgentMessageAttachment
} from "./agent-store.js";
import type { AgentMessageSource } from "../../../shared/agent-message-types.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import type { UiLocation } from "../../../shared/ui-context.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import type { WorkItemRefSnapshot } from "../../../shared/api/work-items.js";
import type { WorkItemStore } from "./work-item-store.js";
import { toWorkItemDto } from "./work-item-dto.js";

interface QueuedUserMessage {
  content: string;
  attachments: AgentMessageAttachment[];
  source: AgentMessageSource;
  sourceThreadId: string | null;
  pendingTaskWakeOnFlush: boolean;
  clientRequestId?: string | null;
  clientId?: string | null;
  uiLocation?: UiLocation | null;
  workItemRef?: WorkItemRefSnapshot | null;
}

interface UserMessageQueueDeps {
  agentStore: AgentStore;
  sse?: Pick<AgentSseEmitter, "emit">;
  workStore?: Pick<WorkItemStore, "getByFeature" | "update">;
  wakeScheduler: {
    wake: (threadId: string, reason: AgentWakeReason, triggerMessageId: string | null) => string | null;
    isThreadBusy?: (threadId: string) => boolean;
    getRunningWakeForThread?: (threadId: string) => unknown;
  };
  onPendingTaskMessageFlushed?: (threadId: string, message: AgentMessage) => void;
}

interface SubmitUserMessageInput {
  scope: AgentScope;
  scopeId: string | null;
  content: string;
  attachments?: AgentMessageAttachment[];
  clientRequestId?: string | null;
  clientId?: string | null;
  uiLocation?: UiLocation | null;
  workItemRef?: WorkItemRefSnapshot | null;
}

interface SubmitThreadUserMessageInput {
  threadId: string;
  content: string;
  source: AgentMessageSource;
  sourceThreadId?: string | null;
  attachments?: AgentMessageAttachment[];
  clientRequestId?: string | null;
  clientId?: string | null;
  uiLocation?: UiLocation | null;
  workItemRef?: WorkItemRefSnapshot | null;
  pendingTaskWakeOnFlush?: boolean;
  queueWhenBusy?: boolean;
}

export interface SubmitUserMessageResult {
  threadId: string;
  messageId: string | null;
  wakeId: string | null;
  queued: boolean;
  queuedReason?: "running_wake";
}

export class AgentUserMessageQueue {
  private readonly pendingByThread = new Map<string, QueuedUserMessage[]>();

  constructor(private readonly deps: UserMessageQueueDeps) {}

  submitUserMessage(input: SubmitUserMessageInput): SubmitUserMessageResult {
    const thread = this.deps.agentStore.getOrCreateThread(input.scope, input.scopeId);
    this.clearStaleFeatureReview(input.scope, input.scopeId);
    return this.submitThreadUserMessage({
      threadId: thread.id,
      content: input.content,
      source: "user",
      sourceThreadId: null,
      attachments: input.attachments,
      clientRequestId: input.clientRequestId,
      clientId: input.clientId,
      uiLocation: input.uiLocation,
      workItemRef: input.workItemRef
    });
  }

  submitThreadUserMessage(input: SubmitThreadUserMessageInput): SubmitUserMessageResult {
    const queued: QueuedUserMessage = {
      content: input.content,
      attachments: input.attachments ?? [],
      source: input.source,
      sourceThreadId: input.sourceThreadId ?? null,
      pendingTaskWakeOnFlush: Boolean(input.pendingTaskWakeOnFlush),
      clientRequestId: normalizeClientRequestId(input.clientRequestId),
      clientId: normalizeClientRequestId(input.clientId),
      uiLocation: input.uiLocation ?? null,
      workItemRef: input.workItemRef ?? null
    };

    const queuedReason = this.queuedReason(input.threadId);
    if (queuedReason) {
      if (input.queueWhenBusy !== false) this.enqueue(input.threadId, queued);
      return { threadId: input.threadId, messageId: null, wakeId: null, queued: true, queuedReason };
    }

    const message = this.appendAndBroadcast(input.threadId, queued);
    const wakeId = this.deps.wakeScheduler.wake(input.threadId, "user", message.id);
    return { threadId: input.threadId, messageId: message.id, wakeId, queued: false };
  }

  flushIfIdle(threadId: string): string | null {
    if (this.isBusy(threadId)) return null;
    const flushed = this.drainQueuedIntoThread(threadId);
    const lastMessage = flushed.at(-1)?.message ?? null;
    if (!lastMessage) return null;
    return this.deps.wakeScheduler.wake(threadId, "user", lastMessage.id);
  }

  flushQueuedIntoThread(threadId: string): AgentMessage[] {
    const flushed = this.drainQueuedIntoThread(threadId);
    for (const item of flushed) {
      if (item.pendingTaskWakeOnFlush) {
        this.deps.onPendingTaskMessageFlushed?.(threadId, item.message);
      }
    }
    return flushed.map((item) => item.message);
  }

  isFlushBlocked(threadId: string): boolean {
    return this.isBusy(threadId);
  }

  private drainQueuedIntoThread(threadId: string): Array<{
    message: AgentMessage;
    pendingTaskWakeOnFlush: boolean;
  }> {
    const queued = this.pendingByThread.get(threadId);
    if (!queued || queued.length === 0) return [];
    this.pendingByThread.delete(threadId);
    return queued.map((item) => ({
      message: this.appendAndBroadcast(threadId, item),
      pendingTaskWakeOnFlush: item.pendingTaskWakeOnFlush
    }));
  }

  pendingCount(threadId: string): number {
    return this.pendingByThread.get(threadId)?.length ?? 0;
  }

  removeQueuedMessage(threadId: string, clientRequestId: string): boolean {
    const normalized = normalizeClientRequestId(clientRequestId);
    if (!normalized) return false;
    const pending = this.pendingByThread.get(threadId);
    if (!pending || pending.length === 0) return false;
    const next = pending.filter((message) => message.clientRequestId !== normalized);
    if (next.length === pending.length) return false;
    if (next.length === 0) this.pendingByThread.delete(threadId);
    else this.pendingByThread.set(threadId, next);
    return true;
  }

  clearThread(threadId: string): number {
    const count = this.pendingByThread.get(threadId)?.length ?? 0;
    this.pendingByThread.delete(threadId);
    return count;
  }

  private enqueue(threadId: string, message: QueuedUserMessage): void {
    const pending = this.pendingByThread.get(threadId) ?? [];
    pending.push(message);
    this.pendingByThread.set(threadId, pending);
  }

  private isBusy(threadId: string): boolean {
    return this.queuedReason(threadId) !== null;
  }

  private queuedReason(threadId: string): "running_wake" | null {
    if (this.deps.wakeScheduler.getRunningWakeForThread?.(threadId)) return "running_wake";
    if (this.deps.wakeScheduler.isThreadBusy?.(threadId)) return "running_wake";
    return null;
  }

  private appendAndBroadcast(threadId: string, queued: QueuedUserMessage): AgentMessage {
    const message = this.deps.agentStore.appendMessage({
      threadId,
      role: "user",
      source: queued.source,
      sourceThreadId: queued.sourceThreadId,
      content: {
        type: "text",
        text: queued.content,
        ...(queued.attachments.length > 0 ? { attachments: queued.attachments } : {}),
        ...(queued.clientRequestId ? { clientRequestId: queued.clientRequestId } : {}),
        ...(queued.clientId ? { clientId: queued.clientId } : {}),
        ...(queued.uiLocation ? { uiLocation: queued.uiLocation } : {}),
        ...(queued.workItemRef ? { metadata: { workItemRef: queued.workItemRef } } : {})
      }
    });
    this.deps.sse?.emit(SSE_EVENTS.agentMessageAppended, { threadId, message });
    return message;
  }

  private clearStaleFeatureReview(scope: AgentScope, scopeId: string | null): void {
    if (scope !== "worker" || !scopeId || !this.deps.workStore) return;
    const item = this.deps.workStore.getByFeature(scopeId);
    if (!item || item.needsUser !== "review") return;
    const next = this.deps.workStore.update(item.id, { needsUser: null });
    if (next) this.deps.sse?.emit(SSE_EVENTS.workItemUpdated, { item: toWorkItemDto(next) });
  }
}

function normalizeClientRequestId(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}
