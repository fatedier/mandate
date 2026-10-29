import { z } from "zod";
import { requireFeatureToolContext, type ToolDefinition } from "../../agent/tool-registry.js";
import { paneInFeature } from "./pane-helpers.js";
import { errorText } from "../../../../shared/error-text.js";

const params = z.object({
  paneId: z.string(),
  args: z.array(z.string()).min(1),
  // Read by the chat, not by the handler: keys like ["C-c"] say what was
  // pressed, not why. Optional, and asked for as bash's is.
  description: z.string().optional().describe(
    "What these keys do, in active voice and plain words. The user reads this in place of the " +
    "keys, so do not repeat them or the text typed; say what it is for. Keep it brief, 5-10 words: " +
    "[\"C-c\"] -> \"Stop the dev server\"; [\"-l\", \"bun run dev --port 4180\"] -> " +
    "\"Type the command to start the dev server\"; [\"Enter\"] after it -> \"Start the dev server\"; " +
    "[\"-l\", \"Review the uncommitted changes\"] to an agent -> \"Type a review request for Codex\"; " +
    "[\"Enter\"] after it -> \"Submit the review request\"; " +
    "[\"y\", \"Enter\"] -> \"Confirm the prompt\"."
  )
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
  handler: async ({ paneId, args }, ctx) => {
    const featureCtx = requireFeatureToolContext(ctx);
    if (!(await paneInFeature(paneId, ctx))) {
      return { error: `pane ${paneId} is not in this feature (scope check failed)` };
    }
    try {
      await featureCtx.paneRuntime.sendKeys(paneId, args);
      return { ok: true };
    } catch (e: unknown) {
      return { error: errorText(e) };
    }
  }
};
