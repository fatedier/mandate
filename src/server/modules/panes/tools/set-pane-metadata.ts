import { z } from "zod";
import { requireWorkerToolContext, type ToolDefinition } from "../../agent/tool-registry.js";
import { paneInWorker } from "./pane-helpers.js";
import { params } from "./set-pane-metadata-schema.js";

interface Result {
  ok?: true;
  paneId?: string;
  error?: string;
}

export const setPaneMetadataTool: ToolDefinition<z.infer<typeof params>, Result> = {
  name: "set_pane_metadata",
  description:
    "Set or update the short name and purpose description for an existing pane of this worker. " +
    "Use this when a pane's role becomes clear or changes after creation. " +
    "Name should be short and stable, for example Codex, Tests, Dev server, or Scratch. " +
    "Description should explain the pane's intended purpose and whether it is safe to close.",
  parameters: params,
  handler: async ({ paneId, name, description }, ctx) => {
    const workerCtx = requireWorkerToolContext(ctx);
    if (!(await paneInWorker(paneId, ctx))) {
      return { error: `pane ${paneId} is not this worker's (scope check failed)` };
    }
    if (!workerCtx.paneMetadata) {
      return { error: "pane metadata store is not available" };
    }
    const metadata = workerCtx.paneMetadata.upsert({
      paneId,
      workerId: workerCtx.worker.id,
      sessionName: workerCtx.project.tmuxSessionName,
      windowName: workerCtx.worker.tmuxWindowName,
      name,
      description
    });
    return {
      ok: true,
      paneId: metadata.paneId
    };
  }
};
