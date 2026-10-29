import type { ToolDefinition } from "../agent/tool-registry.js";
import { PageCopies } from "./page-copies.js";
import { buildWebFetchTool, newWebTextId } from "./web-fetch-tool.js";
import { buildWebSearchTool } from "./web-search-tool.js";
import { createWebSearch, type WebSearchDeps, type WebSearchService } from "./web-search.js";

/** The web tools every agent gets, built once: one search service reading
 *  the live config, and one set of kept pages. */
export interface WebTools {
  search: WebSearchService;
  tools: readonly ToolDefinition[];
}

export function createWebTools(deps: WebSearchDeps & { randomId?: () => string; copies?: PageCopies }): WebTools {
  const search = createWebSearch(deps);
  const randomId = deps.randomId ?? newWebTextId;
  const copies = deps.copies ?? new PageCopies();
  return {
    search,
    tools: [
      buildWebSearchTool({ web: search, randomId }) as ToolDefinition,
      buildWebFetchTool({ ...(deps.http ? { http: deps.http } : {}), copies, randomId }) as ToolDefinition
    ]
  };
}
