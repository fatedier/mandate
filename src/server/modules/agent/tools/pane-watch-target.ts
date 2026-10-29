import type { AgentScope } from "../agent-store.js";
import type { ToolContext } from "../tool-registry.js";
import type { FeaturesStore, FeatureRow } from "../../features/features-store.js";
import type { ProjectsStore, ProjectRow } from "../../projects/projects-store.js";

/** Which feature's pane a pane monitor watches, as the manager names it. A
 *  worker names no feature: it always watches its own. */
interface PaneWatchTarget {
  featureId?: string;
  projectSlug?: string;
  featureSlug?: string;
}

interface PaneWatchTargetDeps {
  scope: AgentScope;
  projectsStore?: ProjectsStore;
  featuresStore?: FeaturesStore;
}

/** The window watch key of the pane a monitor watches: the worker's bound
 *  feature window, or the feature the manager names. */
export function resolvePaneWindowKey(ctx: ToolContext, pane: PaneWatchTarget, deps: PaneWatchTargetDeps): string {
  return deps.scope === "worker" ? featureWindowKeyFromCtx(ctx) : overviewWindowKey(pane, deps);
}

/** Builds the tmux window watch key. Must stay in lockstep with
 *  FeatureWindowStore.listActiveWindowKeys() and parseWindowWatchKey() in
 *  runtime/pane-watch-state.ts — all three build/parse the same key shape. */
export function featureWindowKey(
  project: Pick<ProjectRow, "tmuxSessionName">,
  feature: Pick<FeatureRow, "tmuxWindowName">
): string {
  return `${project.tmuxSessionName}:${feature.tmuxWindowName}`;
}

function featureWindowKeyFromCtx(ctx: ToolContext): string {
  if (!ctx.project || !ctx.feature) {
    throw new Error("the worker's pane monitor context is incomplete");
  }
  return featureWindowKey(ctx.project, ctx.feature);
}

function overviewWindowKey(pane: PaneWatchTarget, deps: PaneWatchTargetDeps): string {
  if (!deps.projectsStore || !deps.featuresStore) {
    throw new Error("the manager's pane monitor resolver is not configured");
  }

  const featureId = pane.featureId?.trim();
  if (featureId) {
    const feature = deps.featuresStore.getById(featureId);
    if (!feature || feature.archivedAt) throw new Error(`feature not found: ${featureId}`);
    const project = deps.projectsStore.getById(feature.projectId);
    if (!project || project.archivedAt) throw new Error(`project not found for feature: ${featureId}`);
    return featureWindowKey(project, feature);
  }

  const projectSlug = pane.projectSlug?.trim();
  const featureSlug = pane.featureSlug?.trim();
  if (!projectSlug || !featureSlug) {
    throw new Error("featureId or projectSlug plus featureSlug is required");
  }

  const project = deps.projectsStore.getActiveByTmuxSessionName(projectSlug);
  if (!project) throw new Error(`project not found: ${projectSlug}`);
  const feature = deps.featuresStore.listActiveByProject(project.id)
    .find((candidate) => candidate.tmuxWindowName === featureSlug);
  if (!feature) throw new Error(`feature not found: ${projectSlug}/${featureSlug}`);
  return featureWindowKey(project, feature);
}
