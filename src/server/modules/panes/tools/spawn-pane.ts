import { z } from "zod";
import { requireFeatureToolContext, type ToolDefinition } from "../../agent/tool-registry.js";
import { paneInFeature } from "./pane-helpers.js";

const params = z
  .object({
    cwd: z.string().optional(),
    direction: z.enum(["right", "down"]).optional(),
    targetPaneId: z.string().optional(),
    name: z.string().max(80).optional(),
    description: z.string().max(1000).optional()
  })
  .strict();
interface Result {
  paneId?: string;
  error?: string;
}

export const spawnPaneTool: ToolDefinition<z.infer<typeof params>, Result> = {
  name: "spawn_pane",
  description:
    "Create a new shell terminal pane in this feature. This tool " +
    "does not accept a command. To run a command, first create the " +
    "pane, then call send_keys on the returned paneId. " +
    "Use this tool instead of raw tmux split-window/new-window " +
    "commands for Mandate-managed panes; it returns the correct " +
    "paneId for follow-up calls. " +
    "Optional direction controls the split direction. Optional targetPaneId " +
    "chooses which existing pane to split; if omitted, Mandate splits the " +
    "largest pane and chooses a sensible direction to avoid tiny panes. " +
    "Optional name and description record the pane's intended purpose for " +
    "future status analysis and UI labels. Use a short stable name such as " +
    "Codex, Tests, Dev server, or Scratch. " +
    "Use only when the user asks for a new pane, no suitable pane " +
    "exists, or pane recovery requires a replacement. cwd defaults to the feature " +
    "working dir.",
  parameters: params,
  approval: "never",
  handler: async ({ cwd, direction, targetPaneId, name, description }, ctx) => {
    const featureCtx = requireFeatureToolContext(ctx);
    if (targetPaneId && !(await paneInFeature(targetPaneId, ctx))) {
      return { error: `target pane ${targetPaneId} is not in this feature (scope check failed)` };
    }
    const effectiveCwd = cwd ?? featureCtx.feature.worktreePath ?? featureCtx.project.workingDir;
    try {
      const pane = await featureCtx.paneRuntime.spawnPane({
        featureId: featureCtx.feature.id,
        cwd: effectiveCwd,
        direction,
        targetPaneId
      });
      if (name !== undefined || description !== undefined) {
        featureCtx.paneMetadata?.upsert({
          paneId: pane.id,
          featureId: featureCtx.feature.id,
          sessionName: featureCtx.project.tmuxSessionName,
          windowName: featureCtx.feature.tmuxWindowName,
          name,
          description,
          createdByThreadId: ctx.threadId
        });
      }
      return {
        paneId: pane.id
      };
    } catch (e: unknown) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
};
