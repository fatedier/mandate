import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../src/server/config/load-config.js";
import { memoryDreamProviderConfigs } from "../src/server/app/container.js";
import { tempDir } from "./helpers/temp.js";

// The dream runs on a route of its own; it used to borrow the managers'.

function configWith(agent: Record<string, unknown>) {
  const dir = tempDir("md-dream-route-");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    models: {
      default: { model: "main/gpt-5.5", modelFallbacks: ["backup/vision-1"] },
      providers: {
        main: { type: "openai", apiKey: "main-key", models: [{ id: "gpt-5.5", input: ["text"] }, { id: "gpt-5.5-mini", input: ["text"] }] },
        backup: { type: "openai-compatible", apiKey: "backup-key", baseURL: "https://backup.example/v1", models: [{ id: "vision-1", input: ["text"] }] }
      }
    },
    agent: { managerModel: "backup/vision-1", managerModelFallbacks: [], ...agent }
  }));
  return loadConfig(dir);
}

const chain = (agent: Record<string, unknown>) =>
  memoryDreamProviderConfigs(configWith(agent)).map((step) => `${step.providerName}/${step.model}:${step.reasoningEffort}`);

test("the dream runs on its own route: its first model and its fallbacks, not the managers'", () => {
  expect(chain({
    dreamModel: { model: "main/gpt-5.5-mini", reasoningEffort: "medium" },
    dreamModelFallbacks: [{ model: "main/gpt-5.5", reasoningEffort: "low" }]
  })).toEqual(["main/gpt-5.5-mini:medium", "main/gpt-5.5:low"]);
});
