/** A feature's route is keyed by tmux names, not ids: the path segments are
 *  project.tmuxSessionName and feature.tmuxWindowName. */
export function featureHref(projectSlug: string, featureSlug: string): string {
  return `/projects/${encodeURIComponent(projectSlug)}/features/${encodeURIComponent(featureSlug)}`;
}
