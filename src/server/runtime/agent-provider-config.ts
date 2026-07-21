import type { AgentProviderConfig } from "../modules/agent/llm-provider.js";
import type { Config, ResolvedProviderConfig } from "../config.js";

export function buildProviderConfig(
  config: Config,
  role: "manager" | "worker"
): AgentProviderConfig {
  const a = config.agent;
  const resolved = role === "manager" ? a.manager : a.worker;
  return agentProviderConfigFromResolved(resolved);
}

export function buildProviderConfigs(
  config: Config,
  role: "manager" | "worker"
): AgentProviderConfig[] {
  const a = config.agent;
  const primary = role === "manager" ? a.manager : a.worker;
  const fallbacks = role === "manager" ? a.managerFallbacks : a.workerFallbacks;
  return [primary, ...fallbacks].map(agentProviderConfigFromResolved);
}

function agentProviderConfigFromResolved(
  resolved: ResolvedProviderConfig
): AgentProviderConfig {
  return {
    provider: agentProviderType(resolved.provider),
    providerName: resolved.providerName,
    model: resolved.model,
    apiKey: resolved.apiKey || envApiKeyFor(resolved.provider),
    baseURL: resolved.baseURL || undefined,
    organizationId: resolved.provider === "kilo" ? resolved.organizationId : undefined,
    serviceTier: resolved.provider === "codex" ? resolved.serviceTier : undefined,
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
