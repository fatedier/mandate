import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useSnapshotStore } from "@/store/snapshot";
import { useProjectsStore, findFeatureBySlug } from "@/store/projects";
import { paneTitle } from "@/routes/window/pane-helpers";
import { selectTerminalPane } from "./terminal-helpers";
import { useStandalonePaneLookup } from "./useStandalonePaneLookup";

/** The pane a terminal route names, by either of its two routes: a feature's
 *  (project and feature slugs, read from the snapshot) or a session's
 *  (session and window names, looked up by pane id). */
export function useTerminalPaneTarget(params: {
  projectSlug?: string;
  featureSlug?: string;
  sessionName?: string;
  windowName?: string;
  paneId?: string;
}) {
  const project = useProjectsStore((s) => params.projectSlug ? s.bySlug[params.projectSlug] : undefined);
  const feature = useMemo(
    () => findFeatureBySlug(project, params.featureSlug) ?? null,
    [project, params.featureSlug]
  );
  // React Router v7 already decodes path params, so don't re-decode here —
  // tmux pane ids start with a literal "%" (e.g. "%27") which would be
  // mangled into "'" by a second decode.
  const paneId = params.paneId ?? "";
  // Session-rooted mode: route is
  // `/sessions/:sessionName/windows/:windowName/pane/:paneId` — no
  // project/feature in URL. Session/window names come from the path, but
  // projectId + paneWidth/paneHeight still need a /api/panes/:paneId lookup
  // (the snapshot is filtered to managed feature windows).
  const isStandalone = !params.projectSlug;

  const standalone = useStandalonePaneLookup({ enabled: isStandalone, paneId });

  const found = useSnapshotStore(useShallow((s) => (
    isStandalone ? null : selectTerminalPane(s.snapshot, project?.tmuxSessionName, feature?.tmuxWindowName, paneId)
  )));

  const pane = isStandalone ? standalone.pane : found;
  const windowData = isStandalone ? standalone.windowData : found;
  const titleText = isStandalone
    ? (standalone.pane ? paneTitle(standalone.pane) : "Pane not found")
    : (found?.title ?? "Pane not found");
  // Session-rooted paths look up projectId from the pane DTO (it's null for
  // unmanaged tmux sessions). Managed routes have it directly from URL params.
  const sessionProjectId = isStandalone ? standalone.projectId : (project?.id ?? null);
  // Session-rooted routes name the session/window in the URL; feature routes
  // know them through the project and feature.
  const sessionName = isStandalone ? (params.sessionName ?? "") : (project?.tmuxSessionName ?? "");
  const windowName = isStandalone ? (params.windowName ?? "") : (feature?.tmuxWindowName ?? "");
  // Snapshot streams in over SSE; on a fresh page load (e.g. browser refresh
  // straight to this URL) it's null for the first beat. Render a quiet
  // placeholder rather than flashing "Pane not found" — that label is
  // reserved for the case where we have a snapshot but the pane really is
  // gone. Session-rooted mode uses its own loading/found/missing flag because
  // it doesn't depend on the snapshot stream.
  const stillLoading = isStandalone
    ? (standalone.status === "idle" || standalone.status === "loading")
    : found === undefined;
  return {
    project, feature, paneId, isStandalone, standalone, pane, windowData,
    titleText, sessionProjectId, sessionName, windowName, stillLoading
  };
}
