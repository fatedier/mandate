import { z } from "zod";
import { requireFeatureToolContext, type ToolDefinition } from "../../agent/tool-registry.js";
import { paneInFeature } from "./pane-helpers.js";

const params = z.object({
  paneId: z.string().min(1),
  name: z.string().max(80).optional(),
  description: z.string().max(1000).optional()
}).strict();

interface Result {
  ok?: true;
  paneId?: string;
  error?: string;
}

export const setPaneMetadataTool: ToolDefinition<z.infer<typeof params>, Result> = {
  name: "set_pane_metadata",
  description:
    "Set or update the short name and purpose description for an existing pane in this feature. " +
    "Use this when a pane's role becomes clear or changes after creation. " +
    "Name should be short and stable, for example Codex, Tests, Dev server, or Scratch. " +
    "Description should explain the pane's intended purpose and whether it is safe to close.",
  parameters: params,
  approval: "never",
  handler: async ({ paneId, name, description }, ctx) => {
    const featureCtx = requireFeatureToolContext(ctx);
    if (!(await paneInFeature(paneId, ctx))) {
      return { error: `pane ${paneId} is not in this feature (scope check failed)` };
    }
    if (!featureCtx.paneMetadata) {
      return { error: "pane metadata store is not available" };
    }
    const metadata = featureCtx.paneMetadata.upsert({
      paneId,
      featureId: featureCtx.feature.id,
      sessionName: featureCtx.project.tmuxSessionName,
      windowName: featureCtx.feature.tmuxWindowName,
      name,
      description,
      createdByThreadId: ctx.threadId
    });
    return {
      ok: true,
      paneId: metadata.paneId
    };
  }
};
