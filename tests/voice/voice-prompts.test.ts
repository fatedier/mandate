import { expect, test } from "bun:test";
import { buildVoiceInstructions } from "../../src/server/app/voice.js";

const instructions = (language: string) => buildVoiceInstructions({ name: "Mandate", language, skillsManifest: "", memorySection: "" });

test("voice instructions keep answers short and machine-only details out of speech", () => {
  const text = instructions("auto");
  expect(text).toMatch(/one or two short sentences/);
  expect(text).toMatch(/Do not say machine-only details aloud unless asked/);
  expect(text).toMatch(/no ids, hashes, long numbers, token counts, long paths, raw JSON or stack traces/);
});

// Nothing is asked before work goes to a thread.
test("spoken or typed, work goes to a thread without a question, then is said in one sentence", () => {
  expect(instructions("auto")).toMatch(/send it with send_to_thread without asking first, then say in one sentence where it went/);
});

test("a set language becomes a reply directive; auto adds none", () => {
  expect(instructions("Chinese")).toContain("Reply in Chinese unless the user explicitly switches");
  expect(instructions("auto")).not.toContain("Reply in");
  expect(instructions("Automatic")).not.toContain("Reply in");
});
