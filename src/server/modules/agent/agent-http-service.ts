import type { AgentScope, AgentStore, AgentWakeReason } from "./agent-store.js";
import type { AgentUserMessageQueue } from "./user-message-queue.js";
import type { ScopeRuntime } from "../../runtime/scope.js";
import { normalizeClientId, parseUiLocation } from "../ui-context/ui-context-registry.js";
import type { UiContextRegistry } from "../ui-context/ui-context-registry.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import type { AgentMessageAttachment, ModelInputType } from "../../../shared/agent-message-types.js";
import type { WorkItemRefSnapshot } from "../../../shared/api/work-items.js";
import type { WorkItemStore } from "./work-item-store.js";
import { toAgentClientMessage } from "./agent-message-dto.js";

export interface AgentsApiDeps {
  agentStore: AgentStore;
  wakeScheduler: {
    wake: (threadId: string, reason: AgentWakeReason, triggerMessageId: string | null) => string | null;
    cancelWake?: (wakeId: string) => { ok: boolean; wakeId: string; status: string; message?: string };
    isThreadBusy?: (threadId: string) => boolean;
    getRunningWakeForThread?: (threadId: string) => { id: string } | null;
  };
  beforeNewChatArchive?: (threadId: string) => void;
  beforeSideThreadClose?: (threadId: string) => void;
  summarizeSideConversation?: (threadId: string) => Promise<string>;
  userMessageQueue?: Pick<
    AgentUserMessageQueue,
    "submitUserMessage" | "submitThreadUserMessage" | "removeQueuedMessage" | "clearThread"
  >;
  /** Optional SSE emitter — when provided, user messages are broadcast like
   *  assistant ones (so all connected clients see the message in seq order
   *  rather than only the sender's pending-messages). */
  sse?: Pick<AgentSseEmitter, "emit">;
  /** Per-scope runtimes from buildAgentRuntime — provides verifyScopeId for
   *  the route gate. The HTTP layer never reaches into scope internals; it
   *  just asks "is this scope-id valid?" before delegating. */
  scopes: Record<AgentScope, ScopeRuntime>;
  /** Current per-scope model capability check. When omitted (tests/minimal
   *  embedders), image input is accepted and the LLM layer decides. */
  modelSupportsInput?: (scope: AgentScope, input: ModelInputType) => boolean;
  /** Compression threshold used as the current agent context-budget denominator. */
  contextBudgetTokens?: number;
  uiContextRegistry?: Pick<UiContextRegistry, "updateThreadLocation" | "associateThread">;
  /** Optional work item lookup used to enrich UI references before they reach the model. */
  workStore?: Pick<WorkItemStore, "get">;
}

type AgentHttpStatus = 200 | 202 | 400 | 404 | 409 | 500;

export interface AgentHttpResult<T = unknown> {
  status: AgentHttpStatus;
  body: T;
}

export class AgentHttpService {
  constructor(private readonly deps: AgentsApiDeps) {}

