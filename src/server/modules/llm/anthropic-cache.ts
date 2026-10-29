import type { ModelMessage } from "ai";

/**
 * Anthropic caches a prompt only up to a block marked with cache_control (at
 * most four marks a request; each finds an earlier entry at most 20 blocks
 * back). A wake step marks three: the system instruction (with the tools
 * before it), the end of the previous step's prompt (the message before the
 * latest assistant message: read whole, however much the step after it
 * added), and the last message (written for the next step). An hour, not the
 * default five minutes: a turn often waits longer than that between steps (a
 * reply, a monitor), and a step after such a wait would write it all again.
 */
export const ANTHROPIC_CACHE_CONTROL = { type: "ephemeral", ttl: "1h" } as const;

/** Five minutes: a step whose cache a seal keeps writes its messages for
 *  this long; the seal writes the end of a quiet thread for an hour. */
export const ANTHROPIC_SHORT_CACHE_CONTROL = { type: "ephemeral", ttl: "5m" } as const;

export type AnthropicCacheTtl = "5m" | "1h";

const CACHE_CONTROL: Record<AnthropicCacheTtl, typeof ANTHROPIC_CACHE_CONTROL | typeof ANTHROPIC_SHORT_CACHE_CONTROL> = {
  "1h": ANTHROPIC_CACHE_CONTROL,
  "5m": ANTHROPIC_SHORT_CACHE_CONTROL
};

/** The step's messages with the two message marks, each kept for `ttl`; the
 *  system one is set where the system instruction is built. */
export function withAnthropicCacheBreakpoints(messages: readonly ModelMessage[], ttl: AnthropicCacheTtl = "1h"): ModelMessage[] {
  const marked = new Set<number>();
  if (messages.length > 0) marked.add(messages.length - 1);
  const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");
  if (lastAssistant > 0) marked.add(lastAssistant - 1);
  return messages.map((message, index) => (marked.has(index) ? withAnthropicMark(message, ttl) : message));
}

/** The message marked for caching up to its end, kept for `ttl`. */
export function withAnthropicMark(message: ModelMessage, ttl: AnthropicCacheTtl): ModelMessage {
  const options = message.providerOptions ?? {};
  return {
    ...message,
    providerOptions: { ...options, anthropic: { ...(options.anthropic ?? {}), cacheControl: CACHE_CONTROL[ttl] } }
  } as ModelMessage;
}

/** The messages with every cache mark taken off; their other provider
 *  options stay. An Anthropic key left empty goes, and provider options left
 *  empty go too: a message marked and unmarked is the message never marked. */
export function withoutAnthropicCacheMarks(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    const anthropic = message.providerOptions?.anthropic;
    if (!anthropic || !("cacheControl" in anthropic)) return message;
    const { cacheControl: _mark, ...rest } = anthropic;
    const { anthropic: _old, ...others } = message.providerOptions!;
    const options = Object.keys(rest).length > 0 ? { ...others, anthropic: rest } : others;
    const { providerOptions: _all, ...bare } = message;
    return (Object.keys(options).length > 0 ? { ...bare, providerOptions: options } : bare) as ModelMessage;
  });
}
