import { expect, test } from "bun:test";
import { voiceDialogueItem } from "../src/server/modules/voice/voice-session-messages.js";
import { agentMessage } from "./helpers/typed.js";

// The voice conversation is preloaded with what was said; notes about Your
// agent's page are for the model, never something the user said.
test("page answers and page results are not voice dialogue; the user's own words are", () => {
  const said = (source: "user" | "page-input" | "page-result", text: string) =>
    agentMessage({ id: source, role: "user", source, content: { type: "text", text } });
  expect(voiceDialogueItem(said("user", "Push it."))).toEqual({ role: "user", text: "Push it." });
  expect(voiceDialogueItem(said("page-input", "[Page answer, 10:01] {\"pick\":\"c\"}"))).toBeNull();
  expect(voiceDialogueItem(said("page-result", "[Page] Version 2, from the page subagent “Tidy”: Done."))).toBeNull();
});
