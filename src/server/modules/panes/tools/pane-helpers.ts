/** Verify the given paneId belongs to the current worker. */
import { requireWorkerToolContext, type ToolContext } from "../../agent/tool-registry.js";

export async function paneInWorker(paneId: string, ctx: ToolContext): Promise<boolean> {
  const workerCtx = requireWorkerToolContext(ctx);
  const panes = await workerCtx.paneRuntime.listPanes(workerCtx.worker.id);
  return panes.some((p) => p.id === paneId);
}
