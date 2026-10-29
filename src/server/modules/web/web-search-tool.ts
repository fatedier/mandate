import { z } from "zod";
import { TOOL_CALL_STOPPED, type ToolDefinition } from "../agent/tool-registry.js";
import { formatSearchText } from "../../../shared/web-tool-text.js";
import type { WebSearchService } from "./web-search.js";

const params = z.object({
  query: z.string().min(1).describe("What to find, written as you would ask a person.")
});

/** `web_search`, on the backend chosen in Settings. Offered only while one
 *  is chosen and set up: with search off an agent is never shown it. */
export function buildWebSearchTool(deps: { web: WebSearchService; randomId: () => string }): ToolDefinition<z.infer<typeof params>, string> {
  return {
    name: "web_search",
    description: "Search the web. Returns what the search found: the pages, each with its address and a short excerpt, and an answer written from them when the search gives one. Use it for information that may be newer than what you know or that needs a source; read a page with `web_fetch` when an excerpt is not enough.",
    parameters: params,
    available: () => deps.web.chosen() !== null,
    handler: async ({ query }, ctx) => {
      if (ctx.signal?.aborted) throw new Error(TOOL_CALL_STOPPED);
      try {
        const { backend, findings, ms } = await deps.web.search(query, {
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          record: { scopeType: "agent_thread", scopeId: ctx.threadId }
        });
        return formatSearchText({
          ...(findings.answer ? { answer: findings.answer } : {}),
          results: findings.results,
          backend,
          ms,
          id: deps.randomId()
        });
      } catch (error) {
        if (ctx.signal?.aborted) throw new Error(TOOL_CALL_STOPPED);
        throw error;
      }
    }
  };
}
