/** Verify the given paneId belongs to the current feature. */
import { requireFeatureToolContext, type ToolContext } from "../../agent/tool-registry.js";

export async function paneInFeature(paneId: string, ctx: ToolContext): Promise<boolean> {
  const featureCtx = requireFeatureToolContext(ctx);
  const panes = await featureCtx.paneRuntime.listPanes(featureCtx.feature.id);
  return panes.some((p) => p.id === paneId);
}
