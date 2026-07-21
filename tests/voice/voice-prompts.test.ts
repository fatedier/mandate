import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

function readPrompt(relpath: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, "../../src/server", relpath), "utf8");
}

test("voice base prompt avoids speaking machine-only details", () => {
  const prompt = readPrompt("modules/voice/prompts/voice-base.md");
  expect(prompt).toMatch(/Keep verbal answers short/);
  expect(prompt).toMatch(/Do not speak machine-only details aloud/);
  expect(prompt).toMatch(/UUIDs, session IDs, tool call IDs, wake IDs, pane IDs/);
  expect(prompt).toMatch(/long paths, raw JSON, or stack traces/);
});

test("voice async followup prompts require concise spoken summaries", () => {
  const managerPrompt = readPrompt("modules/voice/prompts/manager-dispatch-followup.md");
  const feature = readPrompt("modules/voice/prompts/worker-dispatch-followup.md");
  const failed = readPrompt("modules/voice/prompts/manager-dispatch-start-failed.md");

  expect(managerPrompt).toMatch(/Briefly tell the user/);
  expect(managerPrompt).toMatch(/Do not speak machine-only IDs/);
  expect(feature).toMatch(/Briefly tell the user/);
  expect(feature).toMatch(/Do not\s+speak the task id/);
  expect(failed).toMatch(/Summarize the error/);
  expect(failed).toMatch(/do not speak long IDs/);
});
