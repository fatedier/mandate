/**
 * A streaming test model whose output comes with pauses: before each part it
 * waits its gap (ms), then streams a reasoning delta, or with `as: "raw"` a provider
 * delta only (what the Open Responses package holds back while a tool call's
 * arguments stream); then the text whole and a stop. A gap longer than an idle
 * guard's window is a stall; `gaps: [Infinity]` never answers. An abort ends
 * the stream with its reason.
 */
export function pacedModel(opts: { gaps: number[]; text: string; as?: "text" | "raw"; openResponses?: boolean }) {
  const calls: number[] = [];
  /** Whether a stream was aborted, set the moment its signal fires. */
  const seen = { aborted: false };
  return {
    calls,
    seen,
    specificationVersion: "v4" as const,
    provider: opts.openResponses ? "openResponses.responses" : "paced.chat",
    modelId: "deepseek/deepseek-v4-flash",
    supportedUrls: {},
    doGenerate: async () => { throw new Error("streams only"); },
    doStream: async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
      calls.push(Date.now());
      abortSignal?.addEventListener("abort", () => { seen.aborted = true; }, { once: true });
      return {
        stream: new ReadableStream({
          async start(controller) {
            const wait = (ms: number) => new Promise<void>((resolve) => {
              if (ms === Infinity) { abortSignal?.addEventListener("abort", () => resolve(), { once: true }); return; }
              const timer = setTimeout(resolve, ms);
              abortSignal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
            });
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "reasoning-start", id: "r" });
            for (const gap of opts.gaps) {
              await wait(gap);
              if (abortSignal?.aborted) { controller.error(abortSignal.reason); return; }
              controller.enqueue(opts.as === "raw"
                ? { type: "raw", rawValue: { type: "response.function_call_arguments.delta", delta: "x" } }
                : { type: "reasoning-delta", id: "r", delta: " Still reading." });
            }
            controller.enqueue({ type: "reasoning-end", id: "r" });
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({ type: "text-delta", id: "t", delta: opts.text });
            controller.enqueue({ type: "text-end", id: "t" });
            controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } });
            controller.close();
          }
        })
      };
    }
  };
}
