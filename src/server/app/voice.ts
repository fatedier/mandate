import type { PagePublisher } from "../modules/page/page-publisher.js";
import type { Config } from "../config.js";
import type { AgentStore } from "../modules/agent/agent-store.js";
import { AgentSseEmitter } from "../modules/sse/sse-events.js";
import { CodexRealtimeProvider } from "../modules/voice/codex-realtime-provider.js";
import { OpenAIRealtimeProvider } from "../modules/voice/openai-realtime-provider.js";
import { VoiceSessionOrchestrator } from "../modules/voice/voice-session-orchestrator.js";
import type { VoiceSessionClocks } from "../modules/voice/voice-gateway.js";
import { saidAfterNotices, startSpokenUpdateSource } from "../modules/voice/spoken-updates.js";
import type { WaitingEntryDto } from "../../shared/api/thread-status.js";
import { SSE_EVENTS } from "../../shared/api-contracts.js";
import globalPromptPath from "../modules/global/prompts/global.md" with { type: "file" };
import voiceStylePromptPath from "../modules/voice/prompts/voice-style.md" with { type: "file" };
import voiceLanguageDirectivePromptPath from "../modules/voice/prompts/voice-language-directive.md" with { type: "file" };
import { renderPromptFile } from "../platform/prompts/prompt-template.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import type { SkillsBootstrapResult } from "../runtime/skills-bootstrap.js";
import { displayGlobalAgentName } from "../../shared/global-agent-name.js";

/** The realtime model's instructions: the global agent's own prompt, its
 *  name, its memory, how to speak, and the skills it can read.
 *  The memory is the session's opening memory, as a text
 *  window's initial context carries it. */
export function buildVoiceInstructions(input: { name: string; language: string | null | undefined; skillsManifest: string; memorySection: string }): string {
  const lang = (input.language ?? "").trim();
  const languageDirective = lang && lang.toLowerCase() !== "auto" && lang.toLowerCase() !== "automatic"
    ? renderPromptFile(voiceLanguageDirectivePromptPath, { language: lang })
    : "";
  return [
    renderPromptFile(globalPromptPath, {}).trim(),
    `Your name is ${input.name}.`,
    input.memorySection.trim(),
    renderPromptFile(voiceStylePromptPath, { languageDirective }).trim(),
    input.skillsManifest.trim()
  ].filter(Boolean).join("\n\n");
}

/** What the global runtime context shows: workers (made, archived, restored,
 *  moved, their items and plans), threads, projects, handoffs and the
 *  agent's name. Messages, streams and panes are not in it. */
const CONTEXT_EVENTS = new Set<string>([
  SSE_EVENTS.featureCreated, SSE_EVENTS.featureArchived, SSE_EVENTS.featureRestored, SSE_EVENTS.featureOwnerChanged,
  SSE_EVENTS.workItemCreated, SSE_EVENTS.workItemUpdated, SSE_EVENTS.featurePlanUpdated,
  SSE_EVENTS.managerThreadUpdated, SSE_EVENTS.globalHandoffUpdated, SSE_EVENTS.globalAgentUpdated,
  SSE_EVENTS.projectCreated, SSE_EVENTS.projectArchived, SSE_EVENTS.projectAdopted
]);

/** Calls back when something the context shows changed (the session
 *  rebuilds it, throttled); returns the unsubscribe. */
export function contextChangesFrom(sse: AgentSseEmitter): (cb: () => void) => () => void {
  return (cb) => sse.addSink((e) => {
    if (CONTEXT_EVENTS.has(e.event)) cb();
  });
}

/** One orchestrator per voice session; every session is the global agent's. */
export function createVoiceOrchestratorFactory(input: {
  config: Config;
  runtime: AgentRuntime;
  skills: SkillsBootstrapResult;
  agentStore: AgentStore;
  sse: AgentSseEmitter;
  /** What Home lists now (the status snapshot's list). */
  waiting: () => readonly WaitingEntryDto[];
  /** Publishes Your agent's page when a spoken reply ends. */
  pagePublisher?: Pick<PagePublisher, "afterAgentTurn">;
}) {
  const { config, runtime, skills, agentStore, sse, waiting } = input;
  const spokenUpdates = startSpokenUpdateSource({
    sse, waiting,
    globalThreadId: () => agentStore.getOrCreateGlobalThread().id,
    saidAfter: (query) => saidAfterNotices(agentStore, agentStore.getOrCreateGlobalThread().id, query)
  });
  const contextChanges = contextChangesFrom(sse);
  return (clocks: VoiceSessionClocks) => {
    const globalScope = runtime.scopes.global;
    const voiceProvider = config.voice.providerType === "codex"
      ? new CodexRealtimeProvider({ baseURL: config.voice.baseURL || undefined })
      : new OpenAIRealtimeProvider({ baseURL: config.voice.baseURL || undefined, deployment: config.voice.deployment || undefined });
    const thread = agentStore.getOrCreateGlobalThread();
    return new VoiceSessionOrchestrator({
      threadId: thread.id,
      agentStore,
      provider: voiceProvider,
      providerConfig: {
        providerName: config.voice.providerName,
        providerType: config.voice.providerType,
        apiKey: config.voice.apiKey,
        model: config.voice.model,
        voice: config.voice.voice,
        language: config.voice.language,
        systemPrompt: buildVoiceInstructions({
          name: displayGlobalAgentName(config.agent.globalAgentName),
          language: config.voice.language,
          skillsManifest: skills.registry.renderManifest("global"),
          // Built when the session opens; context refreshes never carry memory.
          memorySection: globalScope.buildMemorySection?.(thread.id) ?? ""
        }),
        tools: globalScope.toolDefinitions
      },
      dispatcher: globalScope.wrappedDispatcher,
      buildToolScope: (threadId) => globalScope.buildToolScope(threadId),
      sse,
      idleTimeoutMs: config.voice.idleTimeoutMs,
      maxSessionMs: config.voice.maxSessionMs,
      contextMessageCount: config.voice.contextMessageCount,
      buildRuntimeContext: async () => (await globalScope.buildRuntimeContext?.(thread.id)) ?? null,
      subscribeContextChanges: contextChanges,
      subscribeSpokenUpdates: spokenUpdates,
      heardUpdates: clocks.heardUpdates,
      startedAtMs: clocks.startedAtMs,
      lastSpeechAtMs: clocks.lastSpeechAtMs,
      ...(input.pagePublisher ? { afterResponse: () => input.pagePublisher!.afterAgentTurn() } : {})
    });
  };
}
