import { renderPromptFile } from "../../platform/prompts/prompt-template.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { AgentScope as AgentToolScope } from "../agent/tool-scope.js";
import type { ToolDefinition } from "../agent/tool-registry.js";
import type { ToolDispatcher, WakeFinishedEvent } from "../agent/wake-loop.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import { AsyncManagerDispatcher } from "./voice-async-dispatch.js";
import type { VoiceSession } from "./voice-provider.js";
import { VOICE_TOOL_WHITELIST } from "./voice-tools.js";
import {
  extractAssistantText,
  formatFeatureDispatchFollowup,
  persistVoiceToolResult,
  persistVoiceToolUse
} from "./voice-session-messages.js";
import managerDispatchStartFailedPromptPath from "./prompts/manager-dispatch-start-failed.md" with { type: "file" };

interface PendingFeatureDispatch {
  toolName: string;
  featureThreadId: string;
  taskId: string;
  wakeId: string | null;
}

export interface VoiceToolCallCoordinatorDeps {
  agentStore: AgentStore;
  managerDispatcher: ToolDispatcher;
  buildManagerToolScope?: (threadId: string) => AgentToolScope;
  wakeManager: (threadId: string, reason: "user", triggerMessageId: string | null) => string;
  sse: AgentSseEmitter;
  getSession: () => VoiceSession | null;
  enqueueContextMessage: (text: string) => void;
  bumpIdleTimer: () => void;
}

export class VoiceToolCallCoordinator {
  private asyncDispatcher: AsyncManagerDispatcher;
  private pendingFeatureDispatches = new Map<string, PendingFeatureDispatch>(); // wakeId -> dispatch
  private queuedFeatureDispatches = new Map<string, PendingFeatureDispatch[]>(); // featureThreadId -> dispatches

  constructor(private deps: VoiceToolCallCoordinatorDeps) {
    this.asyncDispatcher = new AsyncManagerDispatcher({
      agentStore: deps.agentStore,
      wakeManager: deps.wakeManager,
      sendToolResult: (callId, payload) => {
        this.deps.getSession()?.sendToolResult(callId, payload);
      },
      sendFollowupMessage: (text) => this.deps.enqueueContextMessage(text)
    });
  }

  get pendingCount(): number {
    return this.asyncDispatcher.pendingCount +
      this.pendingFeatureDispatches.size +
      this.queuedFeatureDispatchCount();
  }

  async onManagerWakeFinished(event: WakeFinishedEvent): Promise<void> {
    await this.asyncDispatcher.onWakeFinished(event);
    this.handleFeatureWakeFinished(event);
  }

  async handleToolCall(
    callId: string,
    name: string,
    args: unknown,
    def: ToolDefinition | undefined
  ): Promise<void> {
    const session = this.deps.getSession();
    if (!session) return;
    this.deps.bumpIdleTimer();

    // Defense-in-depth: even though filtered tools are the only ones registered,
    // a confused model could try to call something else.
    if (!def && !VOICE_TOOL_WHITELIST.has(name) && name !== "dispatch_to_manager") {
      session.sendToolResult(callId, {
        errorMessage: `tool '${name}' is not allowed in voice sessions`
      });
      return;
    }

    if (name === "dispatch_to_manager") {
      this.handleDispatchToManager(callId, name, args, def);
      return;
    }

    await this.dispatchWhitelistedTool(callId, name, args);
  }

  private handleDispatchToManager(
    callId: string,
    name: string,
    args: unknown,
    def: ToolDefinition | undefined
  ): void {
    const session = this.deps.getSession();
    if (!session || !def) return;

    const queryParse = def.parameters.safeParse(args);
    if (!queryParse.success) {
      session.sendToolResult(callId, { errorMessage: "invalid query" });
      return;
    }
    if (!isRecord(queryParse.data) || typeof queryParse.data.query !== "string") {
      session.sendToolResult(callId, { errorMessage: "invalid query" });
      return;
    }

    const thread = this.deps.agentStore.getOrCreateThread("manager", null);
    persistVoiceToolUse({
      agentStore: this.deps.agentStore,
      sse: this.deps.sse,
      threadId: thread.id,
      callId,
      name,
      args
    });
    session.sendToolResult(callId, { result: { status: "started" } });
    persistVoiceToolResult({
      agentStore: this.deps.agentStore,
      sse: this.deps.sse,
      threadId: thread.id,
      callId,
      name,
      payload: { result: { status: "started" } }
    });
    try {
      this.asyncDispatcher.start({ callId, query: queryParse.data.query });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.enqueueContextMessage(renderPromptFile(managerDispatchStartFailedPromptPath, { error: message }));
    }
  }

