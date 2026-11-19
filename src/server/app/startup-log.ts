import type { Config, ResolvedProviderConfig } from "../config.js";
import {
  managerRequestCheckChain,
  managerStopCheckChain,
  memoryRepeatCheckChain,
  toolReviewAvailable,
  toolReviewScreenChain,
  toolReviewSecondLookChain
} from "../config/model-resolution.js";

export function formatStartupModelLines(config: Config): string[] {
  const lines = [
    "Models:",
    `  Agent manager: ${formatResolvedModel(config.agent.manager)}`,
    `  Agent worker: ${formatResolvedModel(config.agent.worker)}`,
    `  Personal agent: ${formatResolvedModel(config.agent.personal)}`,
    `  Subagents: ${config.agent.subagentRouteSet ? formatResolvedModel(config.agent.subagent) : "the asking agent's route"}`,
    `  Page updates: ${config.agent.pageRouteSet ? formatResolvedModel(config.agent.page) : "the subagents' route"}`,
    `  Skill review: ${config.agent.skillReviewRouteSet ? formatResolvedModel(config.agent.skillReview) : `the Dream's route (${formatResolvedModel(config.agent.skillReview)})`}`,
    `  Manager request check: ${managerRequestCheckChain(config)[0] ? formatResolvedModel(managerRequestCheckChain(config)[0]!) : "off"}`,
    `  Manager stop check: ${managerStopCheckChain(config)[0] ? formatResolvedModel(managerStopCheckChain(config)[0]!) : "off"}`,
    `  Memory repeat check: ${memoryRepeatCheckChain(config)[0] ? formatResolvedModel(memoryRepeatCheckChain(config)[0]!) : "off"}`,
    `  Tool-call review: ${formatToolReview(config)}`,
    `  Dream: ${formatResolvedModel(config.agent.dream)}`,
    `  Memory extraction: ${formatResolvedModel(config.agent.extraction)}`,
    `  Voice: ${formatVoiceModel(config.voice)}`
  ];
  const embedding = config.memory.embedding.model.trim();
  if (embedding) {
    lines.push(`  Memory embedding: ${embedding}`);
  }
  return lines;
}

/** The screen's first model → the second look's, or off (switched off, or no
 *  second look to run it on). */
function formatToolReview(config: Config): string {
  if (!config.agent.toolReviewEnabled || !toolReviewAvailable(config)) return "off";
  const screen = toolReviewScreenChain(config)[0];
  return `${screen ? formatResolvedModel(screen) : "no screen"} → ${formatResolvedModel(toolReviewSecondLookChain(config)[0]!)}`;
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

/** Said at start only when the check of a request's origin is off. */
export function formatStartupOriginLines(config: Pick<Config, "checkOrigin">): string[] {
  if (config.checkOrigin) return [];
  return ["Origin check is off: a page of any site open in a browser on this machine can send requests to Mandate."];
}
