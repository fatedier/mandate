/** A feature's route is keyed by tmux names, not ids: the path segments are
 *  project.tmuxSessionName and feature.tmuxWindowName. */
export function featureHref(projectSlug: string, featureSlug: string): string {
  return `/projects/${encodeURIComponent(projectSlug)}/features/${encodeURIComponent(featureSlug)}`;
}

/** A pane inside a feature, under the feature's own route. */
export function featurePaneHref(projectSlug: string, featureSlug: string, paneId: string): string {
  return `${featureHref(projectSlug, featureSlug)}/pane/${encodeURIComponent(paneId)}`;
}

export function threadHref(threadId: string): string {
  return `/threads/${encodeURIComponent(threadId)}`;
}
