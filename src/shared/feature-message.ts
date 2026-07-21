import type { AgentMessageContent } from "./agent-message-types.js";

const FEATURE_MESSAGE_METADATA_KEY = "featureMessage";

export interface FeatureMessageMetadata {
  direction: "request" | "reply";
  featureId?: string;
  featureName?: string;
}

export function featureMessageRequestMetadata(): Record<string, unknown> {
  return {
    [FEATURE_MESSAGE_METADATA_KEY]: { direction: "request" }
  };
}

export function featureMessageReplyMetadata(input: {
  featureId: string;
  featureName?: string | null;
}): Record<string, unknown> {
  return {
    [FEATURE_MESSAGE_METADATA_KEY]: {
      direction: "reply",
      featureId: input.featureId,
      ...(input.featureName?.trim() ? { featureName: input.featureName.trim() } : {})
    }
  };
}

export function featureMessageMetadata(
  content: AgentMessageContent
): FeatureMessageMetadata | null {
  if (content.type !== "text") return null;
  const value = content.metadata?.[FEATURE_MESSAGE_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  if (metadata.direction !== "request" && metadata.direction !== "reply") return null;
  return {
    direction: metadata.direction,
    ...(typeof metadata.featureId === "string" ? { featureId: metadata.featureId } : {}),
    ...(typeof metadata.featureName === "string" ? { featureName: metadata.featureName } : {})
  };
}

export function isFeatureMessageRequest(content: AgentMessageContent): boolean {
  return featureMessageMetadata(content)?.direction === "request";
}
