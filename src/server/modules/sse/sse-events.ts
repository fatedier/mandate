import type { AgentMessageStreamDto, SseEvent, SseEventName, SseEventPayloadMap } from "../../../shared/api-contracts.js";
import type { WorkItemDto } from "../../../shared/api/work-items.js";

type DeltaPayload = SseEventPayloadMap["agentMessageDelta"];

/** One stream per wake, so the wake identifies the coalescing bucket. */
function deltaKey(threadId: string, wakeId: string): string {
  return `${threadId}:${wakeId}`;
}

const WORK_ITEM_UPDATE_THROTTLE_MS = 200;

/**
 * Short enough that text still appears to arrive as it is written, long enough
 * that a model emitting hundreds of fragments a second cannot drive one render
 * per fragment.
 */
const MESSAGE_DELTA_THROTTLE_MS = 100;

export type SseSink = (e: SseEvent) => void;

export interface AgentSseEmitterOptions {
  workItemUpdateThrottleMs?: number;
  messageDeltaThrottleMs?: number;
}

/**
 * In-memory pub-sub for SSE. Every `emit(...)` fans out to sinks
 * registered via `addSink`, which Hono's `streamSSE` consumes. Sinks
 * that throw are silently dropped (treat exception as "client gone").
 *
 * `workItemUpdated` is throttled per-item: the first emit fires immediately,
 * then at most one trailing emit fires after 200ms with the latest payload
 * if any updates were coalesced during the window.
 *
 * `agentMessageDelta` is coalesced the same way, per (thread, wake). Each event
 * carries `totalText` — the whole reply so far, which is what lets a client that
 * joined mid-stream catch up — so sending one per fragment made the traffic
 * quadratic in the length of the reply. The HTTP boundary converts these
 * coalesced totals into patches for clients requesting messageFormat=delta.
 *
 * A coalesced delta must be flushed when its wake ends — see
 * `flushMessageDelta`.
 */
export class AgentSseEmitter {
  private sinks = new Set<SseSink>();
  /** Last published text, retained between throttle windows for reconnects. */
  private messageStreams = new Map<string, AgentMessageStreamDto>();
  private readonly workItemUpdateThrottleMs: number;
  private readonly messageDeltaThrottleMs: number;
  /**
   * Per-item throttle state. While a follow-up timer is pending, we coalesce
   * additional updates into `latest`. When the timer fires, we emit `latest`
   * and clear the entry.
   */
  private pendingWorkItemUpdates = new Map<string, { latest: WorkItemDto; timeout: ReturnType<typeof setTimeout> }>();
  /** Per (thread, wake) coalescing state, same shape as the work-item one. */
  private pendingMessageDeltas = new Map<
    string,
    { sent: DeltaPayload; latest: DeltaPayload; timeout: ReturnType<typeof setTimeout> }
  >();

  constructor(options: AgentSseEmitterOptions = {}) {
    this.workItemUpdateThrottleMs = Math.max(0, options.workItemUpdateThrottleMs ?? WORK_ITEM_UPDATE_THROTTLE_MS);
    this.messageDeltaThrottleMs = Math.max(0, options.messageDeltaThrottleMs ?? MESSAGE_DELTA_THROTTLE_MS);
  }

  addSink(sink: SseSink): () => void {
    this.sinks.add(sink);
    return () => { this.sinks.delete(sink); };
  }

  getMessageStreams(): AgentMessageStreamDto[] {
    return [...this.messageStreams.values()];
  }

  emit<T extends SseEventName>(event: T, data: SseEventPayloadMap[T]): void {
    if (event === "workItemUpdated") {
      this.emitWorkItemUpdated((data as SseEventPayloadMap["workItemUpdated"]).item);
      return;
    }
    if (event === "agentMessageDelta") {
      this.emitMessageDelta(data as DeltaPayload);
      return;
    }
    const payload = { event, data } as SseEvent;
    const ended = endedMessageStream(payload);
    if (ended) {
      this.flushMessageDelta(ended.threadId, ended.wakeId);
      if (this.messageStreams.get(ended.threadId)?.wakeId === ended.wakeId) {
        this.messageStreams.delete(ended.threadId);
      }
    }
    this.fanout(payload);
  }

