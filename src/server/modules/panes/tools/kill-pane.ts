import { z } from "zod";
import { requireWorkerToolContext, type ToolDefinition } from "../../agent/tool-registry.js";
import { paneInWorker } from "./pane-helpers.js";
import { errorText } from "../../../../shared/error-text.js";
import { params } from "./kill-pane-schema.js";
interface Result {
  ok?: boolean;
  error?: string;
}

export const killPaneTool: ToolDefinition<z.infer<typeof params>, Result> = {
  name: "kill_pane",
  description:
    "Close one of this worker's panes; what runs in it ends with it. " +
    "Use this tool instead of raw tmux kill-pane for Mandate-managed " +
    "panes so scope checks stay intact.",
  parameters: params,
  handler: async ({ paneId }, ctx) => {
    const workerCtx = requireWorkerToolContext(ctx);
    if (!(await paneInWorker(paneId, ctx))) {
      return { error: `pane ${paneId} is not this worker's (scope check failed)` };
    }
    try {
      await workerCtx.paneRuntime.killPane(paneId);
      return { ok: true };
    } catch (e: unknown) {
      return { error: errorText(e) };
    }
  }
};
