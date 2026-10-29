import { z } from "zod";
import { requireFeatureToolContext, type ToolDefinition } from "../../agent/tool-registry.js";
import { paneInFeature } from "./pane-helpers.js";
import { errorText } from "../../../../shared/error-text.js";

const params = z.object({
  paneId: z.string()
});
interface Result {
  ok?: boolean;
  error?: string;
}

export const killPaneTool: ToolDefinition<z.infer<typeof params>, Result> = {
  name: "kill_pane",
  description:
    "Close a pane in this feature; what runs in it ends with it. " +
    "Use this tool instead of raw tmux kill-pane for Mandate-managed " +
    "panes so scope checks stay intact.",
  parameters: params,
  handler: async ({ paneId }, ctx) => {
    const featureCtx = requireFeatureToolContext(ctx);
    if (!(await paneInFeature(paneId, ctx))) {
      return { error: `pane ${paneId} is not in this feature (scope check failed)` };
    }
    try {
      await featureCtx.paneRuntime.killPane(paneId);
      return { ok: true };
    } catch (e: unknown) {
      return { error: errorText(e) };
    }
  }
};
