import type { AgentProviderConfig } from "../modules/agent/llm-provider.js";
import type { AgentRoute, Config, ResolvedProviderConfig } from "../config.js";

export type AgentRouteRole = AgentRoute;

export function buildProviderConfig(
  config: Config,
  role: AgentRouteRole
): AgentProviderConfig {
  return agentProviderConfigFromResolved(config.agent[role]);
}

export function buildProviderConfigs(
  config: Config,
  role: AgentRouteRole
): AgentProviderConfig[] {
  return [config.agent[role], ...config.agent[`${role}Fallbacks` as const]].map(agentProviderConfigFromResolved);
}

export function agentProviderConfigFromResolved(
  resolved: ResolvedProviderConfig
): AgentProviderConfig {
  return {
    provider: agentProviderType(resolved.provider),
    providerType: resolved.providerType,
    providerName: resolved.providerName,
    model: resolved.model,
    // The configured type's environment key: a custom provider's Messages
    // model runs as the Anthropic family but must never borrow its key.
    apiKey: resolved.apiKey || envApiKeyFor(resolved.providerType),
    baseURL: resolved.baseURL || undefined,
    organizationId: resolved.providerType === "kilo" ? resolved.organizationId : undefined,
    serviceTier: resolved.provider === "codex" ? resolved.serviceTier : undefined,
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

function envApiKeyFor(provider: string): string {
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY ?? "";
  if (provider === "openai") return process.env.OPENAI_API_KEY ?? "";
  if (provider === "google")
    return process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
  return "";
}
