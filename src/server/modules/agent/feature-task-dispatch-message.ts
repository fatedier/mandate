import type { AgentMessageContent } from "../../../shared/agent-message-types.js";

const FEATURE_TASK_DISPATCH_METADATA_KEY = "featureTaskDispatch";

export function featureTaskDispatchMetadata(taskId: string): Record<string, unknown> {
  return {
    [FEATURE_TASK_DISPATCH_METADATA_KEY]: { taskId }
  };
}

export function isFeatureTaskDispatchContent(content: AgentMessageContent): boolean {
  if (content.type !== "text") return false;
  const metadata = content.metadata?.[FEATURE_TASK_DISPATCH_METADATA_KEY];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const taskId = (metadata as Record<string, unknown>).taskId;
  return typeof taskId === "string" && taskId.trim().length > 0;
}
