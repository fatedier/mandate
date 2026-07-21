import { SSE_EVENTS, SSE_HEARTBEAT_EVENT, type SseEventPayloadMap } from "@shared/api-contracts";
import { useAgentChatStore } from "@/store/agent-chat";
import { useProjectsStore } from "@/store/projects";
import { useSnapshotStore, type Snapshot } from "@/store/snapshot";
import { useWakeActivityStore } from "@/store/wake-activity";
import { useWorkItemsStore } from "@/store/work-items";
import { dispatchUiAction } from "@/routes/window/chat/ui-action-dispatcher";
import { respondToUiSummaryRequest } from "@/lib/ui-context";
import { parseSseData } from "./snapshot-reducer";
import { WorkspaceSnapshotDecoder } from "@shared/workspace-snapshot";

interface SnapshotListenerDeps {
  /** Returns true once the parent hook has been unmounted — every listener
   *  short-circuits on this so a late-arriving event doesn't write to stores
   *  that the consumer has already torn down. */
  cancelled: () => boolean;
  /** Setter for the SSE connection indicator. */
  setConnection: (status: "open" | "error") => void;
  /** Pull-on-reconnect: SSE has no replay, so any agent message appended
   *  during a dead window is lost. Called from the "open" listener. */
  onReconnect: () => void;
  onStreamDesync?: () => void;
  /** Transport activity, even for events without a local state handler. */
  onActivity?: (heartbeatMs?: number) => void;
}

/** Wire every domain-specific listener onto the given EventSource. Listener
 *  bodies are intentionally tiny: read the typed payload off the event,
 *  call the corresponding store method. Anything more elaborate belongs in
 *  the store or in snapshot-reducer.ts. */
