/** The API a model call speaks: Anthropic's Messages, OpenAI's Responses,
 *  Chat Completions, or Google's Gemini API. */
export type LlmApi = "messages" | "responses" | "chat" | "gemini";

/**
 * Whether a model id names one of OpenAI's own hosted models, which stay on
 * `@ai-sdk/openai`. By name: an `openai/` vendor (a Kilo alias's leading `~`
 * aside), or a GPT, ChatGPT, Codex or o-series id. OpenAI's open-weight
 * gpt-oss is served only by others and returns raw reasoning: not hosted.
 * Shared: the server picks the package by it, Settings a model's cache family.
 */
export function isOpenAiModelId(modelId: string): boolean {
  const segments = modelId.trim().toLowerCase().replace(/^~/, "").split("/");
  const last = segments.at(-1) ?? "";
  if (last.startsWith("gpt-oss")) return false;
  return segments[0] === "openai" ||
    last.startsWith("gpt-") ||
    last.startsWith("chatgpt") ||
    last.startsWith("codex") ||
    /^o\d/.test(last);
}

/** Which default prompt-cache lifetime a model has, by the family it runs as
 *  (the provider model resolution gives it): the Anthropic family Claude's
 *  hour; OpenAI's own models (an OpenAI connection, or a custom one serving
 *  an OpenAI id) GPT's 30 minutes; any other none. The server's rule, and the
 *  one Settings shows. */
export type CacheFamily = "claude" | "gpt" | "other";

export function cacheFamilyOf(runsAs: string | undefined, modelId: string): CacheFamily {
  if (runsAs === "anthropic") return "claude";
  if (runsAs === "openai" || (runsAs === "openai-compatible" && isOpenAiModelId(modelId))) return "gpt";
  return "other";
}
