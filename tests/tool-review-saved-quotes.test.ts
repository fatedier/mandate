import { afterEach, beforeEach, expect, test } from "bun:test";
import { MemoryManager } from "../src/server/modules/memory/manager.js";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { savedDecisionQuotes } from "../src/server/modules/tool-review/saved-quotes.js";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";

// The second look reads the decisions the user saved in their own words that
// bear on the call: preferences carrying the user's quote, found by a memory
// search on what the call does.

let env: StoresEnv;
beforeEach(() => { env = freshStoresEnv("md-tool-review-saved-"); });
afterEach(() => env.cleanup());

test("the user's quoted preferences that bear on the call are its saved decisions", async () => {
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
  await memory.remember({ scope: "user", type: "preference", source: "user", userQuote: "Pushing my own feature branches is fine.", content: "The user lets agents push their own feature branches." });
  // No quote: what an agent noted is not the user's words.
  await memory.remember({ scope: "user", type: "preference", source: "agent", content: "Agents push feature branches after tests pass." });
  await memory.remember({ scope: "user", type: "knowledge", source: "user", userQuote: "The push hook lints the code.", content: "A push hook lints the code." });
  await memory.remember({ scope: "user", type: "preference", source: "user", userQuote: "Keep commit messages short.", content: "Commit messages stay short." });
  const quotes = await savedDecisionQuotes(memory)({ toolCallId: "c1", toolName: "bash", args: { command: "git push origin feature/cache" } }, null);
  expect(quotes).toEqual(["Pushing my own feature branches is fine."]);
});

test("a project's saved decisions count only for calls in that project", async () => {
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
  await memory.remember({ scope: "project", projectId: "proj_sandbox", type: "preference", source: "user", userQuote: "Force-pushing main is fine here.", content: "Force-pushing main is fine in the sandbox." });
  await memory.remember({ scope: "user", type: "preference", source: "user", userQuote: "Never force-push main.", content: "Never force-push main anywhere." });
  const push = { toolCallId: "c1", toolName: "bash", args: { command: "git push --force origin main" } };
  expect(await savedDecisionQuotes(memory)(push, "proj_production")).toEqual(["Never force-push main."]);
  expect(await savedDecisionQuotes(memory)(push, null)).toEqual(["Never force-push main."]);
  expect((await savedDecisionQuotes(memory)(push, "proj_sandbox")).sort()).toEqual(["Force-pushing main is fine here.", "Never force-push main."]);
});

test("both searches start at once: none starts after the review has moved on", () => {
  const started: string[] = [];
  const memory = { search: (input: { scope?: string }) => { started.push(input.scope ?? "all"); return new Promise<never>(() => {}); } };
  void savedDecisionQuotes(memory as never)({ toolCallId: "c1", toolName: "bash", args: { command: "git push origin main" } }, "proj_shop");
  expect(started.sort()).toEqual(["project", "user"]);
});
