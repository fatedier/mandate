import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useSnapshotStore } from "@/store/snapshot";
import { useProjectsStore, findWorkerBySlug } from "@/store/projects";
import { selectTerminalPane } from "./terminal-helpers";

/** The pane a worker's terminal route names: its project and worker slugs,
 *  read from the snapshot. */
export function useTerminalPaneTarget(params: {
  projectSlug?: string;
  workerSlug?: string;
  paneId?: string;
}) {
  const project = useProjectsStore((s) => params.projectSlug ? s.bySlug[params.projectSlug] : undefined);
  const worker = useMemo(
    () => findWorkerBySlug(project, params.workerSlug) ?? null,
    [project, params.workerSlug]
  );
  // React Router v7 already decodes path params, so don't re-decode here —
  // tmux pane ids start with a literal "%" (e.g. "%27") which would be
  // mangled into "'" by a second decode.
  const paneId = params.paneId ?? "";

  const found = useSnapshotStore(useShallow((s) => (
    selectTerminalPane(s.snapshot, project?.tmuxSessionName, worker?.tmuxWindowName, paneId)
  )));

  const titleText = found?.title ?? "Pane not found";
  const sessionName = project?.tmuxSessionName ?? "";
  const windowName = worker?.tmuxWindowName ?? "";
  // Snapshot streams in over SSE; on a fresh page load (e.g. browser refresh
  // straight to this URL) it's null for the first beat. Render a quiet
  // placeholder rather than flashing "Pane not found" — that label is
  // reserved for the case where we have a snapshot but the pane really is
  // gone.
  const stillLoading = found === undefined;
  return {
    project, worker, paneId, pane: found, windowData: found,
    titleText, sessionName, windowName, stillLoading
  };
}
