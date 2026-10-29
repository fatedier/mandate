import { errorText } from "../../../shared/error-text.js";
import { decideBargeIn } from "./voice-barge-in.js";
import type { AgentMessage, AgentStore } from "../agent/agent-store.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import type { AgentScope as AgentToolScope } from "../agent/tool-scope.js";
import type { WrappedDispatcher } from "../../runtime/scope.js";
import type {
  VoiceProvider, VoiceSession, VoiceSessionEvents,
  VoiceProviderConfig, VoiceAudioFrame, VoiceTranscriptDelta, VoiceResponseMetadata
} from "./voice-provider.js";
import type { ToolDefinition } from "../agent/tool-registry.js";
import {
  collectVoicePreloadItems,
  persistVoiceTranscript,
  voiceDialogueItem
} from "./voice-session-messages.js";
import { VoiceToolCallCoordinator } from "./voice-tool-call-coordinator.js";
import type { SpokenUpdatesFrom } from "./spoken-updates.js";

/** What our own response.create calls are tagged with (`metadata.mandate`):
 *  an update said at a pause, or the continuation of a reply whose tools
 *  returned. A response without the tag is server VAD's reply to speech. */
type MandateResponseKind = "update" | "continuation";

export function responseMetadata(kind: MandateResponseKind): VoiceResponseMetadata {
  return { mandate: kind };
}

function kindOf(metadata: VoiceResponseMetadata | null): MandateResponseKind | null {
  const kind = metadata?.mandate;
  return kind === "update" || kind === "continuation" ? kind : null;
}

export interface VoiceSessionOrchestratorDeps {
  agentStore: AgentStore;
  /** The global agent's thread: voice is the global agent, spoken. */
  threadId: string;
  provider: VoiceProvider;
  /** `tools` are the global agent's own tool definitions, registered as
   *  they are. */
  providerConfig: VoiceProviderConfig;
  /** The global scope's dispatcher: a spoken tool call runs exactly as a
   *  typed one does. */
  dispatcher: WrappedDispatcher;
  buildToolScope: (threadId: string) => AgentToolScope;
  sse: AgentSseEmitter;
  idleTimeoutMs: number;
  maxSessionMs: number;
  /** Number of recent user/assistant dialogue messages from the thread to
   *  preload into the realtime conversation. 0 = no preload. */
  contextMessageCount: number;
  /** The global agent's runtime context, as a typed turn would see it. The
   *  instructions sent are `providerConfig.systemPrompt` plus this. */
  buildRuntimeContext?: () => Promise<string | null>;
  /** Mandate changed in a way the context shows: rebuild it (throttled). */
  subscribeContextChanges?: (cb: () => void) => () => void;
  /** What to tell the user at the next pause,
   *  from when voice was turned on; a handoff outcome comes with its key. */
  subscribeSpokenUpdates?: (cb: (text: string, key?: string) => void, from: SpokenUpdatesFrom) => () => void;
  /** Outcomes this voice activation's earlier sessions already said. */
  heardUpdates?: ReadonlySet<string>;
  /** At most one context refresh per this many ms. Default 10 000. */
  contextRefreshMs?: number;
  /** After the user stops speaking, server VAD answers by itself; an update
   *  waits for that reply, or this long if none starts. Default 1500. */
  replyGraceMs?: number;
  /** Waits before each attempt to reopen a provider that dropped; after
   *  the last, voice stops ("provider-unavailable"). */
  reconnectDelaysMs?: number[];
  /** When voice was turned on, and when the user last spoke: a session that
   *  continues one the page lost keeps its limits' clocks. Default: now. */
  startedAtMs?: number;
  lastSpeechAtMs?: number;
  /** A spoken reply ended, or the session closed: the agent's turn as a
   *  typed turn ends it, when what it edited on its page is published. */
  afterResponse?: () => void;
}

const DEFAULT_RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];

