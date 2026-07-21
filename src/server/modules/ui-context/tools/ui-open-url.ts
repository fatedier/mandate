import { z } from "zod";
import type { ToolDefinition } from "../../agent/tool-registry.js";
import { UI_ACTIONS } from "../../../../shared/api-contracts.js";

const params = z.object({
  url: z.string().refine((value) => {
    try {
      const u = new URL(value);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch { return false; }
  }, "must be an http(s) URL")
});

export function buildUiOpenUrlTool(
  emit: (action: string, payload: unknown) => void
): ToolDefinition<z.infer<typeof params>, { ok: true }> {
  return {
    name: "ui_open_url",
    description:
      "Open an external http(s) URL in a new browser tab. Use for documentation, " +
      "issue trackers, or other web resources outside Mandate.",
    parameters: params,
    approval: "never",
    handler: async ({ url }) => {
      emit(UI_ACTIONS.openUrl, { url });
      return { ok: true };
    }
  };
}
