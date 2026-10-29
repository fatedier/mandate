import type { AgentWakeUserErrorDto } from "../../../shared/api/agents.js";

/** A request rejection on a prompt that carried images may be the model
 *  refusing them: say which setting turns image input off. Nothing is learned
 *  or changed. `imageModel` is the model id when the failing
 *  step's prompt carried images. */
export function withImageHint(error: AgentWakeUserErrorDto, imageModel: string | undefined): string {
  if (!imageModel || error.category !== "invalid_request") return error.message;
  return `${error.message} The request included images. If ${imageModel} doesn't take images, turn off its Image input in Settings → Providers.`;
}
