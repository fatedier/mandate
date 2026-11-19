import { z } from "zod";
import { requireWorkerToolContext, type ToolDefinition } from "../../agent/tool-registry.js";
import { paneInWorker } from "./pane-helpers.js";
import { errorText } from "../../../../shared/error-text.js";
import { params } from "./send-keys-schema.js";
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
    const workerCtx = requireWorkerToolContext(ctx);
    if (!(await paneInWorker(paneId, ctx))) {
      return { error: `pane ${paneId} is not this worker's (scope check failed)` };
    }
    try {
      await workerCtx.paneRuntime.sendKeys(paneId, args);
      return { ok: true };
    } catch (e: unknown) {
      return { error: errorText(e) };
    }
  }
};
