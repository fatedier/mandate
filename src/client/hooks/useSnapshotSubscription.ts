import { useEffect } from "react";
import { useSnapshotStore } from "@/store/snapshot";
import { useAgentChatStore } from "@/store/agent-chat";
import { api } from "@/lib/api-paths";
import { attachSnapshotSseListeners } from "@/lib/snapshot-sse-listeners";
import { useWakeActivityStore } from "@/store/wake-activity";
import { useWorkItemsStore } from "@/store/work-items";
import { DEFAULT_SSE_HEARTBEAT_MS } from "@shared/api-contracts";

const HEARTBEAT_GRACE_MS = 10000;

/** Connects the global EventSource and owns its lifecycle: open / reconnect,
 *  heartbeat timeout, initial app-state hydration.
 *  The actual per-event handling lives in lib/snapshot-sse-listeners.ts; pure
 *  helpers (event parsing, app-state → mutations mapping) live in
 *  lib/snapshot-reducer.ts. */
export function useSnapshotSubscription(): void {
  const setConnection = useSnapshotStore((s) => s.setConnection);

  useEffect(() => {
    let cancelled = false;
    let events: EventSource | null = null;
    let heartbeatMs = DEFAULT_SSE_HEARTBEAT_MS;
    let heartbeatTimer: ReturnType<typeof setTimeout>;

    const resetHeartbeatTimer = () => {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        // Native EventSource errors may be delayed after a network loss. Check
        // the stream itself: a healthy HTTP endpoint cannot prove SSE is alive.
        setConnection("error");
        connect();
      }, heartbeatMs + HEARTBEAT_GRACE_MS);
    };

    const connect = () => {
      if (cancelled) return;
      events?.close();
      const source = new EventSource(`${api.events}?messageFormat=delta&snapshotFormat=delta`);
      events = source;
      heartbeatMs = DEFAULT_SSE_HEARTBEAT_MS;
      resetHeartbeatTimer();
      attachSnapshotSseListeners(source, {
        cancelled: () => cancelled || events !== source,
        setConnection,
        onStreamDesync: connect,
        onActivity: (intervalMs) => {
          if (intervalMs !== undefined) heartbeatMs = intervalMs;
          if (useSnapshotStore.getState().connection !== "open") setConnection("open");
          resetHeartbeatTimer();
        },
        onReconnect: () => {
          // SSE has no replay — events that fired during a reconnect window are
          // lost. After every open, ask each loaded scope to pull anything
          // newer than its last known seq so dropped agentMessageAppended events
          // don't leave the UI permanently stale. Work item updates are also
          // SSE-only, so refresh them here to keep Projects cards current after
          // reconnects.
          useAgentChatStore.getState().refetchIncrementalForOpenScopes().catch(() => {
            // Also covers a thread loaded before the first SSE open.
          });
          useWorkItemsStore.getState().fetchList("any", { limit: 200 }).catch(() => {
            // ignore — the next reconnect will retry
          });
          // Rebuild the wake-activity map from the authoritative endpoint.
          // wakeFinished events dropped during the dead window would otherwise
          // leave feature cards "breathing" forever; the snapshot REPLACES the
          // map, so stale entries vanish and wakes started while disconnected
          // appear.
          useWakeActivityStore.getState().refetch().catch(() => {
            // ignore — the next reconnect will retry
          });
        }
      });
    };

    connect();

    // SSE sends snapshot, projects and the last polling error on every open.
    // Fetching /api/state here used to transfer the same workspace twice.

    // Ensure the overview thread is loaded into the chat store at startup
    // so SSE handoff events from background dispatches
    // can route to it before the user first opens the drawer.
    useAgentChatStore.getState().ensureThreadLoaded({ type: "manager" }).catch(() => {
      // ignore — drawer will retry on open
    });

    return () => {
      cancelled = true;
      clearTimeout(heartbeatTimer);
      events?.close();
    };
  }, [setConnection]);
}
