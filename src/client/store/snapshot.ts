import { create } from "zustand";
import type { TypedSnapshot } from "@/lib/snapshot-types";
import { snapshotVersion } from "@shared/workspace-snapshot";

type ConnectionState = "idle" | "open" | "error";

interface WindowPreference {
  pinned?: boolean;
  hidden?: boolean;
  [key: string]: unknown;
}

type PreferencesMap = Record<string, WindowPreference>;

// Server app-state payloads arrive untyped (AppStateResponse.snapshot is
// unknown); the boundary cast happens once where the payload enters the
// store, and everything downstream reads the typed shape.
export type Snapshot = TypedSnapshot;

export interface SnapshotRequestContext {
  generation: number;
  snapshot: Snapshot | null;
}

interface SnapshotState {
  snapshot: Snapshot | null;
  preferences: PreferencesMap;
  banner: string;
  connection: ConnectionState;
  snapshotGeneration: number;

  setSnapshot: (snapshot: Snapshot | null) => void;
  beginSnapshotStream: () => void;
  applySseSnapshot: (snapshot: Snapshot, first: boolean) => void;
  applyHttpSnapshot: (snapshot: Snapshot, context: SnapshotRequestContext) => void;
  setPreferences: (preferences: PreferencesMap) => void;
  mergePreference: (key: string, patch: WindowPreference) => void;
  setBanner: (banner: string) => void;
  clearBanner: () => void;
  setConnection: (connection: ConnectionState) => void;
}

export const useSnapshotStore = create<SnapshotState>((set) => ({
  snapshot: null,
  preferences: {},
  banner: "",
  connection: "idle",
  snapshotGeneration: 0,

  setSnapshot: (snapshot) => set({ snapshot, banner: "" }),
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
      // Older servers have no comparable version. Only accept their response
      // if no snapshot has replaced the one visible when the request began.
      return state;
    }
    return { snapshot, banner: "" };
  }),
  setPreferences: (preferences) => set({ preferences }),
  mergePreference: (key, patch) =>
    set((state) => ({
      preferences: {
        ...state.preferences,
        [key]: { ...(state.preferences[key] ?? {}), ...patch }
      }
    })),
  setBanner: (banner) => set({ banner }),
  clearBanner: () => set({ banner: "" }),
  setConnection: (connection) => set({ connection })
}));
