import type { Config } from "../config.js";
import {
  createAgentProvider,
  type AgentProviderInstance
} from "../modules/agent/llm-provider.js";
import { buildProviderConfig, buildProviderConfigs, type AgentRouteRole } from "./agent-provider-config.js";

interface AgentRuntimeProviderSet extends AgentProviderInstance {
  candidates: AgentProviderInstance[];
}

export function createAgentRuntimeProviders(config: Config) {
  return {
    managerProvider: createAgentRuntimeProviderSet(config, "manager"),
    workerProvider: createAgentRuntimeProviderSet(config, "worker"),
    globalProvider: createAgentRuntimeProviderSet(config, "global"),
    extractionProvider: createAgentRuntimeProviderSet(config, "extraction"),
    // Run only while the subagent route is set; the router reads which.
    subagentProvider: createAgentRuntimeProviderSet(config, "subagent"),
    // Run only while the page updates' route is set.
    pageProvider: createAgentRuntimeProviderSet(config, "page")
  };
}

function createAgentRuntimeProviderSet(
  config: Config,
  role: AgentRouteRole
): AgentRuntimeProviderSet {
  const candidates = buildProviderConfigs(config, role).map(createAgentProvider);
  const primary = candidates[0] ?? createAgentProvider(buildProviderConfig(config, role));
  return {
    ...primary,
    candidates
  };
}
