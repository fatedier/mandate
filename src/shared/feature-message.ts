import type { AgentMessageContent } from "./agent-message-types.js";

const FEATURE_MESSAGE_METADATA_KEY = "featureMessage";

/** How a worker's turn ended when it left no words for its manager. */
const REPLY_OUTCOMES = ["error", "canceled", "stuck", "no_reply"] as const;
export type FeatureReplyOutcome = (typeof REPLY_OUTCOMES)[number];

interface FeatureMessageMetadata {
  /** A manager's request, a worker's reply, or a note to the manager of
   *  what the user told its worker directly. */
  direction: "request" | "reply" | "note";
  featureId?: string;
  featureName?: string;
  /** A note's: who wrote (the user, or the user through their agent), what,
   *  and how many attachments stayed with the worker. */
  by?: "user" | "agent";
  text?: string;
  attachments?: number;
  /** A reply's, when the turn ended with no text: what happened, and the
   *  reason a failure or a repeated failing call gave. A reply with words
   *  has neither, as has every reply stored before 2026-10-10. */
  outcome?: FeatureReplyOutcome;
  detail?: string;
}

export function featureMessageRequestMetadata(): Record<string, unknown> {
  return {
    [FEATURE_MESSAGE_METADATA_KEY]: { direction: "request" }
  };
}

export function featureMessageReplyMetadata(input: {
  featureId: string;
  featureName?: string | null;
  outcome?: FeatureReplyOutcome;
  detail?: string;
}): Record<string, unknown> {
  return {
    [FEATURE_MESSAGE_METADATA_KEY]: {
      direction: "reply",
      featureId: input.featureId,
      ...(input.featureName?.trim() ? { featureName: input.featureName.trim() } : {}),
      ...(input.outcome ? { outcome: input.outcome } : {}),
      ...(input.outcome && input.detail ? { detail: input.detail } : {})
    }
  };
}

export function featureMessageNoteMetadata(input: {
  featureId: string;
  featureName: string;
  by: "user" | "agent";
  text: string;
  attachments: number;
}): Record<string, unknown> {
  return { [FEATURE_MESSAGE_METADATA_KEY]: { direction: "note", ...input } };
}

export function featureMessageMetadata(
  content: AgentMessageContent
): FeatureMessageMetadata | null {
  if (content.type !== "text") return null;
  const value = content.metadata?.[FEATURE_MESSAGE_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  if (metadata.direction !== "request" && metadata.direction !== "reply" && metadata.direction !== "note") return null;
  const outcome = REPLY_OUTCOMES.find((known) => known === metadata.outcome);
  return {
    direction: metadata.direction,
    ...(typeof metadata.featureId === "string" ? { featureId: metadata.featureId } : {}),
    ...(typeof metadata.featureName === "string" ? { featureName: metadata.featureName } : {}),
    ...(metadata.by === "user" || metadata.by === "agent" ? { by: metadata.by } : {}),
    ...(typeof metadata.text === "string" ? { text: metadata.text } : {}),
    ...(typeof metadata.attachments === "number" ? { attachments: metadata.attachments } : {}),
    ...(outcome ? { outcome } : {}),
    ...(outcome && typeof metadata.detail === "string" ? { detail: metadata.detail } : {})
  };
}

export function isFeatureMessageRequest(content: AgentMessageContent): boolean {
  return featureMessageMetadata(content)?.direction === "request";
}
