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

  return {
    managerWakeRecorder: new AgentLlmCallRecorder({
      store,
      logRequests,
      provider: config.agent.manager.provider,
      providerName: config.agent.manager.providerName,
      model: config.agent.manager.model,
      baseURL: config.agent.manager.baseURL || "",
      apiMode: "streamText"
    }),
    workerWakeRecorder: new AgentLlmCallRecorder({
      store,
      logRequests,
      provider: config.agent.worker.provider,
      providerName: config.agent.worker.providerName,
      model: config.agent.worker.model,
      baseURL: config.agent.worker.baseURL || "",
      apiMode: "streamText"
    }),
    compressionManagerRecorder: new AgentLlmCallRecorder({
      store,
      logRequests,
      provider: config.agent.manager.provider,
      providerName: config.agent.manager.providerName,
      model: config.agent.manager.model,
      baseURL: config.agent.manager.baseURL || "",
      apiMode: managerMaintenanceApiMode
    }),
    compressionWorkerRecorder: new AgentLlmCallRecorder({
      store,
      logRequests,
      provider: config.agent.worker.provider,
      providerName: config.agent.worker.providerName,
      model: config.agent.worker.model,
      baseURL: config.agent.worker.baseURL || "",
      apiMode: workerMaintenanceApiMode
    }),
    memoryExtractionManagerRecorder: new AgentLlmCallRecorder({
      store,
      logRequests,
      provider: config.agent.manager.provider,
      providerName: config.agent.manager.providerName,
      model: config.agent.manager.model,
      baseURL: config.agent.manager.baseURL || "",
      apiMode: managerMaintenanceApiMode
    }),
    memoryExtractionWorkerRecorder: new AgentLlmCallRecorder({
      store,
      logRequests,
      provider: config.agent.worker.provider,
      providerName: config.agent.worker.providerName,
      model: config.agent.worker.model,
      baseURL: config.agent.worker.baseURL || "",
      apiMode: workerMaintenanceApiMode
    })
  };
}
