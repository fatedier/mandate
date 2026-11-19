import { z } from "zod";
import { requireWorkerToolContext, type ToolDefinition } from "../../agent/tool-registry.js";
import { limitToolText } from "../../agent/tool-result-format.js";
import { paneInWorker } from "./pane-helpers.js";
import { params } from "./pane-status-schema.js";
interface Result {
  status?: string; summary?: string; taskTitle?: string; name?: string; description?: string;
  summaryTruncated?: boolean; taskTitleTruncated?: boolean;
  confidence?: number; changedAt?: string; error?: string;
}

export const paneStatusTool: ToolDefinition<z.infer<typeof params>, Result> = {
  name: "pane_status",
  description: "Return the analyzer's cached status assessment for one of this worker's panes.",
  parameters: params,
  handler: async ({ paneId }, ctx) => {
    const workerCtx = requireWorkerToolContext(ctx);
    if (!(await paneInWorker(paneId, ctx))) {
      return { error: `pane ${paneId} is not this worker's (scope check failed)` };
    }
    const metadata = workerCtx.paneMetadata?.get(paneId);
    const cached = workerCtx.analyzer?.getCachedAnalysis(paneId);
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
