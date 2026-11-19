import { z } from "zod";
import { requireWorkerToolContext, type ToolDefinition } from "../../agent/tool-registry.js";
import { paneInWorker } from "./pane-helpers.js";
import { errorText } from "../../../../shared/error-text.js";
import { projectWork } from "../../projects/project-work.js";
import { params } from "./spawn-pane-schema.js";
interface Result {
  paneId?: string;
  error?: string;
}

/** The most panes a worker's window holds before spawn_pane refuses: a
 *  worker that opens a pane for every task and closes none fills its window,
 *  and most workers never need more. */
export const MAX_WORKER_PANES = 6;

export const spawnPaneTool: ToolDefinition<z.infer<typeof params>, Result> = {
  name: "spawn_pane",
  description:
    "Create a new shell terminal pane for this worker. This tool " +
    "does not accept a command. To run a command, first create the " +
    "pane, then call send_keys on the returned paneId. " +
    "Use this tool instead of raw tmux split-window/new-window " +
    "commands for Mandate-managed panes; it returns the correct " +
    "paneId for follow-up calls. " +
    "Optional direction controls the split direction. Optional targetPaneId " +
    "chooses which existing pane to split; if omitted, Mandate splits the " +
    "largest pane and chooses a sensible direction to avoid tiny panes. " +
    "Optional name and description record the pane's intended purpose for " +
    "future status analysis and UI labels. Use a short stable name such as " +
    "Codex, Tests, Dev server, or Scratch. " +
    "Use only when the user asks for a new pane or no suitable pane " +
    "exists. cwd defaults to the worker's working dir.",
  parameters: params,
  handler: async ({ cwd, direction, targetPaneId, name, description }, ctx) => {
    const workerCtx = requireWorkerToolContext(ctx);
    if (targetPaneId && !(await paneInWorker(targetPaneId, ctx))) {
      return { error: `target pane ${targetPaneId} is not this worker's (scope check failed)` };
    }
    // In the project's turn: the split may rebuild the worker's window, which
    // a create, archive or restore of a worker may be changing, and the pane
    // count is read before the split adds one.
    return projectWork.run(workerCtx.worker.projectId, async () => {
      try {
        const panes = await workerCtx.paneRuntime.listPanes(workerCtx.worker.id);
        if (panes.length >= MAX_WORKER_PANES) {
          const lines = panes.map((pane) => {
            const name = workerCtx.paneMetadata?.get(pane.id)?.name || pane.command.join(" ") || "(shell)";
            const seen = workerCtx.analyzer?.getCachedAnalysis(pane.id)?.status;
            // A listed pane is live: tmux lists no other kind.
            return `- ${pane.id} ${name}: ${seen && seen !== "unknown" ? seen : "running"}`;
          });
          return {
            error: `This worker already has ${panes.length} panes, the most it keeps. Reuse a pane that is free, ` +
              `or close one whose work is done with kill_pane, then try again.\n${lines.join("\n")}`
          };
        }
        const pane = await workerCtx.paneRuntime.spawnPane({
          workerId: workerCtx.worker.id,
          // Without one, where the worker works when the split runs: its
          // folder may have moved since this turn began.
          ...(cwd ? { cwd } : {}),
          direction,
          targetPaneId
        });
        if (name !== undefined || description !== undefined) {
          workerCtx.paneMetadata?.upsert({
            paneId: pane.id,
            workerId: workerCtx.worker.id,
            sessionName: workerCtx.project.tmuxSessionName,
            windowName: workerCtx.worker.tmuxWindowName,
            name,
            description
          });
        }
        return {
          paneId: pane.id
        };
      } catch (e: unknown) {
        return { error: errorText(e) };
      }
    });
  }
};
