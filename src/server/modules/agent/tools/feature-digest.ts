import { z } from "zod";
import type { AgentStore } from "../agent-store.js";
import { requireFeatureToolContext, type ToolDefinition } from "../tool-registry.js";

const digestList = z.array(z.string().min(1).max(700)).max(8).optional();

const params = z.object({
  summary: z.string().min(1).max(4000).describe("Compact background context from feature chat that the manager may need later. Do not duplicate the user-visible work item status."),
  decisions: digestList.describe("Important decisions the user and worker have settled on."),
  openQuestions: digestList.describe("Questions still needing user, worker, or manager judgment."),
  constraints: digestList.describe("Important constraints, rejected directions, or user preferences learned in discussion.")
});

export interface FeatureDigestToolDeps {
  agentStore: AgentStore;
}

export function buildUpdateFeatureDigestTool(
  deps: FeatureDigestToolDeps
): ToolDefinition<z.infer<typeof params>, {
  ok: true;
  featureId: string;
  lastSeqCovered: number;
}> {
  return {
    name: "update_feature_digest",
    description:
      "Update the feature's compact conversation digest so the manager can understand important feature-chat decisions, constraints, and open questions without reading the full thread. This is not the user-visible work item status.",
    parameters: params,
    approval: "never",
    handler: async (input, ctx) => {
      const featureCtx = requireFeatureToolContext(ctx);
      const active = deps.agentStore.getActiveMessages(ctx.threadId);
      const lastSeqCovered = active.reduce((max, message) => Math.max(max, message.seq), 0);
      const digest = deps.agentStore.upsertFeatureDigest({
        featureId: featureCtx.feature.id,
        summary: input.summary.trim(),
        decisions: normalizeList(input.decisions),
        openQuestions: normalizeList(input.openQuestions),
        constraints: normalizeList(input.constraints),
        lastSeqCovered,
        updatedByThreadId: ctx.threadId
      });
      return {
        ok: true,
        featureId: digest.featureId,
        lastSeqCovered: digest.lastSeqCovered
      };
    }
  };
}

function normalizeList(values: string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}