/** Outbound events the browser-side WS handler subscribes to. */
export interface OrchestratorEvents {
  onAudio: (frame: VoiceAudioFrame) => void;
  onTranscript: (delta: VoiceTranscriptDelta) => void;
  /** Server VAD detected user speech start. Browser uses this to flush its
   *  audio playback queue. Fired regardless of whether a model response was
   *  in flight. */
  onSpeechStarted: () => void;
  /** `afterMs`: the limit that stopped it (idle-timeout, max-session-reached). */
  onClose: (reason: string, afterMs?: number) => void;
  onError: (message: string) => void;
  /** The provider dropped; a new provider session is being opened. */
  onReconnecting: () => void;
  onResumed: () => void;
  /** The user started speaking, at `at` (ms). */
  onUserSpeech: (at: number) => void;
  /** These outcomes' update was heard (to its end, or some of it). */
  onUpdatesHeard: (keys: string[]) => void;
}

interface SpokenUpdate { text: string; key?: string }

export class VoiceSessionOrchestrator {
  private session: VoiceSession | null = null;
  private toolCoordinator: VoiceToolCallCoordinator;
  private toolDefsByName = new Map<string, ToolDefinition>();
  private outbound = new Map<keyof OrchestratorEvents, Set<(...args: never[]) => void>>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private hardCapTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private threadId: string | null = null;
  // Per-response barge-in tracking — see voice-barge-in.ts for the decision logic.
  private responseInFlight = false;
  private currentResponseItemId: string | null = null;
  private audioMsSentForResponse = 0;
  /** True between speech_started and response.cancelled — suppresses
   *  forwarding of trailing audio frames OpenAI emits before it processes
   *  our cancel. Without this gate the client briefly hears a few hundred
   *  ms of model audio after it just flushed its playback queue. */
  private bargingIn = false;
  // Spoken updates (only at a pause) and the context refresh.
  private userSpeaking = false;
  /** The user stopped speaking and server VAD's reply has not started yet. */
  private replyExpected = false;
  private replyGraceTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the audio sent so far ends playing in the browser (it plays
   *  slower than the model makes it): an update waits for it, so it is
   *  never queued behind a reply the user may still cut off. */
  private playbackEndsAt = 0;
  private playbackTimer: ReturnType<typeof setTimeout> | null = null;
  private updates: SpokenUpdate[] = [];
  /** Responses that speak an update: their transcript is a spoken update. */
  private updateResponses = new Set<string>();
  private currentResponseId: string | null = null;
  /** The current response is one of ours (tagged), not server VAD's. */
  private currentResponseOurs = false;
  /** Our one response.create not yet started or refused; nothing else is
   *  asked for while it is out. The user speaking meanwhile marks it
   *  cancelled: it is cancelled, unheard, when it starts. */
  private requested: { kind: MandateResponseKind; cancelled: boolean } | null = null;
  /** Tool outputs are in the conversation and the reply should go on. */
  private continuationWanted = false;
  /** The batch being said, from its request to its response's end. One cut
   *  off before the user heard any of it is said again. */
  private updateBatch: { items: SpokenUpdate[]; responseId: string | null; spoke: boolean } | null = null;
  private lastContext: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshDue = false;
  private unsubscribers: Array<() => void> = [];
  /** Which provider session events belong to: a reopened session gets a new
   *  one, and a late event from an old session is ignored. */
  private generation = 0;
  /** The provider session being opened, cancelled by a close or by a newer
   *  generation (the pending socket is closed). */
  private opening: AbortController | null = null;
  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: VoiceSessionOrchestratorDeps) {
    this.toolCoordinator = new VoiceToolCallCoordinator({
      agentStore: deps.agentStore,
      threadId: deps.threadId,
      dispatcher: deps.dispatcher,
      buildToolScope: deps.buildToolScope,
      sse: deps.sse,
      getSession: () => this.session,
      onToolDone: ({ continued }) => {
        // Its output went to the session that asked: that reply goes on.
        if (continued) this.continuationWanted = true;
        // Either way a tool no longer holds the arbiter back.
        this.pump();
      }
    });
  }

  /** Subscribe to outbound events; every listener hears every event.
   *  Returns an unsubscribe for that one listener. */
  on<K extends keyof OrchestratorEvents>(event: K, cb: OrchestratorEvents[K]): () => void {
    let listeners = this.outbound.get(event);
    if (!listeners) {
      listeners = new Set();
      this.outbound.set(event, listeners);
    }
    const listener = cb as (...args: never[]) => void;
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  private emit<K extends keyof OrchestratorEvents>(event: K, ...args: Parameters<OrchestratorEvents[K]>): void {
    for (const listener of [...(this.outbound.get(event) ?? [])]) {
      try {
        (listener as (...a: Parameters<OrchestratorEvents[K]>) => void)(...args);
      } catch (err) {
        console.error(`[voice] ${event} listener failed:`, err);
      }
    }
  }

  async start(): Promise<void> {
    const tools = this.deps.providerConfig.tools ?? [];
    for (const t of tools) this.toolDefsByName.set(t.name, t);
    this.threadId = this.deps.threadId;
    // Updates count from when voice was turned on: what came back while the
    // provider opened is said too.
    const turnedOnAt = new Date(this.deps.startedAtMs ?? Date.now()).toISOString();
    // False only when superseded: closed, or a reconnect (the provider
    // dropped as it opened) now owns the session. Throws when it failed.
    await this.openProviderSession();
    // Closed while it started: nothing may outlive it.
    if (this.closed) return;
    if (this.deps.subscribeContextChanges) {
      this.unsubscribers.push(this.deps.subscribeContextChanges(() => this.scheduleRefresh()));
    }
    // One record: what is typed to the agent while
    // voice is live joins this conversation as the preload's dialogue did.
    if (this.deps.contextMessageCount > 0) {
      this.unsubscribers.push(this.deps.sse.addSink((e) => {
        if (e.event !== SSE_EVENTS.agentMessageAppended) return;
        const { threadId, message } = e.data as { threadId: string; message: AgentMessage };
        if (threadId !== this.threadId || message.source === "voice") return;
        const item = voiceDialogueItem(message);
        if (item) this.session?.preloadHistory([item]);
      }));
    }
    if (this.deps.subscribeSpokenUpdates) {
      this.unsubscribers.push(this.deps.subscribeSpokenUpdates(
        (text, key) => this.queueUpdate({ text, ...(key ? { key } : {}) }),
        { since: turnedOnAt, heard: this.deps.heardUpdates ?? new Set() }
      ));
    }
    // Idle counts from the user's last words, the length from when voice
    // was turned on: across provider and page reconnects alike; 0 means none.
    const now = Date.now();
    this.bumpIdleTimer(this.deps.idleTimeoutMs - (now - (this.deps.lastSpeechAtMs ?? now)));
    if (this.deps.maxSessionMs > 0) {
      this.hardCapTimer = setTimeout(
        () => void this.closeInternal("max-session-reached", this.deps.maxSessionMs),
        Math.max(0, this.deps.maxSessionMs - (now - (this.deps.startedAtMs ?? now)))
      );
    }
    // Its context was built before the provider opened, and changes are
    // heard only from now: anything in between reaches it now.
    this.refreshDue = true;
    void this.refreshContext();
  }

  /** Opens a provider session with the current instructions and the
   *  preload. False when superseded while it opened (closed, or a newer
   *  generation); throws when the provider could not be opened. */
  private async openProviderSession(): Promise<boolean> {
    const generation = ++this.generation;
    const superseded = () => this.closed || generation !== this.generation;
    // Reset before the build: a change raised during it stays due.
    this.refreshDue = false;
    const context = await this.contextNow(this.lastContext);
    if (superseded()) return false;
    const opening = new AbortController();
    this.opening = opening;
    let session: VoiceSession;
    try {
      session = await this.deps.provider.startSession({
        ...this.deps.providerConfig,
        systemPrompt: this.instructionsWith(context),
        tools: this.deps.providerConfig.tools ?? []
      }, this.providerEvents(generation), opening.signal);
    } catch (err) {
      if (superseded()) return false;
      throw err;
    } finally {
      if (this.opening === opening) this.opening = null;
    }
    if (superseded()) {
      try { await session.close(); } catch { /* ignore */ }
      return false;
    }
    this.lastContext = context;
    this.session = session;
    if (this.deps.contextMessageCount > 0 && this.threadId) {
      const items = collectVoicePreloadItems(
        this.deps.agentStore,
        this.threadId,
        this.deps.contextMessageCount
      );
      if (items.length > 0) session.preloadHistory(items);
    }
    if (this.refreshDue) this.scheduleRefresh();
    return true;
  }

  /** The provider's events for one session; once a newer session opens,
   *  this one's are ignored. */
  private providerEvents(generation: number): VoiceSessionEvents {
    const stale = () => generation !== this.generation;
    return {
      onAudio: (frame) => {
        if (stale()) return;
        if (this.responseInFlight) {
          // PCM16 mono @ 24 kHz: 2 bytes per sample, 24 samples per ms.
          this.audioMsSentForResponse += (frame.pcm.byteLength / 2) / 24;
        }
        if (!this.bargingIn) {
          const ms = frame.pcm.byteLength / 2 / frame.channels / (frame.sampleRate / 1000);
          this.playbackEndsAt = Math.max(Date.now(), this.playbackEndsAt) + ms;
          this.emit("onAudio", frame);
          const batch = this.updateBatch;
          if (batch && batch.responseId !== null && batch.responseId === this.currentResponseId) batch.spoke = true;
        }
      },
      onTranscript: (delta, source) => {
        if (stale()) return;
        this.emit("onTranscript", delta);
        if (delta.isFinal) {
          const text = (delta.text ?? "").trim();
          if (text && this.threadId) {
            persistVoiceTranscript({
              agentStore: this.deps.agentStore,
              sse: this.deps.sse,
              threadId: this.threadId,
              speaker: delta.speaker,
              text,
              spokenUpdate: delta.speaker === "assistant" && this.isUpdateResponse(source?.responseId ?? null)
            });
          }
        }
      },
      onToolCall: (call) => {
        if (stale()) return;
        void this.toolCoordinator.handleToolCall(
          call.callId,
          call.name,
          call.args,
          this.toolDefsByName.get(call.name)
        );
      },
      onSpeechStarted: () => {
        if (stale()) return;
        // Idle counts the user's silence: only
        // their speech restarts it.
        this.bumpIdleTimer();
        this.emit("onUserSpeech", Date.now());
        this.userSpeaking = true;
        this.clearReplyExpected();
        // The browser drops what it had queued to play.
        this.playbackEndsAt = 0;
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
        if (this.requested && !this.requested.cancelled) {
          // Ours, asked for but not started, would talk over the user: the
          // server takes this cancel after that request, and the response is
          // cancelled again, unheard, when it starts.
          this.requested.cancelled = true;
          this.session?.cancelResponse();
        }
        this.emit("onSpeechStarted");
      },
      onSpeechStopped: () => {
        if (stale()) return;
        this.userSpeaking = false;
        this.replyExpected = true;
        if (this.replyGraceTimer) clearTimeout(this.replyGraceTimer);
        this.replyGraceTimer = setTimeout(() => {
          this.clearReplyExpected();
          this.pump();
        }, this.deps.replyGraceMs ?? 1500);
      },
      onResponseCreated: ({ responseId, metadata }) => {
        if (stale()) return;
        this.responseInFlight = true;
        this.currentResponseItemId = null;
        this.audioMsSentForResponse = 0;
        this.bargingIn = false;
        this.clearReplyExpected();
        this.currentResponseId = responseId;
        const kind = kindOf(metadata);
        this.currentResponseOurs = kind !== null;
        if (kind) {
          const request = this.requested;
          this.requested = null;
          if (kind === "update" && responseId) {
            this.updateResponses.add(responseId);
            if (this.updateBatch && this.updateBatch.responseId === null) this.updateBatch.responseId = responseId;
          }
          if (request?.cancelled || this.userSpeaking) {
            // Never over the user: silenced until its cancelled done.
            this.bargingIn = true;
            this.session?.cancelResponse();
          }
        } else {
          // Server VAD's reply to speech: it sees every tool output given.
          this.continuationWanted = false;
        }
      },
      onResponseItemAdded: ({ itemId }) => {
        if (stale()) return;
        this.currentResponseItemId = itemId;
      },
      onResponseDone: ({ responseId, status }) => {
        if (stale()) return;
        this.afterResponse();
        this.responseInFlight = false;
        this.currentResponseItemId = null;
        this.audioMsSentForResponse = 0;
        this.bargingIn = false;
        this.currentResponseId = null;
        const ours = this.currentResponseOurs;
        this.currentResponseOurs = false;
        const batch = this.updateBatch;
        if (batch && batch.responseId !== null && (responseId === null || responseId === batch.responseId)) {
          if (!batch.spoke && status !== "completed" && status !== "cancelled") {
            // Failed before it said anything (a provider error): not heard,
            // so the next session says it; not asked again here.
            this.updateBatch = null;
          } else {
            // Cut off before the user heard any of it: said at the next pause.
            this.endBatch(!(status === "cancelled" && !batch.spoke));
          }
        } else if (!ours && this.requested) {
          // An untagged reply ended while ours was out: a provider that does
          // not echo the tag. Taken as ours, said, so nothing stalls or repeats.
          this.requested = null;
          if (batch && batch.responseId === null) this.endBatch(true);
        }
        this.pump();
        if (this.refreshDue) this.scheduleRefresh();
      },
      onResponseRejected: (why) => {
        if (stale()) return;
        // Ours met server VAD's reply already under way: a continuation is
        // covered by that reply; an update waits for its end. Refused
        // otherwise, no response follows.
        const request = this.requested;
        this.requested = null;
        const batch = this.updateBatch;
        const update = request?.kind === "update" && batch !== null && batch.responseId === null;
        if (why === "busy") {
          if (update) this.endBatch(false);
          return;
        }
        // Not asked again (not heard: the next session says an update);
        // what waits behind it goes on.
        if (update) this.updateBatch = null;
        this.pump();
      },
      onError: (err) => {
        if (stale()) return;
        this.emit("onError", `${err.kind}: ${err.message}`);
      },
      onClose: () => {
        // A provider that drops (its session cap, a network error) is not
        // the user stopping voice: it is reopened. Our own close set
        // `closed` before it closed the provider session (reconnect checks).
        if (stale()) return;
        if (this.reconnecting) {
          // An attempt that dropped before it was resumed: it is not taken,
          // and the retry loop goes on to its next delay.
          this.generation += 1;
          this.opening?.abort();
          this.session = null;
          return;
        }
        void this.reconnect();
      }
    };
  }

  /** Reopens a provider that dropped, waiting before each attempt; after the
   *  last, voice stops for good. The length limit keeps running. */
  private async reconnect(): Promise<void> {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    const dropped = this.session;
    this.session = null;
    // Late events of the dropped session, and an opening still pending
    // (the provider dropped as it opened), now belong to nobody.
    this.generation += 1;
    this.opening?.abort();
    this.resetConversation();
    try { await dropped?.close(); } catch { /* ignore */ }
    // A stop may have landed while it closed, or as listeners heard it.
    if (this.closed) return;
    this.emit("onReconnecting");
    for (const delay of this.deps.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS) {
      if (this.closed) return;
      await new Promise<void>((resolve) => { this.reconnectTimer = setTimeout(resolve, delay); });
      this.reconnectTimer = null;
      if (this.closed) return;
      let opened = false;
      try {
        opened = await this.openProviderSession();
      } catch {
        // the next delay
      }
      if (this.closed) return;
      // Taken only if it is still there: one that dropped as it opened
      // was let go by its onClose.
      if (opened && this.session) {
        this.reconnecting = false;
        this.emit("onResumed");
        this.pump();
        return;
      }
    }
    this.reconnecting = false;
    await this.closeInternal("provider-unavailable");
  }

  /** A reopened provider session is a new conversation (the preload replays
   *  the dialogue): what was in flight in the old one is gone. An update
   *  nobody heard is said again. */
  private resetConversation(): void {
    this.responseInFlight = false;
    this.currentResponseItemId = null;
    this.audioMsSentForResponse = 0;
    this.bargingIn = false;
    this.userSpeaking = false;
    this.clearReplyExpected();
    this.currentResponseId = null;
    this.currentResponseOurs = false;
    this.requested = null;
    this.continuationWanted = false;
    if (this.updateBatch) this.endBatch(this.updateBatch.spoke);
  }

  /** The batch being said is over: heard (some of it played), its outcomes
   *  are not said again in this activation; unheard, at the next pause. */
  private endBatch(heard: boolean): void {
    const batch = this.updateBatch;
    this.updateBatch = null;
    if (!batch) return;
    if (!heard) {
      this.updates.unshift(...batch.items);
      return;
    }
    const keys = batch.items.flatMap((item) => (item.key ? [item.key] : []));
    if (keys.length > 0) this.emit("onUpdatesHeard", keys);
  }

  /** Dropped while no provider session is open (reconnecting). Audio is
   *  not speech: it does not restart idle. */
  sendAudio(frame: VoiceAudioFrame): void {
    if (this.closed || !this.session) return;
    this.session.sendAudio(frame);
  }

  cancelResponse(): void {
    this.session?.cancelResponse();
  }

  async close(reason = "client-closed"): Promise<void> {
    await this.closeInternal(reason);
  }

  private async closeInternal(reason: string, afterMs?: number): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.hardCapTimer) clearTimeout(this.hardCapTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.opening?.abort();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.replyGraceTimer) clearTimeout(this.replyGraceTimer);
    if (this.playbackTimer) clearTimeout(this.playbackTimer);
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      try { unsubscribe(); } catch { /* ignore */ }
    }
    // Some of it played: heard. Anything else is said by the next session.
    if (this.updateBatch?.spoke) this.endBatch(true);
    try { await this.session?.close(); } catch { /* ignore */ }
    this.session = null;
    // A tool call whose reply never ended still edited what it edited.
    this.afterResponse();
    this.emit("onClose", reason, afterMs);
  }

  /** Never fails the session: a page that cannot be published is logged. */
  private afterResponse(): void {
    try {
      this.deps.afterResponse?.();
    } catch (err) {
      console.warn(`[voice] after a spoken reply: ${errorText(err)}`);
    }
  }

  /** 0 means no idle limit. */
  /** `ms`: what is left of the idle limit (all of it after the user spoke). */
  private bumpIdleTimer(ms = this.deps.idleTimeoutMs): void {
    if (this.closed || this.deps.idleTimeoutMs <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.handleIdleTimeout(), Math.max(0, ms));
  }

  private handleIdleTimeout(): void {
    // Mid-sentence is not idle, however long the sentence.
    if (this.hasPendingAsyncWork() || this.userSpeaking) {
      this.bumpIdleTimer();
      return;
    }
    void this.closeInternal("idle-timeout", this.deps.idleTimeoutMs);
  }

  /** A queued update is not work in progress: one that cannot go out must
   *  not keep an idle session open. */
  private hasPendingAsyncWork(): boolean {
    return this.toolCoordinator.pendingCount > 0;
  }

  private isUpdateResponse(responseId: string | null): boolean {
    return responseId !== null && this.updateResponses.has(responseId);
  }

  private instructionsWith(context: string | null): string {
    return context ? `${this.deps.providerConfig.systemPrompt}\n\n${context}` : this.deps.providerConfig.systemPrompt;
  }

  /** The runtime context now; when it cannot be built, `fallback` (the
   *  session keeps what it had). */
  private async contextNow(fallback: string | null): Promise<string | null> {
    try {
      return (await this.deps.buildRuntimeContext?.()) ?? null;
    } catch (err) {
      console.error("[voice] runtime context failed:", err);
      return fallback;
    }
  }

  private clearReplyExpected(): void {
    this.replyExpected = false;
    if (this.replyGraceTimer) clearTimeout(this.replyGraceTimer);
    this.replyGraceTimer = null;
  }

  /** Queued even while reconnecting: said after it resumes. */
  private queueUpdate(update: SpokenUpdate): void {
    if (this.closed) return;
    this.updates.push(update);
    this.pump();
  }

  /** The one place a response is asked for, at a pause: nobody speaking, no
   *  reply playing or about to start, nothing of ours outstanding, no tool
   *  still running. A reply whose tools all returned goes on first; then
   *  what piled up is said as one message, asked for without
   *  tools so the batch ends with its own response. */
  private pump(): void {
    if (this.closed || !this.session || this.responseInFlight || this.requested || this.userSpeaking || this.replyExpected) return;
    if (this.toolCoordinator.pendingCount > 0) return;
    if (this.continuationWanted) {
      this.continuationWanted = false;
      this.requested = { kind: "continuation", cancelled: false };
      this.session.requestResponse({ metadata: responseMetadata("continuation") });
      return;
    }
    if (this.updateBatch || this.updates.length === 0) return;
    const playing = this.playbackEndsAt - Date.now();
    if (playing > 0) {
      if (this.playbackTimer) clearTimeout(this.playbackTimer);
      this.playbackTimer = setTimeout(() => { this.playbackTimer = null; this.pump(); }, playing);
      return;
    }
    const items = this.updates.splice(0);
    const body = items.length === 1 ? items[0]!.text : items.map((u, i) => `${i + 1}. ${u.text}`).join("\n");
    this.updateBatch = { items, responseId: null, spoke: false };
    this.requested = { kind: "update", cancelled: false };
    this.session.sendContextMessage(`[Mandate update]\n${body}\nTell the user in one short sentence${items.length > 1 ? " per item" : ""}, in their language.`);
    this.session.requestResponse({ metadata: responseMetadata("update"), toolChoice: "none" });
  }

  private scheduleRefresh(): void {
    if (this.closed) return;
    this.refreshDue = true;
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshContext();
    }, this.deps.contextRefreshMs ?? 10_000);
  }

  /** A reply is playing, or ours is asked for and not yet started: the
   *  instructions wait, and the next response's end schedules them again. */
  private replyBusy(): boolean {
    return this.responseInFlight || this.requested !== null;
  }

  private async refreshContext(): Promise<void> {
    if (this.closed || !this.session || !this.refreshDue) return;
    if (this.replyBusy()) return;
    this.refreshDue = false;
    const generation = this.generation;
    const context = await this.contextNow(this.lastContext);
    // A session reopened meanwhile was opened with a newer context.
    if (this.closed || !this.session || generation !== this.generation) return;
    if (this.replyBusy()) {
      // A reply started, or was asked for, while it was built.
      this.refreshDue = true;
      return;
    }
    if (context === this.lastContext) return;
    this.lastContext = context;
    this.session.updateInstructions(this.instructionsWith(context));
  }
}
