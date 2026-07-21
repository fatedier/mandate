import { z } from "zod";
import type { AgentStore, AgentWakeReason } from "../agent-store.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { FeaturesStore } from "../../features/features-store.js";
import { featureMessageRequestMetadata } from "../../../../shared/feature-message.js";

const sendParams = z.object({
  featureId: z.string().min(1).describe("Feature id from list_features."),
  message: z
    .string()
    .trim()
    .min(1)
    .max(20_000)
    .describe(
      "Conversational message for the feature's worker. This does not create or update a task."
    )
});

export interface FeatureMessageToolDeps {
  agentStore: AgentStore;
  featuresStore: FeaturesStore;
  wakeScheduler: {
    wake: (
      threadId: string,
      reason: AgentWakeReason,
      triggerMessageId: string | null
    ) => string | null;
  };
  markPendingMailboxWake?: (threadId: string) => void;
}

export function buildFeatureMessageSendTool(deps: FeatureMessageToolDeps): ToolDefinition<
  z.infer<typeof sendParams>,
  {
    featureThreadId?: string;
    status?: "started" | "queued";
    error?: string;
  }
> {
  return {
    name: "feature_message_send",
    description:
      "Send a conversational message to a feature worker's main conversation without creating or updating a task. " +
      "Use for questions, clarifications, added context, feedback, and continuing an existing conversation.",
    parameters: sendParams,
    approval: "never",
    handler: async ({ featureId, message }, ctx) => {
      const feature = deps.featuresStore.getById(featureId);
      if (!feature) return { error: `feature not found: ${featureId}` };
      if (feature.archivedAt) return { error: `feature is archived: ${featureId}` };

      const thread = deps.agentStore.getOrCreateThread("worker", featureId);
      deps.agentStore.enqueueMailboxMessage({
        threadId: thread.id,
        role: "user",
        source: "manager",
        sourceThreadId: ctx.threadId,
        content: {
          type: "text",
          text: message,
          metadata: featureMessageRequestMetadata()
        }
      });

      const wakeId = deps.wakeScheduler.wake(thread.id, "user", null);
      if (!wakeId) deps.markPendingMailboxWake?.(thread.id);
      return {
        featureThreadId: thread.id,
        status: wakeId ? "started" : "queued"
      };
    }
  };
}
