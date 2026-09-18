/** The project shape the switcher needs: the route slug (`tmuxSessionName`,
 *  which `useProjectsStore.bySlug` is keyed by) and each feature's window
 *  name (the feature route's `featureSlug`). */
export interface PaneHrefProject {
  tmuxSessionName: string;
  features: ReadonlyArray<{ tmuxWindowName: string }>;
}

export interface PaneHrefInput {
  /** True on `/sessions/:sessionName/windows/:windowName/pane/:paneId`. */
  isStandalone: boolean;
  project: PaneHrefProject | null | undefined;
  /** The TARGET pane's tmux session (Recent can point at another session). */
  sessionName: string;
  windowName: string;
  paneId: string;
}

/** Terminal route for a pane picked in the switcher (spec §8.2). Entered
 *  through a feature route, a window of the same project that is one of its
 *  features keeps the feature route so the breadcrumb stays project /
 *  feature / pane; any other window (e.g. `zsh`), any pane in another
 *  session, and every standalone entry take the session-rooted route, which
 *  works for unmanaged sessions too. */
export function paneHrefFor({ isStandalone, project, sessionName, windowName, paneId }: PaneHrefInput): string {
  const feature = !isStandalone && project && project.tmuxSessionName === sessionName
    ? project.features.find((f) => f.tmuxWindowName === windowName)
    : undefined;
  if (feature && project) {
    return `/projects/${encodeURIComponent(project.tmuxSessionName)}/features/${encodeURIComponent(feature.tmuxWindowName)}/pane/${encodeURIComponent(paneId)}`;
  }
  return `/sessions/${encodeURIComponent(sessionName)}/windows/${encodeURIComponent(windowName)}/pane/${encodeURIComponent(paneId)}`;
}
