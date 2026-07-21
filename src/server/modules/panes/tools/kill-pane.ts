import { z } from "zod";
import { requireFeatureToolContext, type ToolDefinition } from "../../agent/tool-registry.js";
import { paneInFeature } from "./pane-helpers.js";

const params = z.object({
  paneId: z.string(),
  signal: z.enum(["SIGTERM", "SIGKILL", "SIGINT"]).optional()
});
interface Result {
  ok?: boolean;
  error?: string;
}

export const killPaneTool: ToolDefinition<z.infer<typeof params>, Result> = {
  name: "kill_pane",
  description:
    "Terminate a pane in this feature. Default signal: SIGTERM. " +
    "Use SIGKILL if the process is unresponsive. " +
    "Use this tool instead of raw tmux kill-pane for Mandate-managed " +
    "panes so scope checks stay intact.",
  parameters: params,
  approval: "first-use",
  handler: async ({ paneId, signal }, ctx) => {
    const featureCtx = requireFeatureToolContext(ctx);
    if (!(await paneInFeature(paneId, ctx))) {
      return { error: `pane ${paneId} is not in this feature (scope check failed)` };
    }
    try {
      await featureCtx.paneRuntime.killPane(paneId, signal ?? "SIGTERM");
      return { ok: true };
    } catch (e: unknown) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
};
