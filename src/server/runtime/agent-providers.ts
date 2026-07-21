import type { Config } from "../config.js";
import {
  createAgentProvider,
  type AgentProviderInstance
} from "../modules/agent/llm-provider.js";
import { buildProviderConfig, buildProviderConfigs } from "./agent-provider-config.js";

export interface AgentRuntimeProviderSet extends AgentProviderInstance {
  candidates: AgentProviderInstance[];
}

export function createAgentRuntimeProviders(config: Config) {
  return {
    managerProvider: createAgentRuntimeProviderSet(config, "manager"),
    workerProvider: createAgentRuntimeProviderSet(config, "worker")
  };
}

function createAgentRuntimeProviderSet(
  config: Config,
  role: "manager" | "worker"
): AgentRuntimeProviderSet {
  const candidates = buildProviderConfigs(config, role).map(createAgentProvider);
  const primary = candidates[0] ?? createAgentProvider(buildProviderConfig(config, role));
  return {
    ...primary,
    candidates
  };
}
