import type { Config, ResolvedProviderConfig } from "../config.js";

export function formatStartupModelLines(config: Config): string[] {
  const lines = [
    "Models:",
    `  Agent manager: ${formatResolvedModel(config.agent.manager)}`,
    `  Agent worker: ${formatResolvedModel(config.agent.worker)}`,
    `  Voice: ${formatVoiceModel(config.voice)}`
  ];
  const embedding = config.memory.embedding.model.trim();
  if (embedding) {
    lines.push(`  Memory embedding: ${embedding}`);
  }
  return lines;
}

function formatResolvedModel(input: ResolvedProviderConfig): string {
  const modelRef = input.modelRef?.trim();
  if (modelRef) return modelRef;

  const model = input.model?.trim();
  if (!model) return "disabled";

  const provider = input.providerName?.trim() || input.provider?.trim() || input.providerType?.trim();
  return provider ? `${provider}/${model}` : model;
}

function formatVoiceModel(voice: Config["voice"]): string {
  const model = voice.model.trim();
  if (!model) return "disabled";
  const provider = voice.providerName.trim() || voice.provider.trim() || voice.providerType.trim();
  const label = provider ? `${provider}/${model}` : model;
  return voice.voice ? `${label} (${voice.voice})` : label;
}