  private async dispatchWhitelistedTool(callId: string, name: string, args: unknown): Promise<void> {
    const thread = this.deps.agentStore.getOrCreateThread("manager", null);
    const dispatchArgs = name === "feature_task_send" ? withVoiceChannel(args) : args;
    persistVoiceToolUse({
      agentStore: this.deps.agentStore,
      sse: this.deps.sse,
      threadId: thread.id,
      callId,
      name,
      args: dispatchArgs
    });

    let result: { result?: unknown; isError?: boolean; error?: string };
    try {
      result = await this.deps.managerDispatcher.dispatch(
        { toolCallId: callId, toolName: name, args: dispatchArgs },
        { threadId: thread.id, wakeId: "voice-session", scope: this.buildManagerToolScope(thread.id) }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.getSession()?.sendToolResult(callId, { errorMessage: message });
      persistVoiceToolResult({
        agentStore: this.deps.agentStore,
        sse: this.deps.sse,
        threadId: thread.id,
        callId,
        name,
        payload: { errorMessage: message }
      });
      return;
    }

    if (result.isError) {
      const message = result.error ?? "tool error";
      this.deps.getSession()?.sendToolResult(callId, { errorMessage: message });
      persistVoiceToolResult({
        agentStore: this.deps.agentStore,
        sse: this.deps.sse,
        threadId: thread.id,
        callId,
        name,
        payload: { errorMessage: message }
      });
      return;
    }

    this.deps.getSession()?.sendToolResult(callId, { result: result.result });
    persistVoiceToolResult({
      agentStore: this.deps.agentStore,
      sse: this.deps.sse,
      threadId: thread.id,
      callId,
      name,
      payload: { result: result.result }
    });
    this.trackFeatureDispatchIfNeeded(name, result.result);
  }

  private trackFeatureDispatchIfNeeded(toolName: string, result: unknown): void {
    if (toolName !== "feature_task_send") return;
    const taskId = isRecord(result) ? result.taskId : null;
    const featureThreadId = isRecord(result) ? result.featureThreadId : null;
    if (typeof taskId !== "string" || taskId.length === 0) return;
    if (typeof featureThreadId !== "string" || featureThreadId.length === 0) return;

    const status = isRecord(result) ? result.status : null;
    const wake = this.deps.agentStore.getRunningWakeForThread(featureThreadId);
    const dispatch: PendingFeatureDispatch = {
      toolName,
      featureThreadId,
      taskId,
      wakeId: wake?.id ?? null
    };
    if (status === "queued") {
      const queued = this.queuedFeatureDispatches.get(featureThreadId) ?? [];
      queued.push(dispatch);
      this.queuedFeatureDispatches.set(featureThreadId, queued);
      return;
    }
    if (wake) {
      this.pendingFeatureDispatches.set(wake.id, dispatch);
    }
  }

  private buildManagerToolScope(threadId: string): AgentToolScope {
    return this.deps.buildManagerToolScope?.(threadId) ?? {
      kind: "manager",
      managerDir: "",
      projectWorkingDirs: []
    };
  }

  private handleFeatureWakeFinished(event: WakeFinishedEvent): void {
    const dispatch = this.pendingFeatureDispatches.get(event.wakeId);
    if (dispatch) {
      this.pendingFeatureDispatches.delete(event.wakeId);
      this.enqueueFeatureDispatchFollowup(dispatch, event);
    }

    if (event.reason !== "user") return;
    const queued = this.queuedFeatureDispatches.get(event.threadId);
    if (!queued || queued.length === 0) return;
    const ready: PendingFeatureDispatch[] = [];
    const deferred: PendingFeatureDispatch[] = [];
    for (const queuedDispatch of queued) {
      if (queuedDispatch.wakeId === event.wakeId && this.isTaskStillOpen(queuedDispatch.taskId)) {
        deferred.push(queuedDispatch);
      } else {
        ready.push(queuedDispatch);
      }
    }
    if (deferred.length > 0) {
      this.queuedFeatureDispatches.set(event.threadId, deferred);
    } else {
      this.queuedFeatureDispatches.delete(event.threadId);
    }
    for (const queuedDispatch of ready) {
      this.enqueueFeatureDispatchFollowup(queuedDispatch, event);
    }
  }

  private enqueueFeatureDispatchFollowup(
    dispatch: PendingFeatureDispatch,
    event: WakeFinishedEvent
  ): void {
    this.deps.bumpIdleTimer();

    const text = extractAssistantText(this.deps.agentStore.getActiveMessages(dispatch.featureThreadId), event.wakeId) ||
      this.deps.agentStore.getTaskById(dispatch.taskId)?.lastNote ||
      "";
    const status = event.status === "finished" ? "ok" : "error";
    this.deps.enqueueContextMessage(formatFeatureDispatchFollowup({
      toolName: dispatch.toolName,
      sessionId: dispatch.taskId,
      status,
      text
    }));
  }

  private queuedFeatureDispatchCount(): number {
    let count = 0;
    for (const dispatches of this.queuedFeatureDispatches.values()) count += dispatches.length;
    return count;
  }

  private isTaskStillOpen(taskId: string): boolean {
    const task = this.deps.agentStore.getTaskById(taskId);
    return task?.status === "queued" ||
      task?.status === "active" ||
      task?.status === "waiting" ||
      task?.status === "blocked";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function withVoiceChannel(args: unknown): unknown {
  if (!isRecord(args)) return args;
  return { ...args, channel: "voice" };
}
