import { expect, test } from "bun:test";
import { formatStartupModelLines } from "../src/server/app/startup-log.js";
import { loadConfig, type JsonObject } from "../src/server/config.js";
import { MemoryJsonStore } from "./helpers/memory-json-store.js";

test("formatStartupModelLines lists each model role explicitly", () => {
  const config = loadConfig(
    undefined,
    new MemoryJsonStore<JsonObject>({
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
        workerModel: "openai/gpt-5.5"
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
    "  Voice: codex/gpt-realtime-2 (marin)",
    "  Memory embedding: openai/text-embedding-3-small"
  ]);
});
