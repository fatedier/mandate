import { z } from "zod";
import { requireFeatureToolContext, type ToolDefinition } from "../../agent/tool-registry.js";
import { limitToolText } from "../../agent/tool-result-format.js";

const params = z.object({});
interface PaneInfo {
  paneId: string;
  name?: string;
  description?: string;
  command: string;
  cwd: string;
  status: string;
  createdAt: string;
}
interface Result { panes: PaneInfo[] }

export const listPanesTool: ToolDefinition<z.infer<typeof params>, Result> = {
  name: "list_panes",
  description: "List panes in this feature.",
  parameters: params,
  approval: "never",
  handler: async (_args, ctx) => {
    const featureCtx = requireFeatureToolContext(ctx);
    const panes = await featureCtx.paneRuntime.listPanes(featureCtx.feature.id);
    return {
      panes: panes.map((p) => {
        const command = limitToolText(p.command.join(" "), 240);
        const cwd = limitToolText(p.cwd, 240);
        const metadata = featureCtx.paneMetadata?.get(p.id);
        return {
          paneId: p.id,
          ...(metadata?.name ? { name: metadata.name } : {}),
          ...(metadata?.description ? { description: metadata.description } : {}),
          command: command.text,
          ...(command.truncated ? { commandTruncated: true } : {}),
          cwd: cwd.text,
          ...(cwd.truncated ? { cwdTruncated: true } : {}),
          status: p.status,
          createdAt: p.spawnedAt
        };
      })
    };
  }
};
