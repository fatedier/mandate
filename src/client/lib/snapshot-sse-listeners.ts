import { toast } from "sonner";
import { useReasoningHeadingStore } from "@/store/reasoning-heading";
import { useWakeModelStore } from "@/store/wake-models";
import { useThreadModelsStore } from "@/store/thread-models";
import { useReplyActivityStore } from "@/store/reply-activity";
import { useInterruptedWakesStore } from "@/store/interrupted-wakes";
import { SSE_EVENTS, SSE_HEARTBEAT_EVENT, type SseEventPayloadMap } from "@shared/api-contracts";
import { useAgentChatStore } from "@/store/agent-chat";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useThreadStatusStore } from "@/store/thread-status";
import { useGlobalAgentStore } from "@/store/global-agent";
import { useProjectsStore } from "@/store/projects";
import { useSnapshotStore, type Snapshot } from "@/store/snapshot";
import { useWakeActivityStore } from "@/store/wake-activity";
import { useMonitorActivityStore } from "@/store/monitor-activity";
import { useWorkItemsStore } from "@/store/work-items";
import { useFeaturePlansStore } from "@/store/feature-plans";
import { useBackgroundTasksStore } from "@/store/background-tasks";
import { useAgentPageStore, type PageDataEvent } from "@/store/agent-page";
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
/** The page's built-in data changed with this event: read again, debounced. */
const pageData = (kind: PageDataEvent) => useAgentPageStore.getState().onEvent(kind);

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
    useReasoningHeadingStore.getState().clearAll();
    useReplyActivityStore.getState().clearAll();
    useWakeModelStore.getState().clearAll();
    // A thread's model may have changed while the stream was down.
    useThreadModelsStore.getState().changedAll();
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
    // A project archived takes its workers with it, with no event of theirs.
    pageData("work");
  });
  safeListener(SSE_EVENTS.projectCreated, (data) => {
    useProjectsStore.getState().addProject({ ...data, features: [], tmuxAlive: true, tmuxStatus: "alive" });
  });
  safeListener(SSE_EVENTS.projectArchived, (data) => {
    useProjectsStore.getState().removeProject(data.id);
    pageData("work");
  });
  safeListener(SSE_EVENTS.featureCreated, (data) => {
    useProjectsStore.getState().addFeature(data.projectId, { ...data, tmuxAlive: true, tmuxStatus: "alive" });
    pageData("work");
  });
  safeListener(SSE_EVENTS.featureRestored, (data) => {
    useProjectsStore.getState().addFeature(data.projectId, { ...data, tmuxAlive: true, tmuxStatus: "alive" });
    pageData("work");
    window.dispatchEvent(new CustomEvent("mandate:thread-workers-changed"));
  });
  // A worker moved to another thread (a restore into one) changes which
  // canvases are each thread's (the Workers tab's list, use-thread-canvases).
  safeListener(SSE_EVENTS.featureOwnerChanged, () => {
    window.dispatchEvent(new CustomEvent("mandate:thread-workers-changed"));
  });
  safeListener(SSE_EVENTS.featureArchived, (data) => {
    pageData("work");
    if (data.projectId) {
      // The server includes projectId in the payload, so we can take the
      // direct lookup path here.
      useProjectsStore.getState().removeFeature(data.projectId, data.id);
    }
  });
  // Cleanup failure details are already returned to the caller. Surfacing the
  // broadcast here turns agent-driven archival retries into global toast noise.

  // ── agent chat ─────────────────────────────────────────────────────────
  safeListener(SSE_EVENTS.agentMessageAppended, (data) => {
    useAgentChatStore.getState().onMessageAppended(data.threadId, data.message);
    // A step's own message ends its thinking: until the next step reasons, the
    // line says Working, not the heading of a thought that is over.
    if (data.message.role === "assistant" && data.message.wakeId) useReasoningHeadingStore.getState().clear(data.message.wakeId);
  });
  safeListener(SSE_EVENTS.agentReasoningHeading, (data) => {
    useReasoningHeadingStore.getState().set(data.wakeId, data.heading);
  });
  safeListener(SSE_EVENTS.agentMessageStreams, (data) => {
    useAgentChatStore.getState().onMessageStreams(data.streams);
  });
  safeListener(SSE_EVENTS.agentMessagePatch, (data) => {
    if (data.deltaText) useReplyActivityStore.getState().touch(data.wakeId);
    if (!useAgentChatStore.getState().onMessagePatch(data)) deps.onStreamDesync?.();
  });
  safeListener(SSE_EVENTS.agentWakeStarted, (data) => {
    pageData("work");
    useAgentChatStore.getState().onWakeStarted(data.threadId, data.wakeId, data.reason, data.metadata, data.startedAt, data.scope, data.scopeId);
    // Feature cards' live signal. The store ignores non-feature scopes and
    // payloads without scope (a thread that could not be read), so no guard
    // is needed here.
    useWakeActivityStore.getState().wakeStarted(data);
  });
  safeListener(SSE_EVENTS.agentMonitorsChanged, (data) => {
    pageData("work");
    useAgentChatStore.getState().onMonitorsChanged(data.threadId, data.monitors, data.revision);
    // Every thread's, for the sidebar's watching state.
    useMonitorActivityStore.getState().changed(data);
  });
  safeListener(SSE_EVENTS.agentWakeModel, (data) => {
    useWakeModelStore.getState().set(data.wakeId, data.model);
  });
  safeListener(SSE_EVENTS.agentThreadModelChanged, (data) => {
    useThreadModelsStore.getState().changed(data.threadId);
  });
  safeListener(SSE_EVENTS.agentContextUsageUpdated, (data) => {
    useAgentChatStore.getState().onContextUsageUpdated(data.threadId, data.wakeId, data.contextUsage);
  });
  safeListener(SSE_EVENTS.agentWakeFinished, (data) => {
    // Before the chat shows the turn idle: whether a person stopped it is
    // what its last line says.
    useInterruptedWakesStore.getState().ended(data.wakeId, data.status);
    useReasoningHeadingStore.getState().clear(data.wakeId);
    useReplyActivityStore.getState().clear(data.wakeId);
    useWakeModelStore.getState().clear(data.wakeId);
    useAgentChatStore.getState().onWakeFinished(
      data.threadId,
      data.wakeId,
      data.status,
      data.errorMessage,
      data.contextUsage,
      data.error
    );
    useWakeActivityStore.getState().wakeFinished(data);
    pageData("work");
    pageData("usage");
  });
  safeListener(SSE_EVENTS.agentCompressionStarted, (data) => {
    useAgentChatStore.getState().onCompressionStarted(data.threadId, data.compressionId, data.startedAt);
  });
  safeListener(SSE_EVENTS.agentCompressionFinished, (data) => {
    useAgentChatStore.getState().onCompressionFinished(data.threadId, data.compressionId, data.contextUsage ?? null);
  });
  safeListener(SSE_EVENTS.agentCompressionFailed, (data) => {
    useAgentChatStore.getState().onCompressionFailed(data.threadId, data.compressionId);
    // One a person asked for is told; one at a turn's gate surfaces through
    // the failed turn. A toast, not the composer's line: it comes about a
    // minute after the command, to a reader who may be elsewhere by then.
    if (data.reason === "manual") toast.error(`Couldn't compact: ${data.errorMessage ?? "unknown error"}`);
  });

  // ── manager threads ────────────────────────────────────────────────────
  // The whole list on every open: replaced, not merged, so a thread archived
  // while this tab slept disappears. The archived list is not streamed: it
  // is read again on every open.
  safeListener(SSE_EVENTS.managerThreads, (data) => {
    pageData("work");
    useManagerThreadsStore.getState().replaceAll(data.threads);
    void useManagerThreadsStore.getState().loadArchived();
  });
  safeListener(SSE_EVENTS.managerThreadUpdated, (data) => {
    useManagerThreadsStore.getState().upsert(data.thread);
    pageData("work");
  });
  // Each thread's state and what waits on the user, worked out on the
  // server: replaced whole on every push, and on every open.
  safeListener(SSE_EVENTS.threadStatus, (data) => {
    useThreadStatusStore.getState().replace(data);
    // Your agent's page reads the same states and list.
    pageData("work");
  });
  safeListener(SSE_EVENTS.managerThreadDeleted, (data) => {
    useManagerThreadsStore.getState().removeDeleted(data.threadId);
    pageData("work");
  });

  // ── global agent ───────────────────────────────────────────────────────
  safeListener(SSE_EVENTS.globalAgent, (data) => { useGlobalAgentStore.getState().setAgent(data.agent); });
  safeListener(SSE_EVENTS.globalAgentUpdated, (data) => {
    useGlobalAgentStore.getState().setAgent(data.agent);
    pageData("questions");
  });
  safeListener(SSE_EVENTS.globalHandoffUpdated, (data) => { useGlobalAgentStore.getState().upsertHandoff(data.handoff); });

  // ── UI bridge ──────────────────────────────────────────────────────────
  safeListener(SSE_EVENTS.canvasUpdated, (data) => {
    window.dispatchEvent(new CustomEvent("mandate:canvas-updated", { detail: data }));
    pageData("canvases");
  });
  // A worker's task record, for its Plan tab's row (WorkRecordRow).
  safeListener(SSE_EVENTS.featureRecordUpdated, (data) => {
    window.dispatchEvent(new CustomEvent("mandate:feature-record-updated", { detail: data }));
  });

  // ── work items ─────────────────────────────────────────────────────────
  safeListener(SSE_EVENTS.workItemCreated, (data) => {
    useWorkItemsStore.getState().upsert(data.item);
    pageData("work");
  });
  safeListener(SSE_EVENTS.workItemUpdated, (data) => {
    useWorkItemsStore.getState().upsert(data.item);
    pageData("work");
  });

  // ── feature plans ──────────────────────────────────────────────────────
  safeListener(SSE_EVENTS.featurePlanUpdated, (data) => {
    useFeaturePlansStore.getState().upsert(data.plan);
    pageData("work");
  });
  // Every active plan, sent as a connection opens and before the projects. It
  // is a read taken then: a plan pushed since may be newer.
  safeListener(SSE_EVENTS.featurePlans, (data) => {
    const store = useFeaturePlansStore.getState();
    for (const plan of data.plans) store.upsert(plan, "fetch");
    pageData("work");
  });

  // ── background tasks ───────────────────────────────────────────────────
  // A task started, moved on or ended (a subagent, today): its line where it
  // started, the strip and the list read the store.
  safeListener(SSE_EVENTS.backgroundTaskChanged, (data) => {
    useBackgroundTasksStore.getState().apply(data.task);
  });
  // A running command's last line: not stored, at most one every 2 s.
  safeListener(SSE_EVENTS.backgroundTaskOutput, (data) => {
    useBackgroundTasksStore.getState().applyOutput(data);
  });

  // ── Your agent's page ──────────────────────────────────────────────────
  // Its state and sources as they change; its answers, read again.
  safeListener(SSE_EVENTS.agentPageUpdated, (data) => { useAgentPageStore.getState().applyState(data.state); });
  safeListener(SSE_EVENTS.agentPageSourceChanged, (data) => { useAgentPageStore.getState().applySource(data); });
  safeListener(SSE_EVENTS.agentPageAnswer, () => { pageData("answers"); });

}
