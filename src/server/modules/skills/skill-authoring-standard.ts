import { renderPromptFile } from "../../platform/prompts/prompt-template.js";
import standardPath from "./prompts/skill-authoring-standard.md" with { type: "file" };

/** A skill writer's prompt, with the one authoring standard every writer
 *  follows in its place. */
export function skillPrompt(promptPath: string): string {
  return renderPromptFile(promptPath, { authoringStandard: renderPromptFile(standardPath).trim() }).trim();
}
