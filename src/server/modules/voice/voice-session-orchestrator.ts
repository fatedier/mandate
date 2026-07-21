import { decideBargeIn } from "./voice-barge-in.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import type { ToolDispatcher, WakeFinishedEvent } from "../agent/wake-loop.js";
import type { AgentScope as AgentToolScope } from "../agent/tool-scope.js";
import type {
  VoiceProvider, VoiceSession, VoiceSessionEvents,
  VoiceProviderConfig, VoiceAudioFrame, VoiceTranscriptDelta
} from "./voice-provider.js";
import {
  filterVoiceTools, buildDispatchToManagerToolPlaceholder
} from "./voice-tools.js";
import type { ToolDefinition } from "../agent/tool-registry.js";
import type { UiLocation } from "../../../shared/ui-context.js";
import type { UiContextRegistry } from "../ui-context/ui-context-registry.js";
import {
  collectVoicePreloadItems,
  persistVoiceTranscript
} from "./voice-session-messages.js";
import { VoiceToolCallCoordinator } from "./voice-tool-call-coordinator.js";

export interface VoiceSessionOrchestratorDeps {
  agentStore: AgentStore;
  provider: VoiceProvider;
  /** Provider config — `tools` is the source-of-truth ToolDefinitions list
   *  (server.ts wiring passes manager scope's defs here). The orchestrator
   *  filters via VOICE_TOOL_WHITELIST and adds dispatch_to_manager before
   *  starting the provider session. */
  providerConfig: VoiceProviderConfig;
  /** Manager scope's wrappedDispatcher — orchestrator calls .dispatch on
   *  whitelisted tools, .registry.tools is the AI-SDK shape (not used here,
   *  but kept for interface parity). */
  managerDispatcher: ToolDispatcher;
  buildManagerToolScope?: (threadId: string) => AgentToolScope;
  /** Wakes the manager for dispatch_to_manager. Must return the wakeId. */
  wakeManager: (threadId: string, reason: "user", triggerMessageId: string | null) => string;
  sse: AgentSseEmitter;
  uiContextRegistry?: UiContextRegistry;
  idleTimeoutMs: number;
  maxSessionMs: number;
  /** Number of recent user/assistant dialogue messages from the manager
   *  thread to preload into the realtime conversation. 0 = no preload. */
  contextMessageCount: number;
}

/** Outbound events the browser-side WS handler subscribes to. */
export interface OrchestratorEvents {
  onAudio: (frame: VoiceAudioFrame) => void;
  onTranscript: (delta: VoiceTranscriptDelta) => void;
  /** Server VAD detected user speech start. Browser uses this to flush its
   *  audio playback queue. Fired regardless of whether a model response was
   *  in flight. */
  onSpeechStarted: () => void;
  onClose: (reason: string) => void;
  onError: (message: string) => void;
}

export class VoiceSessionOrchestrator {
  private session: VoiceSession | null = null;
  private toolCoordinator: VoiceToolCallCoordinator;
  private toolDefsByName = new Map<string, ToolDefinition>();
  private pendingContextMessages: string[] = [];
  private outbound: Partial<OrchestratorEvents> = {};
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private hardCapTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private managerThreadId: string | null = null;
  private uiLocation: UiLocation | null = null;
  // Per-response barge-in tracking — see voice-barge-in.ts for the decision logic.
  private responseInFlight = false;
  private currentResponseItemId: string | null = null;
  private audioMsSentForResponse = 0;
  /** True between speech_started and response.cancelled — suppresses
   *  forwarding of trailing audio frames OpenAI emits before it processes
   *  our cancel. Without this gate the client briefly hears a few hundred
   *  ms of model audio after it just flushed its playback queue. */
  private bargingIn = false;

  constructor(private deps: VoiceSessionOrchestratorDeps) {
    this.toolCoordinator = new VoiceToolCallCoordinator({
      agentStore: deps.agentStore,
      managerDispatcher: deps.managerDispatcher,
      buildManagerToolScope: deps.buildManagerToolScope,
      wakeManager: deps.wakeManager,
      sse: deps.sse,
      getSession: () => this.session,
      enqueueContextMessage: (text) => this.enqueueContextMessage(text),
      bumpIdleTimer: () => this.bumpIdleTimer()
    });
  }

  /** Subscribe to outbound events. Returns an unsubscribe function. */
  on<K extends keyof OrchestratorEvents>(event: K, cb: OrchestratorEvents[K]): () => void {
    this.outbound[event] = cb;
    return () => { delete this.outbound[event]; };
  }

