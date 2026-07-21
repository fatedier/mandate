import { z } from "zod";
import type { ToolDefinition } from "../../agent/tool-registry.js";
import type { UiContextRegistry } from "../ui-context-registry.js";

const params = z.object({
  timeoutMs: z.number().int().min(100).max(5000).optional().describe(
    "Optional timeout in milliseconds. Defaults to 1500 and is capped at 5000."
  )
});

type UiReadPageSummaryResult =
  | { ok: true; summary: unknown }
  | { ok: false; error: string };

export function buildUiReadPageSummaryTool(
  uiContextRegistry: UiContextRegistry
): ToolDefinition<z.infer<typeof params>, UiReadPageSummaryResult> {
  return {
    name: "ui_read_page_summary",
    description:
      "Read the current user's visible Mandate page summary. This does not scrape DOM text; " +
      "it asks the frontend for a structured, page-registered summary such as route, filters, " +
      "selected ids, loaded item counts, and similar UI state. Use this when the user refers to " +
      "'this page', 'the selected call', 'what I am looking at', or other visible Mandate UI context.",
    parameters: params,
    approval: "never",
    handler: async ({ timeoutMs }, ctx) => {
      const response = await uiContextRegistry.requestPageSummary(ctx.threadId, timeoutMs);
      if (!response.ok) {
        return { ok: false, error: response.error ?? "Unable to read page summary." };
      }
      return { ok: true, summary: response.summary };
    }
  };
}