export function attachSnapshotSseListeners(source: EventSource, deps: SnapshotListenerDeps): void {
  const { cancelled } = deps;
  let activePollingError: string | null = null;
  const snapshots = new WorkspaceSnapshotDecoder();
  let firstSnapshot = true;
  const applySnapshot = (snapshot: Snapshot) => {
    activePollingError = null;
    useSnapshotStore.getState().applySseSnapshot(snapshot, firstSnapshot);
    firstSnapshot = false;
  };
  for (const eventName of Object.values(SSE_EVENTS)) {
    source.addEventListener(eventName, (event) => {
      if (!cancelled() && "data" in event) deps.onActivity?.();
    });
  }
  source.addEventListener(SSE_HEARTBEAT_EVENT, (event) => {
    if (cancelled()) return;
    let intervalMs: number | undefined;
    try {
      const data = parseSseData<{ intervalMs?: number } | null>(event);
      if (typeof data?.intervalMs === "number" && Number.isFinite(data.intervalMs) && data.intervalMs > 0) {
        intervalMs = data.intervalMs;
      }
    } catch { /* Malformed heartbeat payloads still prove transport activity. */ }
    deps.onActivity?.(intervalMs);
  });
  const safeListener = <K extends keyof SseEventPayloadMap>(
    eventName: K,
    handler: (data: SseEventPayloadMap[K]) => void,
    onMalformed?: () => void
  ) => {
    source.addEventListener(eventName, (event) => {
      if (cancelled()) return;
      try {
        handler(parseSseData<SseEventPayloadMap[K]>(event));
      } catch { onMalformed?.(); }
    });
  };

  source.addEventListener("open", () => {
    if (cancelled()) return;
    snapshots.reset();
    firstSnapshot = true;
    useSnapshotStore.getState().beginSnapshotStream();
    deps.onActivity?.();
    useAgentChatStore.getState().onMessageStreams([]);
    deps.setConnection("open");
    deps.onReconnect();
    // A stream can be replaced for resynchronization while connection stays open.
    window.dispatchEvent(new CustomEvent("mandate:sse-open"));
  });
  source.addEventListener("error", (event) => {
    // A named server error has JSON data; native EventSource failures do not.
    if (!cancelled() && !("data" in event)) deps.setConnection("error");
  });

  // ── snapshot + projects/features lifecycle ─────────────────────────────
  safeListener(SSE_EVENTS.error, (error) => {
    const message = typeof error === "string" ? error : error?.message ?? "";
    if (message === activePollingError) return;
    activePollingError = message;
    useSnapshotStore.getState().setBanner(message);
  });
  safeListener(SSE_EVENTS.snapshot, (data) => {
    snapshots.reset();
    applySnapshot(data as Snapshot);
  });
  safeListener(SSE_EVENTS.snapshotFull, (data) => {
    applySnapshot(snapshots.full(data) as Snapshot);
  }, deps.onStreamDesync);
  safeListener(SSE_EVENTS.snapshotPatch, (data) => {
    applySnapshot(snapshots.patch(data) as Snapshot);
  }, deps.onStreamDesync);
  safeListener(SSE_EVENTS.projectsState, (projects) => {
    if (!Array.isArray(projects)) return;
    useProjectsStore.getState().setProjectsState(projects);
  });
  safeListener(SSE_EVENTS.projectCreated, (data) => {
    useProjectsStore.getState().addProject({ ...data, features: [], tmuxAlive: true, tmuxStatus: "alive" });
  });
  safeListener(SSE_EVENTS.projectArchived, (data) => {
    useProjectsStore.getState().removeProject(data.id);
  });
  safeListener(SSE_EVENTS.featureCreated, (data) => {
    useProjectsStore.getState().addFeature(data.projectId, { ...data, tmuxAlive: true, tmuxStatus: "alive" });
  });
  safeListener(SSE_EVENTS.featureRestored, (data) => {
    useProjectsStore.getState().addFeature(data.projectId, { ...data, tmuxAlive: true, tmuxStatus: "alive" });
  });
  safeListener(SSE_EVENTS.featureArchived, (data) => {
    if (data.projectId) {
      // Server now includes projectId in the payload (since Phase 2) so we
      // can take the direct lookup path here.
      useProjectsStore.getState().removeFeature(data.projectId, data.id);
    }
  });
  // Cleanup failure details are already returned to the caller. Surfacing the
  // broadcast here turns agent-driven archival retries into global toast noise.

  // ── agent chat ─────────────────────────────────────────────────────────
  safeListener(SSE_EVENTS.agentMessageAppended, (data) => {
    useAgentChatStore.getState().onMessageAppended(data.threadId, data.message);
  });
  safeListener(SSE_EVENTS.agentMessageDelta, (data) => {
    useAgentChatStore.getState().onMessageDelta(data.threadId, data.wakeId, data.deltaText, data.totalText);
  });
  safeListener(SSE_EVENTS.agentMessageStreams, (data) => {
    useAgentChatStore.getState().onMessageStreams(data.streams);
  });
  safeListener(SSE_EVENTS.agentMessagePatch, (data) => {
    if (!useAgentChatStore.getState().onMessagePatch(data)) deps.onStreamDesync?.();
  });
  safeListener(SSE_EVENTS.agentWakeStarted, (data) => {
    useAgentChatStore.getState().onWakeStarted(data.threadId, data.wakeId, data.reason, data.metadata);
    // Feature cards' live signal. The store ignores non-feature scopes and
    // payloads without scope (older servers), so no guard is needed here.
    useWakeActivityStore.getState().wakeStarted(data);
  });
  safeListener(SSE_EVENTS.agentContextUsageUpdated, (data) => {
    useAgentChatStore.getState().onContextUsageUpdated(data.threadId, data.wakeId, data.contextUsage);
  });
  safeListener(SSE_EVENTS.agentWakeFinished, (data) => {
    useAgentChatStore.getState().onWakeFinished(
      data.threadId,
      data.wakeId,
      data.status,
      data.errorMessage,
      data.contextUsage,
      data.error
    );
    useWakeActivityStore.getState().wakeFinished(data);
  });
  safeListener(SSE_EVENTS.agentCompressionStarted, (data) => {
    useAgentChatStore.getState().onCompressionStarted(data.threadId, data.compressionId, data.startedAt);
  });
  safeListener(SSE_EVENTS.agentCompressionFinished, (data) => {
    useAgentChatStore.getState().onCompressionFinished(data.threadId, data.compressionId, data.contextUsage ?? null);
  });
  safeListener(SSE_EVENTS.agentCompressionFailed, (data) => {
    useAgentChatStore.getState().onCompressionFailed(data.threadId, data.compressionId);
  });
  safeListener(SSE_EVENTS.agentSideTransferUpdated, (data) => {
    useAgentChatStore.getState().onSideTransferUpdated(data);
  });

  // ── UI bridge ──────────────────────────────────────────────────────────
  safeListener(SSE_EVENTS.agentUiAction, (data) => {
    dispatchUiAction(data);
  });
  safeListener(SSE_EVENTS.canvasUpdated, (data) => {
    window.dispatchEvent(new CustomEvent("mandate:canvas-updated", { detail: data }));
  });
  safeListener(SSE_EVENTS.uiSummaryRequest, (data) => {
    void respondToUiSummaryRequest(data);
  });

  // ── work items ─────────────────────────────────────────────────────────
  safeListener(SSE_EVENTS.workItemCreated, (data) => {
    useWorkItemsStore.getState().upsert(data.item);
  });
  safeListener(SSE_EVENTS.workItemUpdated, (data) => {
    useWorkItemsStore.getState().upsert(data.item);
  });

}
