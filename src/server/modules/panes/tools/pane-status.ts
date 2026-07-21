import { z } from "zod";
import { requireFeatureToolContext, type ToolDefinition } from "../../agent/tool-registry.js";
import { limitToolText } from "../../agent/tool-result-format.js";
import { paneInFeature } from "./pane-helpers.js";

const params = z.object({ paneId: z.string() });
interface Result {
  status?: string; summary?: string; taskTitle?: string; name?: string; description?: string;
  summaryTruncated?: boolean; taskTitleTruncated?: boolean;
  confidence?: number; changedAt?: string; error?: string;
}

export const paneStatusTool: ToolDefinition<z.infer<typeof params>, Result> = {
  name: "pane_status",
  description: "Return the analyzer's cached status assessment for a pane in this feature.",
  parameters: params,
  approval: "never",
  handler: async ({ paneId }, ctx) => {
    const featureCtx = requireFeatureToolContext(ctx);
    if (!(await paneInFeature(paneId, ctx))) {
      return { error: `pane ${paneId} is not in this feature (scope check failed)` };
    }
    const metadata = featureCtx.paneMetadata?.get(paneId);
    const cached = featureCtx.analyzer?.getCachedAnalysis?.(paneId);
    if (!cached) {
      return {
        status: "unknown",
        ...(metadata?.name ? { name: metadata.name } : {}),
        ...(metadata?.description ? { description: metadata.description } : {})
      };
    }
    const summary = cached.summary ? limitToolText(cached.summary, 600) : null;
    const taskTitle = cached.taskTitle ? limitToolText(cached.taskTitle, 240) : null;
    return {
      status: cached.status,
      ...(metadata?.name ? { name: metadata.name } : {}),
      ...(metadata?.description ? { description: metadata.description } : {}),
      ...(summary ? { summary: summary.text, ...(summary.truncated ? { summaryTruncated: true } : {}) } : {}),
      ...(taskTitle ? { taskTitle: taskTitle.text, ...(taskTitle.truncated ? { taskTitleTruncated: true } : {}) } : {}),
      confidence: cached.confidence,
      changedAt: cached.changedAt
    };
  }
};
