import { z } from "zod";
import { requireFeatureToolContext, type ToolDefinition } from "../../agent/tool-registry.js";
import { paneInFeature } from "./pane-helpers.js";

const params = z.object({
  paneId: z.string(),
  args: z.array(z.string()).min(1)
});
interface Result {
  ok?: true;
  error?: string;
}

export const sendKeysTool: ToolDefinition<z.infer<typeof params>, Result> = {
  name: "send_keys",
  description:
    "Run tmux send-keys against an existing user-visible terminal pane. " +
    "Mandate adds the scoped target pane (`-t <paneId>`); `args` are passed " +
    "directly as tmux send-keys arguments, so do not include `-t` or " +
    "`--target-pane` before a `--` terminator. Examples: args=[\"codex\", \"Enter\"], " +
    "args=[\"-l\", \"literal text with spaces\"], args=[\"C-c\"]. " +
    "For a complete instruction to codex, claude, aider, or another " +
    "interactive terminal agent, send the literal text with args=[\"-l\", " +
    "\"...\"] and then submit with a second call args=[\"Enter\"], unless " +
    "the user explicitly asked only to type without submitting.",
  parameters: params,
  approval: "never",
  handler: async ({ paneId, args }, ctx) => {
    const featureCtx = requireFeatureToolContext(ctx);
    if (!(await paneInFeature(paneId, ctx))) {
      return { error: `pane ${paneId} is not in this feature (scope check failed)` };
    }
    try {
      await featureCtx.paneRuntime.sendKeys(paneId, args);
      return { ok: true };
    } catch (e: unknown) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
};
