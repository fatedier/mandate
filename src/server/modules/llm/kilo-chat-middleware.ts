import type { LanguageModelMiddleware } from "ai";

/** OpenRouter's effort values; Mandate's `max` is its `xhigh`. */
const OPENROUTER_EFFORT: Record<string, string> = {
  none: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh"
};

type WithOptions = { providerOptions?: Record<string, unknown> };

function withoutAnthropic<T extends WithOptions>(item: T): T {
  if (!item.providerOptions || !("anthropic" in item.providerOptions)) return item;
  const { anthropic: _dropped, ...rest } = item.providerOptions;
  return { ...item, providerOptions: rest };
}

/**
 * A Kilo model on Chat runs through OpenRouter's SDK, which would send the
 * Anthropic cache marks Mandate puts on a step's messages (it reads
 * `providerOptions.anthropic.cacheControl`) and ignores the AI SDK's own
 * `reasoning` option. This drops the Anthropic options from the prompt and
 * puts the effort where OpenRouter's SDK reads it.
 */
export const kiloChatMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v4",
  transformParams: async ({ params }) => {
    const prompt = params.prompt.map((message) => {
      const content = Array.isArray(message.content)
        ? (message.content as WithOptions[]).map(withoutAnthropic)
        : message.content;
      return withoutAnthropic({ ...message, content } as typeof message & WithOptions);
    }) as typeof params.prompt;
    const effort = params.reasoning ? OPENROUTER_EFFORT[params.reasoning] : undefined;
    const openrouter = (params.providerOptions?.openrouter ?? {}) as Record<string, unknown>;
    const providerOptions = effort && !openrouter.reasoning
      ? { ...params.providerOptions, openrouter: { ...openrouter, reasoning: { effort } } }
      : params.providerOptions;
    return { ...params, prompt, ...(providerOptions ? { providerOptions } : {}) };
  }
};
