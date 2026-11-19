import { expect, test } from "bun:test";
import { formatStartupModelLines } from "../src/server/app/startup-log.js";
import { loadConfig, type JsonObject } from "../src/server/config.js";
import { flatConfigStore } from "./helpers/config-file.js";

test("formatStartupModelLines lists each model role explicitly", () => {
  const config = loadConfig(
    undefined,
    flatConfigStore({
      models: {
        default: {
          model: "codex/gpt-5.5"
        },
        providers: {
          codex: { type: "codex" },
          openai: { type: "openai", apiKey: "sk-test" }
        }
      },
      agent: {
        managerModel: "codex/gpt-5.5",
        workerModel: "openai/gpt-5.5",
        dreamModel: "openai/gpt-5.5"
      },
      voice: {
        provider: "codex",
        model: "gpt-realtime-2",
        voice: "marin"
      },
      memory: {
        embedding: {
          model: "openai/text-embedding-3-small"
        }
      }
    })
  );

  expect(formatStartupModelLines(config)).toEqual([
    "Models:",
    "  Agent manager: codex/gpt-5.5",
    "  Agent worker: openai/gpt-5.5",
    "  Personal agent: codex/gpt-5.5",
    "  Subagents: the asking agent's route",
    "  Page updates: the subagents' route",
    "  Skill review: the Dream's route (openai/gpt-5.5)",
    "  Manager request check: off",
    "  Manager stop check: off",
    "  Memory repeat check: off",
    "  Tool-call review: off",
    "  Dream: openai/gpt-5.5",
    "  Memory extraction: codex/gpt-5.5",
    "  Voice: codex/gpt-realtime-2 (marin)",
    "  Memory embedding: openai/text-embedding-3-small"
  ]);
});

test("a subagent route that is set is logged as its model, even the default's own; unset, as the asking agent's route", () => {
  const subagentLine = (agent: JsonObject) => formatStartupModelLines(loadConfig(undefined, flatConfigStore({
    models: { default: { model: "codex/gpt-5.5" }, providers: { codex: { type: "codex" }, openai: { type: "openai", apiKey: "sk-test" } } },
    agent
  }))).find((line) => line.startsWith("  Subagents:"));
  expect(subagentLine({ subagentModel: "openai/gpt-5.5" })).toBe("  Subagents: openai/gpt-5.5");
  expect(subagentLine({ subagentModel: "codex/gpt-5.5" })).toBe("  Subagents: codex/gpt-5.5");
  expect(subagentLine({})).toBe("  Subagents: the asking agent's route");
});

test("the manager stop check is logged as its first model while it runs, else off", () => {
  const stopLine = (agent: JsonObject) => formatStartupModelLines(loadConfig(undefined, flatConfigStore({
    models: { default: { model: "codex/gpt-5.5" }, providers: { codex: { type: "codex" }, openai: { type: "openai", apiKey: "sk-test" } } },
    agent
  }))).find((line) => line.startsWith("  Manager stop check:"));
  expect(stopLine({ decisionsEnabled: true, decisionsModel: "openai/gpt-5.5" })).toBe("  Manager stop check: off");
  expect(stopLine({ decisionsEnabled: true, decisionsModel: "openai/gpt-5.5", managerStopCheckEnabled: true })).toBe("  Manager stop check: openai/gpt-5.5");
  const repeatLine = (agent: JsonObject) => formatStartupModelLines(loadConfig(undefined, flatConfigStore({
    models: { default: { model: "codex/gpt-5.5" }, providers: { codex: { type: "codex" }, openai: { type: "openai", apiKey: "sk-test" } } },
    agent
  }))).find((line) => line.startsWith("  Memory repeat check:"));
  expect(repeatLine({ decisionsEnabled: true, decisionsModel: "openai/gpt-5.5" })).toBe("  Memory repeat check: off");
  expect(repeatLine({ decisionsEnabled: true, decisionsModel: "openai/gpt-5.5", memoryRepeatCheckEnabled: true })).toBe("  Memory repeat check: openai/gpt-5.5");
});

// The review's line names the screen's first model and the second look's, and
// says off while it is off or has no second look to run on.
test("the startup log says how the tool-call review runs, or that it is off", () => {
  const reviewLine = (agent: JsonObject) => formatStartupModelLines(loadConfig(undefined, flatConfigStore({
    models: {
      default: { model: "codex/gpt-5.5" },
      providers: {
        codex: { type: "codex" },
        gw: { type: "openai-compatible", baseURL: "https://gw.example/v1", apiKey: "sk-test", models: [{ id: "judge-1", input: ["text"], kind: "decision" }, { id: "flash", input: ["text"] }] }
      }
    },
    agent
  }))).find((line) => line.startsWith("  Tool-call review:"));
  const decisions = { decisionsEnabled: true, decisionsModel: "gw/judge-1", decisionsModelFallbacks: [{ model: "gw/flash" }] };
  expect(reviewLine(decisions)).toBe("  Tool-call review: off");
  expect(reviewLine({ ...decisions, toolReviewEnabled: true })).toBe("  Tool-call review: gw/judge-1 → gw/flash");
  expect(reviewLine({ decisionsEnabled: true, decisionsModel: "gw/judge-1", toolReviewEnabled: true })).toBe("  Tool-call review: off");
});
