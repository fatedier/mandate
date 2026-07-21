import type { Config } from "../config.js";
import type { AgentStore } from "../modules/agent/agent-store.js";
import { AgentSseEmitter } from "../modules/sse/sse-events.js";
import { UiContextRegistry } from "../modules/ui-context/ui-context-registry.js";
import { CodexRealtimeProvider } from "../modules/voice/codex-realtime-provider.js";
import { OpenAIRealtimeProvider } from "../modules/voice/openai-realtime-provider.js";
import { VoiceSessionOrchestrator } from "../modules/voice/voice-session-orchestrator.js";
import voiceBasePromptPath from "../modules/voice/prompts/voice-base.md" with { type: "file" };
import voiceLanguageDirectivePromptPath from "../modules/voice/prompts/voice-language-directive.md" with { type: "file" };
import { renderPromptFile } from "../platform/prompts/prompt-template.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import type { SkillsBootstrapResult } from "../runtime/skills-bootstrap.js";

export function createVoiceOrchestratorFactory(input: {
  config: Config;
  runtime: AgentRuntime;
  skills: SkillsBootstrapResult;
  agentStore: AgentStore;
  sse: AgentSseEmitter;
  uiContextRegistry: UiContextRegistry;
}) {
  const { config, runtime, skills, agentStore, sse, uiContextRegistry } = input;
  return () => {
    const managerScope = runtime.scopes.manager;
    const voiceProvider = config.voice.providerType === "codex"
      ? new CodexRealtimeProvider({
          baseURL: config.voice.baseURL || undefined
        })
      : new OpenAIRealtimeProvider({
          baseURL: config.voice.baseURL || undefined,
          deployment: config.voice.deployment || undefined
        });
    // Inject the same skill manifest the manager sees. Voice shares
    // manager-scope skills, including ui-routes for URL slug conventions.
    const manifest = skills.registry.renderManifest("manager");
    const basePrompt = buildVoiceBasePrompt(config.voice.language);
    const systemPrompt = manifest ? `${basePrompt}\n\n${manifest}` : basePrompt;
    const orch = new VoiceSessionOrchestrator({
      agentStore,
      provider: voiceProvider,
      providerConfig: {
        providerName: config.voice.providerName,
        providerType: config.voice.providerType,
        apiKey: config.voice.apiKey,
        model: config.voice.model,
        voice: config.voice.voice,
        language: config.voice.language,
        systemPrompt,
        tools: managerScope.toolDefinitions
      },
      managerDispatcher: managerScope.wrappedDispatcher,
      buildManagerToolScope: (threadId) => managerScope.buildToolScope(threadId),
      wakeManager: (threadId, reason, triggerMsgId) => {
        const wakeId = runtime.wakeScheduler.wake(threadId, reason, triggerMsgId);
        if (!wakeId) {
          throw new Error("the manager is busy with another wake");
        }
        return wakeId;
      },
      sse,
      uiContextRegistry,
      idleTimeoutMs: config.voice.idleTimeoutMs,
      maxSessionMs: config.voice.maxSessionMs,
      contextMessageCount: config.voice.contextMessageCount
    });
    const unsub = runtime.onWakeFinished((event) => {
      void orch.onManagerWakeFinished(event);
    });
    orch.on("onClose", () => unsub());
    return orch;
  };
}

function buildVoiceBasePrompt(language: string | null | undefined): string {
  const lang = (language ?? "").trim();
  const languageDirective = lang && lang.toLowerCase() !== "auto" && lang.toLowerCase() !== "automatic"
    ? renderPromptFile(voiceLanguageDirectivePromptPath, { language: lang })
    : "";
  return renderPromptFile(voiceBasePromptPath, { languageDirective }).trim();
}
