import type { AgentProviderConfig } from "../modules/agent/llm-provider.js";
import type { AgentRoute, Config, ResolvedProviderConfig } from "../config.js";

/** A route's models in order: the route, then its fallbacks. */
export function buildProviderConfigs(
  config: Config,
  role: AgentRoute
): AgentProviderConfig[] {
  return [config.agent[role], ...config.agent[`${role}Fallbacks` as const]].map(agentProviderConfigFromResolved);
}

/** A route's chain without the steps that name no model: what a background
 *  job can run on. Empty, the job waits rather than fail on a disabled model. */
export function runnableProviderConfigs(config: Config, role: AgentRoute): AgentProviderConfig[] {
  return buildProviderConfigs(config, role).filter((step) => step.provider !== "" && step.model !== "");
}

export function agentProviderConfigFromResolved(
  resolved: ResolvedProviderConfig
): AgentProviderConfig {
  return {
    provider: agentProviderType(resolved.provider),
    providerType: resolved.providerType,
    providerName: resolved.providerName,
    model: resolved.model,
    apiKey: resolved.apiKey,
    baseURL: resolved.baseURL || undefined,
    organizationId: resolved.providerType === "kilo" ? resolved.organizationId : undefined,
    serviceTier: resolved.serviceTier || undefined,
    openaiModelApi: resolved.protocol === "chat" ? "chat" : undefined,
    ...(resolved.api ? { api: resolved.api } : {}),
    reasoningEffort: resolved.reasoningEffort,
    supportsReasoning: resolved.supportsReasoning
  };
}

function agentProviderType(provider: string): AgentProviderConfig["provider"] {
  switch (provider) {
    case "anthropic":
    case "openai":
    case "openai-compatible":
    case "kilo":
    case "codex":
    case "google":
      return provider;
    default:
      return "";
  }
}
