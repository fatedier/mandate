import { anthropicThinkingIsAdaptive } from "../../llm/ai-sdk-model-factory.js";

/**
 * Whether a model's wake steps take part in cache sealing. Claude first: a
 * model that runs as the Anthropic family —
 * the test that gives it cache marks, decided by its API, never its name —
 * and whose steps think adaptively or not at all. With a fixed thinking
 * budget the SDK adds the budget to the output cap, so a one-token seal would
 * think the whole budget: such a model keeps hour-long marks.
 */
export function sealParticipates(candidate: { meta?: { provider?: string; model?: string; supportsReasoning?: boolean } }): boolean {
  const meta = candidate.meta;
  if (meta?.provider !== "anthropic" || !meta.model) return false;
  return meta.supportsReasoning === false || anthropicThinkingIsAdaptive(meta.model);
}
