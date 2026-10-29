import type { AgentStore } from "../agent/agent-store.js";
import type { AgentScope as AgentToolScope } from "../agent/tool-scope.js";
import type { ToolDefinition } from "../agent/tool-registry.js";
import type { WrappedDispatcher } from "../../runtime/scope.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import type { VoiceSession } from "./voice-provider.js";
import { persistVoiceToolResult, persistVoiceToolUse } from "./voice-session-messages.js";
import { VOICE_TOOL_WAKE_ID } from "../global/handoff-service.js";
import { errorText } from "../../../shared/error-text.js";

interface VoiceToolCallCoordinatorDeps {
  agentStore: AgentStore;
  /** The global agent's thread. */
  threadId: string;
  dispatcher: WrappedDispatcher;
  buildToolScope: (threadId: string) => AgentToolScope;
  sse: AgentSseEmitter;
  getSession: () => VoiceSession | null;
  /** A tool call ended. `continued`: its output went to the provider session
   *  that asked, so that reply should go on (once, when the session is
   *  free); a session reopened since never heard of the call. */
  onToolDone: (outcome: { continued: boolean }) => void;
}

/** Runs the realtime model's tool calls through the global agent's own
 *  dispatcher, in its thread, marked as spoken (VOICE_TOOL_WAKE_ID). */
export class VoiceToolCallCoordinator {
  private running = 0;
  constructor(private deps: VoiceToolCallCoordinatorDeps) {}

  get pendingCount(): number {
    return this.running;
  }

  async handleToolCall(callId: string, name: string, args: unknown, def: ToolDefinition | undefined): Promise<void> {
    const session = this.deps.getSession();
    if (!session) return;
    if (!def) {
      session.sendToolResult(callId, { errorMessage: `tool '${name}' is not available` });
      this.deps.onToolDone({ continued: true });
      return;
    }
    const threadId = this.deps.threadId;
    persistVoiceToolUse({ agentStore: this.deps.agentStore, sse: this.deps.sse, threadId, callId, name, args });
    this.running += 1;
    let payload: { result?: unknown; errorMessage?: string };
    try {
      const result = await this.deps.dispatcher.dispatch(
        { toolCallId: callId, toolName: name, args },
        { threadId, wakeId: VOICE_TOOL_WAKE_ID, scope: this.deps.buildToolScope(threadId) }
      );
      payload = result.isError ? { errorMessage: result.error ?? "tool error" } : { result: result.result };
    } catch (err) {
      payload = { errorMessage: errorText(err) };
    } finally {
      this.running -= 1;
    }
    persistVoiceToolResult({ agentStore: this.deps.agentStore, sse: this.deps.sse, threadId, callId, name, payload });
    // Only into the provider session that asked: one reopened since has
    // never heard of this call.
    const continued = this.deps.getSession() === session;
    if (continued) session.sendToolResult(callId, payload);
    this.deps.onToolDone({ continued });
  }
}
