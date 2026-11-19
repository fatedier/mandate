import { z } from "zod";
import { requireWorkerToolContext, type ToolDefinition } from "../../agent/tool-registry.js";
import { limitToolText } from "../../agent/tool-result-format.js";
import { params } from "./list-panes-schema.js";
interface PaneInfo {
  paneId: string;
  name?: string;
  description?: string;
  command: string;
  cwd: string;
  createdAt: string;
}
interface Result { panes: PaneInfo[] }

export const listPanesTool: ToolDefinition<z.infer<typeof params>, Result> = {
  name: "list_panes",
  description: "List this worker's panes.",
  parameters: params,
  handler: async (_args, ctx) => {
    const workerCtx = requireWorkerToolContext(ctx);
    const panes = await workerCtx.paneRuntime.listPanes(workerCtx.worker.id);
    return {
      panes: panes.map((p) => {
        const command = limitToolText(p.command.join(" "), 240);
        const cwd = limitToolText(p.cwd, 240);
        const metadata = workerCtx.paneMetadata?.get(p.id);
        return {
          paneId: p.id,
          ...(metadata?.name ? { name: metadata.name } : {}),
          ...(metadata?.description ? { description: metadata.description } : {}),
          command: command.text,
          ...(command.truncated ? { commandTruncated: true } : {}),
          cwd: cwd.text,
          ...(cwd.truncated ? { cwdTruncated: true } : {}),
          createdAt: p.spawnedAt
        };
      })
    };
  }
};
