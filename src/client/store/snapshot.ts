import { create } from "zustand";
import type { TypedSnapshot } from "@/lib/snapshot-types";
import { snapshotVersion } from "@shared/workspace-snapshot";

type ConnectionState = "idle" | "open" | "error";

/** How long the live stream stays down before the page says so: a reconnect
 *  that lands sooner (a tab brought back, a blip) shows nothing. */
const RECONNECTING_AFTER_MS = 2000;
let reconnectingTimer: ReturnType<typeof setTimeout> | null = null;

// Server app-state payloads arrive untyped (AppStateResponse.snapshot is
// unknown); the boundary cast happens once where the payload enters the
// store, and everything downstream reads the typed shape.
export type Snapshot = TypedSnapshot;

interface SnapshotRequestContext {
  generation: number;
  snapshot: Snapshot | null;
}

interface SnapshotState {
  snapshot: Snapshot | null;
  banner: string;
  connection: ConnectionState;
  /** The stream has been down RECONNECTING_AFTER_MS: say so. Kept here, with
   *  the connection, so a header mounted mid-outage (a phone turned past the
   *  breakpoint) neither restarts the wait nor hides what was shown. */
  reconnecting: boolean;
  snapshotGeneration: number;

  beginSnapshotStream: () => void;
  applySseSnapshot: (snapshot: Snapshot, first: boolean) => void;
  applyHttpSnapshot: (snapshot: Snapshot, context: SnapshotRequestContext) => void;
  setBanner: (banner: string) => void;
  clearBanner: () => void;
  setConnection: (connection: ConnectionState) => void;
}

export const useSnapshotStore = create<SnapshotState>((set, get) => ({
  snapshot: null,
  banner: "",
  connection: "idle",
  reconnecting: false,
  snapshotGeneration: 0,

  beginSnapshotStream: () => set((state) => ({ snapshotGeneration: state.snapshotGeneration + 1 })),
  applySseSnapshot: (snapshot, first) => set((state) => {
    const current = snapshotVersion(state.snapshot);
    const incoming = snapshotVersion(snapshot);
    // HTTP may have completed ahead of a queued SSE frame. Still decode that
    // frame to advance the stream baseline, without rolling back the display.
    if (current && incoming && (current.epoch === incoming.epoch
      ? incoming.revision < current.revision : !first)) return { banner: "" };
    return { snapshot, banner: "" };
  }),
  applyHttpSnapshot: (snapshot, context) => set((state) => {
    // Responses from a request that crossed a reconnect cannot establish the
    // new stream's state, especially after a server restart.
    if (context.generation !== state.snapshotGeneration) return state;
    const current = snapshotVersion(state.snapshot);
    const incoming = snapshotVersion(snapshot);
    if (current && incoming && current.epoch === incoming.epoch) {
      if (incoming.revision < current.revision) return state;
    } else if (state.snapshot !== context.snapshot) {
      // No comparable version: a restarted server (a new epoch), or nothing
      // shown yet. Only accept the response if no snapshot has replaced the
      // one visible when the request began.
      return state;
    }
    return { snapshot, banner: "" };
  }),
  setBanner: (banner) => set({ banner }),
  clearBanner: () => set({ banner: "" }),
  setConnection: (connection) => {
    if (connection === "error") {
      // The outage's wait starts at its first error, not at each retry's.
      if (get().connection !== "error") {
        if (reconnectingTimer) clearTimeout(reconnectingTimer);
        reconnectingTimer = setTimeout(() => {
          reconnectingTimer = null;
          if (get().connection === "error") set({ reconnecting: true });
        }, RECONNECTING_AFTER_MS);
      }
      set({ connection });
      return;
    }
    if (reconnectingTimer) clearTimeout(reconnectingTimer);
    reconnectingTimer = null;
    set({ connection, reconnecting: false });
  }
}));
