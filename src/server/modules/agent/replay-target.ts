import type { LanguageModel, ModelMessage } from "ai";
import type { ReasoningEffort } from "../../../shared/settings.js";
import { withAnthropicCacheBreakpoints, type AnthropicCacheTtl } from "../llm/anthropic-cache.js";
import { isOpenResponsesModel, needsReasoningPlaceholder, OPEN_RESPONSES_NAME } from "../llm/open-responses-model.js";
import type { ReplayTarget } from "./wake-message-adapter.js";

/** A model a step may go to, as the wake loop and the memory dream name it. */
export interface ReplayCandidate {
  model: LanguageModel;
  meta?: { provider?: string; model?: string; reasoningEffort?: ReasoningEffort; supportsReasoning?: boolean };
}

/** What a candidate model takes back of earlier steps (assistantMessagesForModel),
 *  and a key that is the same for every candidate that takes the same history. */
export function replayTargetFor(candidate: ReplayCandidate): { target: ReplayTarget; key: string } {
  const replayTo = candidate.meta?.model;
  // A model that needs its reasoning back gets a placeholder on the steps
  // other models wrote (open-responses-model.ts).
  const placeholder = replayTo !== undefined && needsReasoningPlaceholder(candidate.model, candidate.meta ?? {});
  // The package reads a step's stored state under its own name.
  const stateKey = isOpenResponsesModel(candidate.model) ? OPEN_RESPONSES_NAME : undefined;
  return {
    target: {
      ...(replayTo ? { replayTo } : {}),
      ...(placeholder ? { reasoningPlaceholderFor: replayTo } : {}),
      ...(stateKey ? { providerStateKey: stateKey } : {})
    },
    key: `${replayTo ?? ""}\0${placeholder}\0${stateKey ?? ""}`
  };
}

/** A step's messages as this candidate caches them: Anthropic caches only up
 *  to a marked block, kept for `ttl`; the others cache by prefix. */
export function withCacheMarksFor(candidate: ReplayCandidate, messages: ModelMessage[], ttl: AnthropicCacheTtl = "1h"): ModelMessage[] {
  return candidate.meta?.provider === "anthropic" ? withAnthropicCacheBreakpoints(messages, ttl) : messages;
}
