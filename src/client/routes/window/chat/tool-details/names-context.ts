import { createContext, useContext, useMemo } from "react";
import { useProjectsStore } from "@/store/projects";
import type { ToolRunRow } from "../tool-run-summary";
import { NO_NAMES, type ToolNames } from "./names";

/** The names the transcript around a call recorded, provided by the message
 *  list. Outside one, no names: every id shows as itself. */
export const ToolNamesContext = createContext<ToolNames>(NO_NAMES);

/** The monitors the thread still waits on, by id, provided by the message
 *  list: their rows read in the present. Outside one, none. */
export const PendingMonitorsContext = createContext<ReadonlySet<string>>(new Set());

export interface NameLookup {
  /** The name the pane a call acted on had when the call was made (see
   *  ToolNames). */
  pane(callId: string): string | null;
  feature(id: string): string | null;
  canvas(id: string): string | null;
  /** For a read of a saved tool output, the call that output came from. */
  savedOutput(callId: string): ToolRunRow | null;
  monitorPending(monitorId: string): boolean;
}

/** Pane names only as the transcript recorded them (see collectToolNames).
 *  A feature id is never reused, so its name can also come from the features
 *  the app knows now — current rather than as-of-the-call, which for a name
 *  is what the reader wants — with the transcript's for one no longer listed. */
export function useNameLookup(): NameLookup {
  const names = useContext(ToolNamesContext);
  const pendingMonitors = useContext(PendingMonitorsContext);
  const projects = useProjectsStore((state) => state.projects);
  return useMemo(() => {
    const live = new Map<string, string>();
    for (const project of projects) for (const feature of project.features) if (feature.name) live.set(feature.id, feature.name);
    return {
      pane: (callId) => names.paneOfCall.get(callId) ?? null,
      feature: (id) => live.get(id) ?? names.features.get(id) ?? null,
      canvas: (id) => names.canvases.get(id) ?? null,
      savedOutput: (callId) => {
        const source = names.savedOutputOfRead.get(callId);
        return source ? { call: source.call, result: source.result, isRunning: false } : null;
      },
      monitorPending: (monitorId) => pendingMonitors.has(monitorId)
    };
  }, [names, pendingMonitors, projects]);
}
