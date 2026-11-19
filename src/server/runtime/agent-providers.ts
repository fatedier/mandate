import type { AgentRoute, Config } from "../config.js";
import {
  createAgentProvider,
  type AgentProviderInstance
} from "../modules/agent/llm-provider.js";
import { buildProviderConfigs } from "./agent-provider-config.js";

interface AgentRuntimeProviderSet extends AgentProviderInstance {
  candidates: AgentProviderInstance[];
}

export function createAgentRuntimeProviders(config: Config) {
  return {
    managerProvider: createAgentRuntimeProviderSet(config, "manager"),
    workerProvider: createAgentRuntimeProviderSet(config, "worker"),
    personalProvider: createAgentRuntimeProviderSet(config, "personal"),
    extractionProvider: createAgentRuntimeProviderSet(config, "extraction"),
    // Run only while the subagent route is set; the router reads which.
    subagentProvider: createAgentRuntimeProviderSet(config, "subagent"),
    // Run only while the page updates' route is set.
    pageProvider: createAgentRuntimeProviderSet(config, "page")
  };
}

function createAgentRuntimeProviderSet(
  config: Config,
  role: AgentRoute
): AgentRuntimeProviderSet {
  // A route's first candidate is the route itself, so there is always one.
  const candidates = buildProviderConfigs(config, role).map(createAgentProvider);
  const primary = candidates[0]!;
  return {
    ...primary,
    candidates
  };
}
