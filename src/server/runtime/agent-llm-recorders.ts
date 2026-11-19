import type { MandateStore } from "../app/store.js";
import type { Config } from "../config.js";
import { AgentLlmCallRecorder } from "../modules/activity/llm-call-recorder.js";
import { normalizeLogRequests } from "../modules/activity/llm-call-logging.js";

export function createAgentRuntimeLlmRecorders(input: {
  config: Config;
  store: MandateStore;
}) {
  const { config, store } = input;
  const logRequests = normalizeLogRequests(config.agent.logRequests);
  const recorderFor = (route: Config["agent"]["personal"], apiMode: string) => new AgentLlmCallRecorder({
    store,
    logRequests,
    provider: route.provider,
    providerName: route.providerName,
    api: route.api,
    providerType: route.providerType,
    model: route.model,
    baseURL: route.baseURL || "",
    apiMode
  });

  return {
    managerWakeRecorder: recorderFor(config.agent.manager, "streamText"),
    workerWakeRecorder: recorderFor(config.agent.worker, "streamText"),
    compressionManagerRecorder: recorderFor(config.agent.manager, "streamText"),
    compressionWorkerRecorder: recorderFor(config.agent.worker, "streamText"),
    personalWakeRecorder: recorderFor(config.agent.personal, "streamText"),
    compressionPersonalRecorder: recorderFor(config.agent.personal, "streamText"),
    memoryExtractionRecorder: recorderFor(config.agent.extraction, "streamText"),
    subagentWakeRecorder: recorderFor(config.agent.subagent, "streamText"),
    compressionSubagentRecorder: recorderFor(config.agent.subagent, "streamText"),
    pageWakeRecorder: recorderFor(config.agent.page, "streamText"),
    compressionPageRecorder: recorderFor(config.agent.page, "streamText")
  };
}