  async start(): Promise<void> {
    const sourceTools = this.deps.providerConfig.tools ?? [];
    const filtered = filterVoiceTools(sourceTools);
    const dispatchManager = buildDispatchToManagerToolPlaceholder();
    const allTools = [...filtered, dispatchManager];
    for (const t of allTools) this.toolDefsByName.set(t.name, t);

    const events: VoiceSessionEvents = {
      onAudio: (frame) => {
        this.bumpIdleTimer();
        if (this.responseInFlight) {
          // PCM16 mono @ 24 kHz: 2 bytes per sample, 24 samples per ms.
          this.audioMsSentForResponse += (frame.pcm.byteLength / 2) / 24;
        }
        if (!this.bargingIn) {
          this.outbound.onAudio?.(frame);
        }
      },
      onTranscript: (delta) => {
        this.bumpIdleTimer();
        this.outbound.onTranscript?.(delta);
        if (delta.isFinal) {
          const text = (delta.text ?? "").trim();
          if (text && this.managerThreadId) {
            persistVoiceTranscript({
              agentStore: this.deps.agentStore,
              sse: this.deps.sse,
              threadId: this.managerThreadId,
              speaker: delta.speaker,
              text,
              uiLocation: this.uiLocation
            });
          }
        }
      },
      onToolCall: (call) => {
        this.bumpIdleTimer();
        void this.toolCoordinator.handleToolCall(
          call.callId,
          call.name,
          call.args,
          this.toolDefsByName.get(call.name)
        );
      },
      onSpeechStarted: () => {
        const decision = decideBargeIn({
          responseInFlight: this.responseInFlight,
          currentResponseItemId: this.currentResponseItemId,
          audioMsSentForResponse: this.audioMsSentForResponse
        });
        if (decision.kind !== "noop") {
          // Reset tracking BEFORE sending cancel/truncate so a stale onAudio
          // queued behind us can't re-inflate audioMsSentForResponse.
          this.responseInFlight = false;
          this.currentResponseItemId = null;
          this.audioMsSentForResponse = 0;
          // Suppress forwarding of any audio frames OpenAI emits between now
          // and response.cancelled. Cleared on onResponseDone.
          this.bargingIn = true;
          if (this.session) {
            if (decision.kind === "cancel-and-truncate") {
              this.session.truncateItem(decision.itemId, decision.audioEndMs);
            }
            this.session.cancelResponse();
          }
        }
        this.outbound.onSpeechStarted?.();
      },
      onResponseCreated: () => {
        this.responseInFlight = true;
        this.currentResponseItemId = null;
        this.audioMsSentForResponse = 0;
        this.bargingIn = false;
      },
      onResponseItemAdded: ({ itemId }) => {
        this.currentResponseItemId = itemId;
      },
      onResponseDone: () => {
        this.responseInFlight = false;
        this.currentResponseItemId = null;
        this.audioMsSentForResponse = 0;
        this.bargingIn = false;
        this.flushContextMessages();
      },
      onError: (err) => {
        this.outbound.onError?.(`${err.kind}: ${err.message}`);
      },
      onClose: () => this.closeInternal("provider closed")
    };

    this.managerThreadId = this.deps.agentStore.getOrCreateThread("manager", null).id;
    this.session = await this.deps.provider.startSession({
      ...this.deps.providerConfig,
      tools: allTools
    }, events);
    if (this.deps.contextMessageCount > 0 && this.managerThreadId) {
      const items = collectVoicePreloadItems(
        this.deps.agentStore,
        this.managerThreadId,
        this.deps.contextMessageCount
      );
      if (items.length > 0) this.session.preloadHistory(items);
    }
    this.bumpIdleTimer();
    this.hardCapTimer = setTimeout(
      () => this.closeInternal("max-session-reached"),
      this.deps.maxSessionMs
    );
    if (this.uiLocation && this.managerThreadId) {
      this.deps.uiContextRegistry?.updateThreadLocation(this.managerThreadId, this.uiLocation);
    }
  }

  /** Forwarded from agent runtime's wakeFinishedHook — must be wired by caller. */
  async onManagerWakeFinished(event: WakeFinishedEvent): Promise<void> {
    await this.toolCoordinator.onManagerWakeFinished(event);
  }

  sendAudio(frame: VoiceAudioFrame): void {
    if (this.closed || !this.session) return;
    this.bumpIdleTimer();
    this.session.sendAudio(frame);
  }

  cancelResponse(): void {
    this.session?.cancelResponse();
  }

  setUiLocation(location: UiLocation): void {
    this.uiLocation = location;
    if (this.managerThreadId) {
      this.deps.uiContextRegistry?.updateThreadLocation(this.managerThreadId, location);
    }
  }

  async close(reason = "client-closed"): Promise<void> {
    await this.closeInternal(reason);
  }

  private async closeInternal(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.hardCapTimer) clearTimeout(this.hardCapTimer);
    try { await this.session?.close(); } catch { /* ignore */ }
    this.session = null;
    this.outbound.onClose?.(reason);
  }

  private bumpIdleTimer(): void {
    if (this.closed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(
      () => this.handleIdleTimeout(),
      this.deps.idleTimeoutMs
    );
  }

  private handleIdleTimeout(): void {
    if (this.hasPendingAsyncWork()) {
      this.bumpIdleTimer();
      return;
    }
    void this.closeInternal("idle-timeout");
  }

  private hasPendingAsyncWork(): boolean {
    return this.toolCoordinator.pendingCount > 0
      || this.pendingContextMessages.length > 0;
  }

  private enqueueContextMessage(text: string): void {
    if (this.closed || !this.session) return;
    this.bumpIdleTimer();
    this.pendingContextMessages.push(text);
    this.flushContextMessages();
  }

  private flushContextMessages(): void {
    if (this.closed || !this.session || this.responseInFlight) return;
    if (this.pendingContextMessages.length === 0) return;
    const text = this.pendingContextMessages.splice(0).join("\n\n");
    this.session.sendContextMessage(text);
  }

}
