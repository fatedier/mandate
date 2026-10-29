import { useMemo } from "react";
import { useSnapshotStore } from "@/store/snapshot";
import type { TypedSnapshot } from "@/lib/snapshot-types";

/** Where a live pane is: its tmux session and window (a feature's route is
 *  project.tmuxSessionName + feature.tmuxWindowName) and the name the pane
 *  cards show, when it has one. */
interface PaneLocation {
  sessionName: string;
  windowName: string;
  name: string | null;
}

function paneLocationsFrom(snapshot: TypedSnapshot | null): Map<string, PaneLocation> {
  const index = new Map<string, PaneLocation>();
  for (const session of snapshot?.sessions ?? []) {
    for (const window of session.windows ?? []) {
      for (const pane of window.panes ?? []) {
        if (!pane.paneId) continue;
        const sessionName = pane.sessionName ?? window.sessionName ?? session.sessionName;
        const windowName = pane.windowName ?? window.windowName;
        if (!sessionName || !windowName) continue;
        index.set(pane.paneId, { sessionName, windowName, name: pane.metadata?.name?.trim() || null });
      }
    }
  }
  return index;
}

/** Pane id → the name the pane cards show, for every pane that has one. A
 *  pane without a metadata name is left out, so callers fall back to its id. */
export function paneNamesFrom(snapshot: TypedSnapshot | null): Map<string, string> {
  const names = new Map<string, string>();
  for (const session of snapshot?.sessions ?? []) {
    for (const window of session.windows ?? []) {
      for (const pane of window.panes ?? []) {
        const name = pane.metadata?.name?.trim();
        if (pane.paneId && name) names.set(pane.paneId, name);
      }
    }
  }
  return names;
}

export function usePaneNames(): Map<string, string> {
  const snapshot = useSnapshotStore((s) => s.snapshot);
  return useMemo(() => paneNamesFrom(snapshot), [snapshot]);
}

export function usePaneLocations(): Map<string, PaneLocation> {
  const snapshot = useSnapshotStore((s) => s.snapshot);
  return useMemo(() => paneLocationsFrom(snapshot), [snapshot]);
}
