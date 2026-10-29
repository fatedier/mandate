import { SSE_EVENTS, type SseEventName } from "../../../shared/api-contracts.js";
import type { ThreadStatusSnapshotDto } from "../../../shared/api/thread-status.js";
import { logError } from "../../platform/logger.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";

/** The events that can change a thread's state or what waits on the user:
 *  turns, messages, waits, workers, plans, threads, projects, Your agent's
 *  questions. The rest (pane snapshots, streamed text, output lines) come
 *  many times a second and change none of it. */
const STATUS_INPUTS: ReadonlySet<SseEventName> = new Set<SseEventName>([
  SSE_EVENTS.agentMessageAppended,
  SSE_EVENTS.agentWakeStarted,
  SSE_EVENTS.agentWakeFinished,
  SSE_EVENTS.agentMonitorsChanged,
  SSE_EVENTS.agentCompressionStarted,
  SSE_EVENTS.agentCompressionFinished,
  SSE_EVENTS.agentCompressionFailed,
  SSE_EVENTS.backgroundTaskChanged,
  SSE_EVENTS.workItemCreated,
  SSE_EVENTS.workItemUpdated,
  SSE_EVENTS.featurePlanUpdated,
  SSE_EVENTS.featureCreated,
  SSE_EVENTS.featureArchived,
  SSE_EVENTS.featureRestored,
  SSE_EVENTS.featureOwnerChanged,
  SSE_EVENTS.projectsState,
  SSE_EVENTS.projectArchived,
  SSE_EVENTS.projectReordered,
  SSE_EVENTS.managerThreadUpdated,
  SSE_EVENTS.managerThreadDeleted,
  SSE_EVENTS.globalAgentUpdated
]);

/** Many turns at once still read the whole installation at most four times
 *  a second. */
const MIN_INTERVAL_MS = 250;

export interface ThreadStatusBroadcast {
  /** The last snapshot worked out: what a connection is sent as it opens. */
  current(): ThreadStatusSnapshotDto;
  /** Work it out again, for a change no event carries (a manager stop check's verdict). */
  poke(): void;
  stop(): void;
}

/** Works the status snapshot out again after anything that can change it,
 *  once for a burst of events, and sends it whole when it changed. It waits
 *  for the next turn of the event loop: a turn's end is announced while its
 *  thread is still held, and what was written in the same tick (the hold let
 *  go, a reply queued behind it) is read with it. */
export function startThreadStatusBroadcast(input: {
  sse: AgentSseEmitter;
  compute: () => ThreadStatusSnapshotDto;
  /** A thread's scope, for an event that names one: a subagent's hidden
   *  thread changes nothing here. */
  scopeOf?: (threadId: string) => string | null;
  /** The least time between two computations: a burst that goes on (many
   *  turns at once) is read at most this often, and once more at its end. */
  minIntervalMs?: number;
}): ThreadStatusBroadcast {
  const minIntervalMs = input.minIntervalMs ?? MIN_INTERVAL_MS;
  let current: ThreadStatusSnapshotDto = { threads: [], waiting: [] };
  let currentJson = JSON.stringify(current);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRun = Number.NEGATIVE_INFINITY;
  let stopped = false;
  const recompute = () => {
    try {
      const next = input.compute();
      const json = JSON.stringify(next);
      if (json === currentJson) return false;
      current = next;
      currentJson = json;
      return true;
    } catch (err) {
      logError("thread status", err);
      return false;
    }
  };
  const schedule = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      lastRun = Date.now();
      if (recompute()) input.sse.emit(SSE_EVENTS.threadStatus, current);
    }, Math.max(0, lastRun + minIntervalMs - Date.now()));
  };
  const fromSubagent = (data: unknown) => {
    const event = data as { threadId?: unknown; scope?: unknown } | null;
    if (!event || typeof event.threadId !== "string") return false;
    const scope = typeof event.scope === "string" ? event.scope : input.scopeOf?.(event.threadId) ?? null;
    return scope === "subagent";
  };
  recompute();
  const stopSink = input.sse.addSink((e) => { if (STATUS_INPUTS.has(e.event) && !fromSubagent(e.data)) schedule(); });
  return {
    current: () => current,
    poke: schedule,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      stopSink();
    }
  };
}

/** The broadcast's poke for whoever is built before it (the runtime):
 *  quiet until one is attached. */
export interface StatusHolder {
  poke(): void;
}

export function createStatusHolder(): StatusHolder & { attach(broadcast: ThreadStatusBroadcast): void } {
  let attached: ThreadStatusBroadcast | null = null;
  return {
    poke: () => attached?.poke(),
    attach: (broadcast) => { attached = broadcast; }
  };
}
