import { z } from "zod";
import type { AgentScope } from "../agent-store.js";
import type { ToolContext, ToolDefinition } from "../tool-registry.js";
import type { FeaturesStore, FeatureRow } from "../../features/features-store.js";
import type { ProjectsStore, ProjectRow } from "../../projects/projects-store.js";
import type {
  WindowWatchManager,
  WindowWatchRegisterResult
} from "../window-watch-manager.js";

const baseParams = {
  paneId: z.string().min(1).describe(
    "Tmux pane id to watch, for example %175. Use list_panes first if you do not know the pane id."
  ),
  stableMs: z.number().int().min(1000).max(3_600_000).optional().describe(
    "How long (ms) the pane must be quiet (no content changes) before firing. Defaults to 30000 (30 seconds)."
  ),
  timeoutMs: z.number().int().positive().optional().describe(
    "Optional timeout in milliseconds. Defaults to 30 minutes and is capped at 2 hours."
  ),
  note: z.string().optional().describe(
    "Short reason for the watch, included in the wake message."
  )
};

const featureParams = z.object(baseParams);

const overviewParams = z.object({
  featureId: z.string().min(1).optional().describe(
    "Feature id to watch. Prefer the feature.id returned by list_features or get_feature_status."
  ),
  projectSlug: z.string().min(1).optional().describe(
    "Project slug from list_features or get_feature_status. Use with featureSlug when featureId is unavailable."
  ),
  featureSlug: z.string().min(1).optional().describe(
    "Feature slug from list_features or get_feature_status. Use with projectSlug when featureId is unavailable."
  ),
  ...baseParams
});

type FeatureParams = z.infer<typeof featureParams>;
type OverviewParams = z.infer<typeof overviewParams>;
type WatchWindowParams = FeatureParams | OverviewParams;

interface WatchWindowToolDeps {
  watchManager: WindowWatchManager;
  scope: AgentScope;
  projectsStore?: ProjectsStore;
  featuresStore?: FeaturesStore;
}

export function buildWatchWindowTool(
  deps: WatchWindowToolDeps
): ToolDefinition<WatchWindowParams, WindowWatchRegisterResult> {
  const { watchManager, scope } = deps;
  const featureScope = scope === "worker";
  return {
    name: "watch_window",
    description:
      "Ask Mandate to wake this agent when a tmux pane has been quiet (no content changes) for a given duration. " +
      "Use this after starting long-running work in a pane. After registering, do not read that pane again yourself — " +
      "wait to be woken. Checking it in the meantime defeats the purpose of the watch and burns your context window. " +
      "paneId is required; use list_panes first if needed. " +
      "stableMs controls how long the pane must be quiet before firing (default 30s). " +
      (featureScope
        ? "Workers always watch their bound feature window; windowKey is not accepted. "
        : "The manager passes featureId plus paneId, or projectSlug plus featureSlug plus paneId. ") +
      "Calling this again for the same target updates its stableMs and timeout and returns status: \"updated\" " +
      "instead of being ignored. Use list_my_watches to see your pending watches and cancel_watch to cancel one.",
    parameters: (featureScope ? featureParams : overviewParams) as z.ZodType<WatchWindowParams>,
    approval: "never",
    handler: async (args, ctx) => watchManager.register({
      ownerThreadId: ctx.threadId,
      windowKey: featureScope ? featureWindowKeyFromCtx(ctx) : overviewWindowKey(args as OverviewParams, deps),
      paneId: args.paneId,
      stableMs: args.stableMs,
      timeoutMs: args.timeoutMs,
      note: args.note
    })
  };
}

/** Builds the tmux window watch key. Must stay in lockstep with
 *  FeatureWindowStore.listActiveWindowKeys() and parseWindowWatchKey() in
 *  agent-runtime.ts — all three build/parse the same key shape. */
export function featureWindowKey(
  project: Pick<ProjectRow, "tmuxSessionName">,
  feature: Pick<FeatureRow, "tmuxWindowName">
): string {
  return `${project.tmuxSessionName}:${feature.tmuxWindowName}`;
}

function featureWindowKeyFromCtx(ctx: ToolContext): string {
  if (!ctx.project || !ctx.feature) {
    throw new Error("feature watch_window context is incomplete");
  }
  return featureWindowKey(ctx.project, ctx.feature);
}

function overviewWindowKey(args: OverviewParams, deps: WatchWindowToolDeps): string {
  if (!deps.projectsStore || !deps.featuresStore) {
    throw new Error("manager watch_window resolver is not configured");
  }

  const featureId = args.featureId?.trim();
  if (featureId) {
    const feature = deps.featuresStore.getById(featureId);
    if (!feature || feature.archivedAt) throw new Error(`feature not found: ${featureId}`);
    const project = deps.projectsStore.getById(feature.projectId);
    if (!project || project.archivedAt) throw new Error(`project not found for feature: ${featureId}`);
    return featureWindowKey(project, feature);
  }

  const projectSlug = args.projectSlug?.trim();
  const featureSlug = args.featureSlug?.trim();
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
