import { featureHref, featurePaneHref } from "@/lib/feature-href";
/** The project shape the switcher needs: the route slug (`tmuxSessionName`,
 *  which `useProjectsStore.bySlug` is keyed by) and each feature's window
 *  name (the feature route's `featureSlug`). */
interface PaneHrefProject {
  tmuxSessionName: string;
  features: ReadonlyArray<{ tmuxWindowName: string }>;
}

interface PaneHrefInput {
  /** True on `/sessions/:sessionName/windows/:windowName/pane/:paneId`. */
  isStandalone: boolean;
  project: PaneHrefProject | null | undefined;
  /** The TARGET pane's tmux session (Recent can point at another session). */
  sessionName: string;
  windowName: string;
  paneId: string;
}

/** Terminal route for a pane picked in the switcher. Entered
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
    return featurePaneHref(project.tmuxSessionName, feature.tmuxWindowName, paneId);
  }
  return `/sessions/${encodeURIComponent(sessionName)}/windows/${encodeURIComponent(windowName)}/pane/${encodeURIComponent(paneId)}`;
}

interface TerminalBackInput {
  isStandalone: boolean;
  /** The feature route's params; unused on the session route. */
  projectSlug: string | undefined;
  featureSlug: string | undefined;
  /** Decoded, as route params arrive. */
  sessionName: string;
  windowName: string;
}

/** Where the terminal page's title links back to: the worker's Terminal tab
 *  on a feature route, the window in Sessions otherwise. The names are
 *  encoded again: a "#" or "?" in a window name would end the path. */
export function terminalBackHref({ isStandalone, projectSlug, featureSlug, sessionName, windowName }: TerminalBackInput): string {
  return isStandalone
    ? `/sessions/${encodeURIComponent(sessionName)}/windows/${encodeURIComponent(windowName)}`
    : `${featureHref(projectSlug ?? "", featureSlug ?? "")}?tab=terminal`;
}

interface TerminalPlaceInput {
  isStandalone: boolean;
  /** A Sessions pane's live lookup, null until it is found. */
  lookup: { sessionName?: string; windowName?: string } | null;
  projectSlug: string | undefined;
  featureSlug: string | undefined;
  featureName: string | undefined;
  /** From the route (decoded) or, on a feature route, the feature. */
  sessionName: string;
  windowName: string;
}

/** What the terminal page's title names and links back to. A Sessions pane
 *  takes the live names (its window can be renamed while open) once it is
 *  found, and the route's while it loads and after it is gone. A worker's
 *  pane is named by its feature, by its route slug until the projects load. */
export function terminalPlace({ isStandalone, lookup, projectSlug, featureSlug, featureName, sessionName, windowName }: TerminalPlaceInput): { name: string; backHref: string } {
  const live = isStandalone ? lookup : null;
  const placeSession = live?.sessionName ?? sessionName;
  const placeWindow = live?.windowName ?? windowName;
  return {
    name: isStandalone ? placeWindow : (featureName ?? featureSlug ?? ""),
    backHref: terminalBackHref({ isStandalone, projectSlug, featureSlug, sessionName: placeSession, windowName: placeWindow })
  };
}
