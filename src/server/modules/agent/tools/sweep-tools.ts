import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";

/** What the sweep timer needs to expose. Kept to two methods so the tool can be
 *  tested without a heartbeat, and so the heartbeat's other state stays private. */
export interface SweepController {
  endSweep(): void;
  isEnded(): boolean;
}

const endSweepParams = z.object({
  reason: z.string().min(1).max(300).describe(
    "One line on why nothing is outstanding — recorded so a later reader knows what you concluded."
  )
});

interface EndSweepResult {
  ended: true;
  reason: string;
}

/**
 * The overview agent's way of saying it looked and found nothing.
 *
 * This has to be an explicit call. "Did nothing this turn" and "checked and
 * confirmed nothing needs doing" are the same thing from the runtime's side;
 * the call is what separates a conclusion from an omission.
 *
 * There is no matching `start_sweep`. The sweep resumes on the next work-item
 * change, so nothing has to remember to turn it back on.
 */
export function buildEndSweepTool(controller: SweepController): ToolDefinition<
  z.infer<typeof endSweepParams>,
  EndSweepResult
> {
  return {
    name: "end_sweep",
    description:
      "Stop the periodic stall sweep. Call this only when every feature is either " +
      "finished, moving, or waiting on the user. You will not be woken by the sweep " +
      "again until new work arrives. If anything is still outstanding, do NOT call " +
      "this — do nothing instead and you will be woken again to check.",
    parameters: endSweepParams,
    approval: "never",
    handler: async (input) => {
      controller.endSweep();
      return { ended: true, reason: input.reason };
    }
  };
}

export function buildSweepTools(controller: SweepController): ToolDefinition[] {
  return [buildEndSweepTool(controller)];
}