  /**
   * Send whatever is still coalesced for this wake, now.
   *
   * Required rather than tidy. The client clears its streaming bubble when the
   * finished assistant message arrives; a trailing delta landing after that
   * would set the bubble again and show the finished reply twice, once as a
   * message and once as a stream that never ends. Callers flush at the end of
   * the stream, before the message is appended.
   */
  flushMessageDelta(threadId: string, wakeId: string): void {
    const key = deltaKey(threadId, wakeId);
    const pending = this.pendingMessageDeltas.get(key);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingMessageDeltas.delete(key);
    if (pending.latest !== pending.sent) {
      this.fanout({ event: "agentMessageDelta", data: pending.latest } as SseEvent);
    }
  }

  private emitMessageDelta(data: DeltaPayload): void {
    const key = deltaKey(data.threadId, data.wakeId);
    const existing = this.pendingMessageDeltas.get(key);
    if (existing) {
      existing.latest = data;
      return;
    }
    this.fanout({ event: "agentMessageDelta", data } as SseEvent);
    const timeout = setTimeout(() => {
      const pending = this.pendingMessageDeltas.get(key);
      this.pendingMessageDeltas.delete(key);
      // Reference inequality means something coalesced during the window. When
      // nothing did, the entry is dropped and the next fragment fires at once,
      // so a slow stream is never delayed by the window.
      if (pending && pending.latest !== pending.sent) {
        this.fanout({ event: "agentMessageDelta", data: pending.latest } as SseEvent);
      }
    }, this.messageDeltaThrottleMs);
    timeout.unref?.();
    this.pendingMessageDeltas.set(key, { sent: data, latest: data, timeout });
  }

  private emitWorkItemUpdated(item: WorkItemDto): void {
    const existing = this.pendingWorkItemUpdates.get(item.id);
    if (existing) {
      // Within throttle window — coalesce.
      existing.latest = item;
      return;
    }
    // Fire immediately.
    this.fanout({ event: "workItemUpdated", data: { item } } as SseEvent);
    // Schedule a single follow-up that fires only if there was a coalesced
    // update during the window.
    const timeout = setTimeout(() => {
      const pending = this.pendingWorkItemUpdates.get(item.id);
      this.pendingWorkItemUpdates.delete(item.id);
      // pending.latest may differ from the original `item` if anything
      // coalesced during the window. Only emit the follow-up if the data
      // changed (signaled by reference inequality).
      if (pending && pending.latest !== item) {
        this.fanout({ event: "workItemUpdated", data: { item: pending.latest } } as SseEvent);
      }
    }, this.workItemUpdateThrottleMs);
    this.pendingWorkItemUpdates.set(item.id, { latest: item, timeout });
  }

  private fanout(payload: SseEvent): void {
    if (payload.event === "agentMessageDelta") {
      const { threadId, wakeId, totalText } = payload.data;
      this.messageStreams.set(threadId, { threadId, wakeId, totalText });
    }
    for (const s of this.sinks) {
      try { s(payload); } catch { /* dead sink */ }
    }
  }

  get sinkCount(): number { return this.sinks.size; }
}

/** Assistant appends end a step; a wake may stream another step afterwards. */
export function endedMessageStream(event: SseEvent): { threadId: string; wakeId: string } | null {
  if (event.event === "agentWakeFinished") return event.data;
  if (event.event === "agentMessageAppended" && event.data.message.role === "assistant" && event.data.message.wakeId) {
    return { threadId: event.data.threadId, wakeId: event.data.message.wakeId };
  }
  return null;
}
