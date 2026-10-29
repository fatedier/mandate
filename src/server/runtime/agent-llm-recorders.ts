import type { MandateStore } from "../app/store.js";
import type { Config } from "../config.js";
import { AgentLlmCallRecorder } from "../modules/activity/llm-call-recorder.js";
import { normalizeLogRequests } from "../modules/activity/llm-call-logging.js";
import { compressionApiMode } from "./agent-compression-llm.js";

export function createAgentRuntimeLlmRecorders(input: {
  config: Config;
  store: MandateStore;
}) {
  const { config, store } = input;
  const logRequests = normalizeLogRequests(config.agent.logRequests);
  const managerMaintenanceApiMode = compressionApiMode(config.agent.manager.provider);
  const workerMaintenanceApiMode = compressionApiMode(config.agent.worker.provider);
  const globalMaintenanceApiMode = compressionApiMode(config.agent.global.provider);
  const recorderFor = (route: Config["agent"]["global"], apiMode: string) => new AgentLlmCallRecorder({
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
    managerWakeRecorder: new AgentLlmCallRecorder({
      store,
      logRequests,
      provider: config.agent.manager.provider,
      providerName: config.agent.manager.providerName,
      api: config.agent.manager.api,
      providerType: config.agent.manager.providerType,
      model: config.agent.manager.model,
      baseURL: config.agent.manager.baseURL || "",
      apiMode: "streamText"
    }),
    workerWakeRecorder: new AgentLlmCallRecorder({
      store,
      logRequests,
      provider: config.agent.worker.provider,
      providerName: config.agent.worker.providerName,
      api: config.agent.worker.api,
      providerType: config.agent.worker.providerType,
      model: config.agent.worker.model,
      baseURL: config.agent.worker.baseURL || "",
      apiMode: "streamText"
    }),
    compressionManagerRecorder: new AgentLlmCallRecorder({
      store,
      logRequests,
      provider: config.agent.manager.provider,
      providerName: config.agent.manager.providerName,
      api: config.agent.manager.api,
      providerType: config.agent.manager.providerType,
      model: config.agent.manager.model,
      baseURL: config.agent.manager.baseURL || "",
      apiMode: managerMaintenanceApiMode
    }),
    compressionWorkerRecorder: new AgentLlmCallRecorder({
      store,
      logRequests,
      provider: config.agent.worker.provider,
      providerName: config.agent.worker.providerName,
      api: config.agent.worker.api,
      providerType: config.agent.worker.providerType,
      model: config.agent.worker.model,
      baseURL: config.agent.worker.baseURL || "",
      apiMode: workerMaintenanceApiMode
    }),
    globalWakeRecorder: recorderFor(config.agent.global, "streamText"),
    compressionGlobalRecorder: recorderFor(config.agent.global, globalMaintenanceApiMode),
    memoryExtractionRecorder: recorderFor(config.agent.extraction, compressionApiMode(config.agent.extraction.provider)),
    subagentWakeRecorder: recorderFor(config.agent.subagent, "streamText"),
    compressionSubagentRecorder: recorderFor(config.agent.subagent, compressionApiMode(config.agent.subagent.provider)),
    pageWakeRecorder: recorderFor(config.agent.page, "streamText"),
    compressionPageRecorder: recorderFor(config.agent.page, compressionApiMode(config.agent.page.provider))
  };
}
