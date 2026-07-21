import { expect, test } from "bun:test";
import { DEFAULT_CONFIG, emptyResolvedProvider } from "../src/server/config/defaults.js";
import type { Config, ResolvedProviderConfig } from "../src/server/config.js";
import { buildSetupStatus } from "../src/server/modules/setup/setup-status.js";

test("setup status reports missing first-run prerequisites", () => {
  const status = buildSetupStatus({
    config: cloneConfig(),
    configFileExists: false,
    projectCount: 0,
    tmuxAvailable: false,
    tmuxError: "tmux not found"
  });

  expect(status.ready).toBe(false);
  expect(status.firstRun).toBe(true);
  expect(status.models.ready).toBe(false);
  expect(status.models.providerCount).toBe(0);
  expect(status.terminal.ready).toBe(false);
  expect(status.terminal.error).toBe("tmux not found");
  expect(status.projects.ready).toBe(false);
  expect(status.agent.preferencesReady).toBe(true);
});

test("setup status accepts configured API-key providers", () => {
  const config = cloneConfig();
  config.models.providers.openai = {
    type: "openai",
    baseURL: "https://api.openai.com/v1",
    apiKey: "sk-test",
    models: []
  };
  config.models.default.model = "openai/gpt-4.1-mini";
  config.agent.manager = resolved("openai", "openai", "gpt-4.1-mini", "sk-test");
  config.agent.worker = resolved("openai", "openai", "gpt-4.1-mini", "sk-test");

  const status = buildSetupStatus({
    config,
    configFileExists: true,
    projectCount: 1,
    tmuxAvailable: true
  });

  expect(status.ready).toBe(true);
  expect(status.firstRun).toBe(false);
  expect(status.models.ready).toBe(true);
  expect(status.agent.preferencesReady).toBe(true);
});

test("setup status requires Codex OAuth for codex providers", () => {
  const config = cloneConfig();
  config.models.providers.codex = {
    type: "codex",
    baseURL: "https://chatgpt.com/backend-api/codex",
    apiKey: "",
    serviceTier: "",
    models: []
  };
  config.models.default.model = "codex/gpt-5.5";
  config.agent.manager = resolved("codex", "codex", "gpt-5.5", "");
  config.agent.worker = resolved("codex", "codex", "gpt-5.5", "");

  expect(
    buildSetupStatus({
      config,
      projectCount: 1,
      tmuxAvailable: true,
      codexAuthenticated: () => false
    }).models.ready
  ).toBe(false);

  expect(
    buildSetupStatus({
      config,
      projectCount: 1,
      tmuxAvailable: true,
      codexAuthenticated: (providerName) => providerName === "codex"
    }).models.ready
  ).toBe(true);
});

function cloneConfig(): Config {
  return structuredClone(DEFAULT_CONFIG);
}

function resolved(
  providerName: string,
  providerType: string,
  model: string,
  apiKey: string
): ResolvedProviderConfig {
  return {
    ...emptyResolvedProvider(),
    providerName,
    provider: providerType,
    providerType,
    model,
    modelRef: `${providerName}/${model}`,
    apiKey
  };
}
