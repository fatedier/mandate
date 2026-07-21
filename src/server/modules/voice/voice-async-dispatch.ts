import type { AgentStore } from "../agent/agent-store.js";
import type { WakeFinishedEvent } from "../agent/wake-loop.js";
import { renderPromptFile } from "../../platform/prompts/prompt-template.js";
import managerDispatchFollowupPromptPath from "./prompts/manager-dispatch-followup.md" with { type: "file" };

export interface AsyncManagerDispatcherDeps {
  agentStore: AgentStore;
  /** Called to wake the manager; must return the wakeId so we can
   *  filter wakeFinished events. */
  wakeManager: (threadId: string, reason: "user", triggerMessageId: string | null) => string;
  /** Called to send the result back to the provider once the wake settles. */
  sendToolResult: (callId: string, payload: { result?: unknown; errorMessage?: string }) => void;
  /** Optional async-completion path. When present, final results are injected
   *  as fresh context instead of reusing the already-acknowledged tool call. */
  sendFollowupMessage?: (text: string) => void;
}

interface PendingDispatch {
  callId: string;
  threadId: string;
}

export class AsyncManagerDispatcher {
  private pending = new Map<string, PendingDispatch>(); // wakeId → dispatch

  constructor(private deps: AsyncManagerDispatcherDeps) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Begin a new dispatch_to_manager operation. Synchronously appends the
   *  user message and schedules the wake. Returns immediately — the caller
   *  (orchestrator) should respond to the provider with `{ status: "started" }`
   *  to acknowledge the tool call; the actual answer arrives later via
   *  sendFollowupMessage once `onWakeFinished` fires when the realtime
   *  session supports it. */
  start(input: { callId: string; query: string }): void {
    const thread = this.deps.agentStore.getOrCreateThread("manager", null);
    const userMsg = this.deps.agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: input.query }
    });
    const wakeId = this.deps.wakeManager(thread.id, "user", userMsg.id);
    this.pending.set(wakeId, {
      callId: input.callId,
      threadId: thread.id
    });
  }

  /** Hook called from the agent runtime's wakeFinishedHook for the manager
   *  thread. Looks up the pending dispatch by wakeId and ships the assistant's
   *  final text (or an error) through the configured completion path. */
  async onWakeFinished(event: WakeFinishedEvent): Promise<void> {
    const dispatch = this.pending.get(event.wakeId);
    if (!dispatch) return;
    this.pending.delete(event.wakeId);

    if (event.status === "error") {
      const message = "The manager reported an error while handling the request.";
      this.deliver(dispatch.callId, { errorMessage: message });
      return;
    }

    const messages = this.deps.agentStore.getActiveMessages(dispatch.threadId);
    const latestAssistant = messages
      .filter((m) => m.role === "assistant" && m.wakeId === event.wakeId)
      .at(-1);
    const text = latestAssistant
      ? extractAssistantText(latestAssistant.content)
      : "(the manager finished with no text response)";

    this.deliver(dispatch.callId, { result: text });
  }

  private deliver(callId: string, payload: { result?: unknown; errorMessage?: string }): void {
    if (this.deps.sendFollowupMessage) {
      this.deps.sendFollowupMessage(formatManagerFollowup(payload));
      return;
    }
    this.deps.sendToolResult(callId, payload);
  }
}

function formatManagerFollowup(payload: { result?: unknown; errorMessage?: string }): string {
  if (payload.errorMessage) {
    return renderPromptFile(managerDispatchFollowupPromptPath, {
      status: "error",
      detailLabel: "Error",
      detail: payload.errorMessage,
      instructionTarget: "that the task delegated to the manager failed"
    });
  }
  return renderPromptFile(managerDispatchFollowupPromptPath, {
    status: "ok",
    detailLabel: "Result",
    detail: String(payload.result ?? ""),
    instructionTarget: "the result of the task delegated to the manager"
  });
}

function extractAssistantText(content: unknown): string {
  if (isRecord(content)) {
    const c = content;
    if (c.type === "assistant" && typeof c.text === "string" && c.text.length > 0) {
      return c.text;
    }
    if (c.type === "text" && typeof c.text === "string") return c.text;
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