  postMessage(input: { scope: AgentScope; scopeId: string | null; body: unknown }): AgentHttpResult {
    const verifyError = this.verifyScope(input.scope, input.scopeId);
    if (verifyError) return json({ error: verifyError }, 404);

    const body = input.body;
    const content = String(isRecord(body) ? body.content ?? "" : "").trim();
    const parsedAttachments = parseImageAttachments(isRecord(body) ? body.attachments : undefined);
    if ("error" in parsedAttachments) return json({ error: parsedAttachments.error }, 400);
    const attachments = parsedAttachments.attachments;
    if (!content && attachments.length === 0) return json({ error: "content or image attachment is required" }, 400);
    if (
      attachments.length > 0 &&
      this.deps.modelSupportsInput &&
      !this.deps.modelSupportsInput(input.scope, "image")
    ) {
      return json({ error: "current agent model does not support image input" }, 400);
    }

    const clientRequestId = isRecord(body) && typeof body.clientRequestId === "string"
      ? body.clientRequestId
      : null;
    const uiLocation = isRecord(body) ? parseUiLocation(body.uiLocation) : null;
    const clientId = normalizeClientId(isRecord(body) ? body.clientId : null) ?? uiLocation?.clientId ?? null;
    const workItemRef = this.resolveWorkItemRef(parseWorkItemRef(isRecord(body) ? body.workItemRef : undefined));

    const thread = this.deps.agentStore.getOrCreateThread(input.scope, input.scopeId);
    if (uiLocation) this.deps.uiContextRegistry?.updateThreadLocation(thread.id, uiLocation);
    else this.deps.uiContextRegistry?.associateThread(thread.id, clientId);

    if (this.deps.userMessageQueue) {
      const result = this.deps.userMessageQueue.submitUserMessage({
        scope: input.scope,
        scopeId: input.scopeId,
        content,
        attachments,
        clientRequestId,
        clientId,
        uiLocation,
        workItemRef
      });
      return json(result, 202);
    }

    const message = this.deps.agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: {
        type: "text",
        text: content,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(clientRequestId ? { clientRequestId } : {}),
        ...(clientId ? { clientId } : {}),
        ...(uiLocation ? { uiLocation } : {}),
        ...(workItemRef ? { metadata: { workItemRef } } : {})
      }
    });
    // Broadcast the user message so all connected clients see it in seq order
    // rather than rendering it after the agent reply when the wake completes.
    this.deps.sse?.emit(SSE_EVENTS.agentMessageAppended, { threadId: thread.id, message });
    const wakeId = this.deps.wakeScheduler.wake(thread.id, "user", message.id);
    return json({ threadId: thread.id, messageId: message.id, wakeId }, 202);
  }

  postThreadMessage(input: { threadId: string; body: unknown }): AgentHttpResult {
    const thread = this.deps.agentStore.getThreadById(input.threadId);
    if (!thread || thread.kind !== "side" || thread.closedAt) {
      return json({ error: "open side conversation not found" }, 404);
    }
    const parsed = this.parseMessageInput(thread.scope, input.body);
    if ("error" in parsed) return json({ error: parsed.error }, 400);
    if (parsed.uiLocation) this.deps.uiContextRegistry?.updateThreadLocation(thread.id, parsed.uiLocation);
    else this.deps.uiContextRegistry?.associateThread(thread.id, parsed.clientId);

    if (this.deps.userMessageQueue) {
      return json(this.deps.userMessageQueue.submitThreadUserMessage({
        threadId: thread.id,
        content: parsed.content,
        attachments: parsed.attachments,
        source: "user",
        sourceThreadId: null,
        clientRequestId: parsed.clientRequestId,
        clientId: parsed.clientId,
        uiLocation: parsed.uiLocation,
        workItemRef: parsed.workItemRef
      }), 202);
    }

    const message = this.deps.agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "user",
      content: {
        type: "text",
        text: parsed.content,
        ...(parsed.attachments.length > 0 ? { attachments: parsed.attachments } : {}),
        ...(parsed.clientRequestId ? { clientRequestId: parsed.clientRequestId } : {})
      }
    });
    this.deps.sse?.emit(SSE_EVENTS.agentMessageAppended, { threadId: thread.id, message });
    const wakeId = this.deps.wakeScheduler.wake(thread.id, "user", message.id);
    return json({ threadId: thread.id, messageId: message.id, wakeId }, 202);
  }

  createSideThread(parentThreadId: string): AgentHttpResult {
    const parent = this.deps.agentStore.getThreadById(parentThreadId);
    if (!parent || parent.kind !== "main" || parent.archivedAt) {
      return json({ error: "active main thread not found" }, 404);
    }
    try {
      const thread = this.deps.agentStore.createSideThread(parentThreadId);
      return json({ thread, parentThread: parent });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  }

  getThreadById(input: {
    threadId: string;
    since?: string;
    limit?: string;
    before?: string;
  }): AgentHttpResult {
    const thread = this.deps.agentStore.getThreadById(input.threadId);
    if (!thread || (thread.kind === "side" && thread.closedAt)) {
      return json({ error: "thread not found" }, 404);
    }
    const since = optionalNumber(input.since);
    const limit = positiveInt(input.limit, 100);
    const before = optionalNumber(input.before);
    const messages = since !== undefined
      ? this.deps.agentStore.getMessagesSince(thread.id, since)
      : this.deps.agentStore.getMessagesPage(thread.id, {
          limit: limit + 1,
          beforeSeq: before
        });
    const hasMore = since === undefined && messages.length > limit;
    return json({
      thread,
      messages: (since === undefined ? messages.slice(0, limit).reverse() : messages).map(toAgentClientMessage),
      hasMore,
      contextUsage: this.contextUsageForThread(thread.id)
    });
  }

  closeSideThread(threadId: string): AgentHttpResult {
    const thread = this.deps.agentStore.getThreadById(threadId);
    if (!thread || thread.kind !== "side") return json({ error: "side conversation not found" }, 404);
    const running = this.deps.wakeScheduler.getRunningWakeForThread?.(threadId);
    if (running && this.deps.wakeScheduler.cancelWake) {
      this.deps.wakeScheduler.cancelWake(running.id);
    }
    this.deps.userMessageQueue?.clearThread(threadId);
    this.deps.beforeSideThreadClose?.(threadId);
    const closed = this.deps.agentStore.closeSideThread(threadId);
    return json({ ok: true, thread: closed });
  }

  async getSideSummaryDraft(threadId: string): Promise<AgentHttpResult> {
    const thread = this.deps.agentStore.getThreadById(threadId);
    if (!thread || thread.kind !== "side" || thread.closedAt) {
      return json({ error: "open side conversation not found" }, 404);
    }
    const messages = this.deps.agentStore.getMessages(threadId);
    const assistantTexts = messages.flatMap((message) =>
      message.role === "assistant" && message.content.type === "assistant" && message.content.text?.trim()
        ? [message.content.text.trim()]
        : []
    );
    const fallback = messages.flatMap((message) =>
      message.role === "user" && message.content.type === "text" && message.content.text.trim()
        ? [message.content.text.trim()]
        : []
    );
    try {
      const generated = this.deps.summarizeSideConversation
        ? await this.deps.summarizeSideConversation(threadId)
        : assistantTexts.at(-1) ?? fallback.at(-1) ?? "";
      return json({ content: generated.trim().slice(0, 12_000) });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  createSideTransfer(input: { threadId: string; body: unknown }): AgentHttpResult {
    if (!isRecord(input.body)) return json({ error: "invalid body" }, 400);
    const content = typeof input.body.content === "string" ? input.body.content.trim() : "";
    const clientRequestId = typeof input.body.clientRequestId === "string"
      ? input.body.clientRequestId.trim()
      : "";
    if (!content) return json({ error: "summary content is required" }, 400);
    if (!clientRequestId) return json({ error: "clientRequestId is required" }, 400);
    try {
      const transfer = this.deps.agentStore.createSideTransfer({
        sourceThreadId: input.threadId,
        clientRequestId,
        content
      });
      return json(this.tryDeliverSideTransfer(transfer.id), 202);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  }

  retargetSideTransfer(input: { transferId: string; body: unknown }): AgentHttpResult {
    const targetThreadId = isRecord(input.body) && typeof input.body.targetThreadId === "string"
      ? input.body.targetThreadId.trim()
      : "";
    if (!targetThreadId) return json({ error: "targetThreadId is required" }, 400);
    const transfer = this.deps.agentStore.retargetSideTransfer(input.transferId, targetThreadId);
    if (!transfer) return json({ error: "transfer or active target thread not found" }, 404);
    return json(this.tryDeliverSideTransfer(transfer.id), 202);
  }

  private tryDeliverSideTransfer(transferId: string): {
    transfer: ReturnType<AgentStore["getSideTransferById"]>;
    wakeId?: string | null;
  } {
    const transfer = this.deps.agentStore.getSideTransferById(transferId);
    if (!transfer || transfer.status !== "pending") return { transfer };
    if (this.deps.wakeScheduler.isThreadBusy?.(transfer.targetThreadId)) {
      this.deps.sse?.emit(SSE_EVENTS.agentSideTransferUpdated, transfer);
      return { transfer };
    }
    const delivered = this.deps.agentStore.deliverSideTransfer(transfer.id);
    if (!delivered) {
      const updated = this.deps.agentStore.getSideTransferById(transfer.id);
      if (updated) this.deps.sse?.emit(SSE_EVENTS.agentSideTransferUpdated, updated);
      return { transfer: updated };
    }
    this.deps.sse?.emit(SSE_EVENTS.agentSideTransferUpdated, delivered.transfer);
    this.deps.sse?.emit(SSE_EVENTS.agentMessageAppended, {
      threadId: delivered.message.threadId,
      message: delivered.message
    });
    const wakeId = this.deps.wakeScheduler.wake(
      delivered.message.threadId,
      "side-summary",
      delivered.message.id
    );
    return { transfer: delivered.transfer, wakeId };
  }

  private parseMessageInput(scope: AgentScope, body: unknown): ParsedMessageInput | { error: string } {
    const content = String(isRecord(body) ? body.content ?? "" : "").trim();
    const parsedAttachments = parseImageAttachments(isRecord(body) ? body.attachments : undefined);
    if ("error" in parsedAttachments) return parsedAttachments;
    if (!content && parsedAttachments.attachments.length === 0) {
      return { error: "content or image attachment is required" };
    }
    if (
      parsedAttachments.attachments.length > 0
      && this.deps.modelSupportsInput
      && !this.deps.modelSupportsInput(scope, "image")
    ) return { error: "current agent model does not support image input" };
    const clientRequestId = isRecord(body) && typeof body.clientRequestId === "string"
      ? body.clientRequestId
      : null;
    const uiLocation = isRecord(body) ? parseUiLocation(body.uiLocation) : null;
    const clientId = normalizeClientId(isRecord(body) ? body.clientId : null) ?? uiLocation?.clientId ?? null;
    return {
      content,
      attachments: parsedAttachments.attachments,
      clientRequestId,
      clientId,
      uiLocation,
      workItemRef: this.resolveWorkItemRef(parseWorkItemRef(isRecord(body) ? body.workItemRef : undefined))
    };
  }

  private resolveWorkItemRef(ref: Pick<WorkItemRefSnapshot, "itemId" | "snapshotAt"> | undefined): WorkItemRefSnapshot | undefined {
    if (!ref) return undefined;
    const item = this.deps.workStore?.get(ref.itemId);
    if (!item) return ref;
    return {
      itemId: item.id,
      snapshotAt: ref.snapshotAt,
      title: item.title,
      summary: item.summary,
      projectId: item.projectId,
      featureId: item.featureId,
      needsUser: item.needsUser,
      phase: item.phase,
      phaseDetail: item.phaseDetail
    };
  }

  deleteQueuedMessage(input: {
    scope: AgentScope;
    scopeId: string | null;
    clientRequestId: string;
  }): AgentHttpResult {
    const verifyError = this.verifyScope(input.scope, input.scopeId);
    if (verifyError) return json({ error: verifyError }, 404);
    if (!this.deps.userMessageQueue) {
      return json({ error: "queued message deletion is not available" }, 400);
    }

    const thread = this.deps.agentStore.getThreadByScope(input.scope, input.scopeId);
    const removed = thread
      ? this.deps.userMessageQueue.removeQueuedMessage(thread.id, input.clientRequestId)
      : false;
    return json({ ok: true, removed });
  }

  deleteThreadQueuedMessage(threadId: string, clientRequestId: string): AgentHttpResult {
    const thread = this.deps.agentStore.getThreadById(threadId);
    if (!thread || thread.kind !== "side" || thread.closedAt) {
      return json({ error: "open side conversation not found" }, 404);
    }
    if (!this.deps.userMessageQueue) {
      return json({ error: "queued message deletion is not available" }, 400);
    }
    return json({
      ok: true,
      removed: this.deps.userMessageQueue.removeQueuedMessage(threadId, clientRequestId)
    });
  }

  getThread(input: {
    scope: AgentScope;
    scopeId: string | null;
    since?: string;
    limit?: string;
    before?: string;
  }): AgentHttpResult {
    const scopeRuntime = this.deps.scopes[input.scope];
    if (input.scope === "worker") {
      const verifyError = scopeRuntime.verifyScopeId(input.scopeId);
      if (verifyError) return json({ error: verifyError }, 404);
    } else {
      this.deps.agentStore.getOrCreateThread(input.scope, input.scopeId);
    }

    const thread = this.deps.agentStore.getThreadByScope(input.scope, input.scopeId);
    if (!thread) return json({ thread: null, messages: [] });

    const since = optionalNumber(input.since);
    const limit = positiveInt(input.limit, 100);
    const before = optionalNumber(input.before);

    if (since !== undefined) {
      const messages = this.deps.agentStore.getMessagesSince(thread.id, since);
      return json({
        thread,
        messages: messages.map(toAgentClientMessage),
        hasMore: false,
        contextUsage: this.contextUsageForThread(thread.id)
      });
    }

    const page = this.deps.agentStore.getMessagesPage(thread.id, {
      limit: limit + 1,
      beforeSeq: before
    });
    const hasMore = page.length > limit;
    const messages = page.slice(0, limit).reverse();
    return json({
      thread,
      messages: messages.map(toAgentClientMessage),
      hasMore,
      contextUsage: this.contextUsageForThread(thread.id)
    });
  }

  async startNewChat(input: { scope: AgentScope; scopeId: string | null }): Promise<AgentHttpResult> {
    const verifyError = this.verifyScope(input.scope, input.scopeId);
    if (verifyError) return json({ error: verifyError }, 404);

    const old = this.deps.agentStore.getThreadByScope(input.scope, input.scopeId);
    if (old) {
      this.deps.beforeNewChatArchive?.(old.id);
      this.deps.agentStore.archiveThread(old.id);
    }
    const fresh = this.deps.agentStore.getOrCreateThread(input.scope, input.scopeId);
    return json({ ok: true, oldThreadId: old?.id ?? null, newThreadId: fresh.id });
  }

  getWake(wakeId: string): AgentHttpResult {
    const wake = this.deps.agentStore.getWakeById(wakeId);
    if (!wake) return json({ error: "wake not found" }, 404);
    const messageIds = this.deps.agentStore.getMessageIdsForWake(wakeId);
    return json({ ...wake, messageIds });
  }

  /** GET /api/agents/active-wakes — every running wake with its thread's
   *  scope, so clients can rebuild live-activity state (which feature cards
   *  should "breathe") at boot and after SSE reconnects. */
  listActiveWakes(): AgentHttpResult {
    return json({ wakes: this.deps.agentStore.listRunningWakesWithScope() });
  }

  cancelWake(wakeId: string): AgentHttpResult {
    const wake = this.deps.agentStore.getWakeById(wakeId);
    if (!wake) return json({ error: "wake not found" }, 404);
    if (!this.deps.wakeScheduler.cancelWake) return json({ error: "wake cancellation is not available" }, 400);
    const result = this.deps.wakeScheduler.cancelWake(wakeId);
    return json(result, result.ok ? 200 : 409);
  }

  private verifyScope(scope: AgentScope, scopeId: string | null): string | null {
    return this.deps.scopes[scope].verifyScopeId(scopeId);
  }

  private contextUsageForThread(threadId: string) {
    if (!this.deps.contextBudgetTokens) return null;
    return this.deps.agentStore.getContextUsage(threadId, this.deps.contextBudgetTokens);
  }
}

interface ParsedMessageInput {
  content: string;
  attachments: AgentMessageAttachment[];
  clientRequestId: string | null;
  clientId: string | null;
  uiLocation: ReturnType<typeof parseUiLocation>;
  workItemRef: WorkItemRefSnapshot | undefined;
}

function json<T>(body: T, status: AgentHttpStatus = 200): AgentHttpResult<T> {
  return { status, body };
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseWorkItemRef(value: unknown): Pick<WorkItemRefSnapshot, "itemId" | "snapshotAt"> | undefined {
  if (!isRecord(value)) return undefined;
  const itemId = typeof value.itemId === "string" ? value.itemId : null;
  const snapshotAt = typeof value.snapshotAt === "string" ? value.snapshotAt : null;
  if (!itemId || !snapshotAt) return undefined;
  return { itemId, snapshotAt };
}

const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_NAME_LENGTH = 200;
const SUPPORTED_IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function parseImageAttachments(value: unknown):
  | { attachments: AgentMessageAttachment[] }
  | { error: string } {
  if (value === undefined || value === null) return { attachments: [] };
  if (!Array.isArray(value)) return { error: "attachments must be an array" };
  if (value.length > MAX_IMAGE_ATTACHMENTS) {
    return { error: `at most ${MAX_IMAGE_ATTACHMENTS} image attachments are allowed` };
  }

  const attachments: AgentMessageAttachment[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) return { error: `attachment ${index + 1} must be an object` };
    if (item.type !== "image") return { error: `attachment ${index + 1} must be an image` };
    const id = normalizeAttachmentId(item.id);
    if (!id) return { error: `attachment ${index + 1} is missing an id` };
    if (seen.has(id)) return { error: `duplicate attachment id: ${id}` };
    seen.add(id);

    const mediaType = typeof item.mediaType === "string" ? item.mediaType.trim().toLowerCase() : "";
    if (!SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) {
      return { error: `unsupported image type: ${mediaType || "(missing)"}` };
    }

    const data = typeof item.data === "string" ? item.data.replace(/\s+/g, "") : "";
    if (!data || !BASE64_RE.test(data)) return { error: `attachment ${index + 1} has invalid base64 data` };
    const sizeBytes = base64SizeBytes(data);
    if (sizeBytes <= 0) return { error: `attachment ${index + 1} is empty` };
    if (sizeBytes > MAX_IMAGE_BYTES) {
      return { error: `attachment ${index + 1} exceeds ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB` };
    }

    const name = typeof item.name === "string" ? item.name.trim().slice(0, MAX_IMAGE_NAME_LENGTH) : "";
    attachments.push({
      type: "image",
      id,
      mediaType,
      data,
      sizeBytes,
      ...(name ? { name } : {})
    });
  }
  return { attachments };
}

function normalizeAttachmentId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return /^[A-Za-z0-9._:-]{1,100}$/.test(trimmed) ? trimmed : "";
}

function base64SizeBytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor(base64.length * 3 / 4) - padding;
}
