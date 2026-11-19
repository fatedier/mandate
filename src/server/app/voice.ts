import type { ScopeRuntime, WrappedDispatcher } from "../runtime/scope.js";
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
import personalPromptPath from "../modules/personal/prompts/personal.md" with { type: "file" };
import voiceStylePromptPath from "../modules/voice/prompts/voice-style.md" with { type: "file" };
import voiceLanguageDirectivePromptPath from "../modules/voice/prompts/voice-language-directive.md" with { type: "file" };
import { renderPromptFile } from "../platform/prompts/prompt-template.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import type { SkillsBootstrapResult } from "../runtime/skills-bootstrap.js";
import { displayPersonalAgentName } from "../../shared/personal-agent-name.js";

/** The realtime model's instructions: the personal agent's own prompt, its
 *  name, its memory, how to speak, and the skills it can read.
 *  The memory is the session's opening memory, as a text
 *  window's initial context carries it. */
export function buildVoiceInstructions(input: { name: string; language: string | null | undefined; skillsManifest: string; memorySection: string }): string {
  const lang = (input.language ?? "").trim();
  const languageDirective = lang && lang.toLowerCase() !== "auto" && lang.toLowerCase() !== "automatic"
    ? renderPromptFile(voiceLanguageDirectivePromptPath, { language: lang })
    : "";
  return [
    renderPromptFile(personalPromptPath, { name: input.name }).trim(),
    `Your name is ${input.name}.`,
    input.memorySection.trim(),
    renderPromptFile(voiceStylePromptPath, { languageDirective }).trim(),
    input.skillsManifest.trim()
  ].filter(Boolean).join("\n\n");
}

/** What the personal agent's runtime context shows: workers (made, archived, restored,
 *  moved, their items and plans), threads, projects, handoffs, the open
 *  tasks and the agent's name. Messages, streams and panes are not in it. */
const CONTEXT_EVENTS = new Set<string>([
  SSE_EVENTS.workerCreated, SSE_EVENTS.workerArchived, SSE_EVENTS.workerRestored, SSE_EVENTS.workerOwnerChanged,
  SSE_EVENTS.workItemCreated, SSE_EVENTS.workItemUpdated, SSE_EVENTS.workerPlanUpdated,
  SSE_EVENTS.managerThreadUpdated, SSE_EVENTS.personalHandoffUpdated, SSE_EVENTS.personalAgentUpdated,
  SSE_EVENTS.projectCreated, SSE_EVENTS.projectArchived,
  SSE_EVENTS.taskBoardTaskUpdated, SSE_EVENTS.taskBoardTaskRemoved, SSE_EVENTS.stickyNoteUpdated, SSE_EVENTS.calendarChanged
]);

/** Calls back when something the context shows changed (the session
 *  rebuilds it, throttled); returns the unsubscribe. */
export function contextChangesFrom(sse: AgentSseEmitter): (cb: () => void) => () => void {
  return (cb) => sse.addSink((e) => {
    if (CONTEXT_EVENTS.has(e.event)) cb();
  });
}

/** One orchestrator per voice session; every session is the personal agent's. */
export function createVoiceOrchestratorFactory(input: {
  config: Config;
  runtime: AgentRuntime;
  skills: SkillsBootstrapResult;
  agentStore: AgentStore;
  sse: AgentSseEmitter;
  /** What Home lists now (the status snapshot's list). */
  waiting: () => readonly WaitingEntryDto[];
  /** Publishes Personal agent's page when a spoken reply ends. */
  pagePublisher?: Pick<PagePublisher, "afterAgentTurn">;
  /** The active projects, read when a session opens. */
  activeProjectIds: () => string[];
}) {
  const { config, runtime, skills, agentStore, sse, waiting } = input;
  const spokenUpdates = startSpokenUpdateSource({
    sse, waiting,
    personalThreadId: () => agentStore.getOrCreatePersonalThread().id,
    saidAfter: (query) => saidAfterNotices(agentStore, agentStore.getOrCreatePersonalThread().id, query)
  });
  const contextChanges = contextChangesFrom(sse);
  return (clocks: VoiceSessionClocks) => {
    const personalScope = runtime.scopes.personal;
    const voiceProvider = config.voice.providerType === "codex"
      ? new CodexRealtimeProvider({ baseURL: config.voice.baseURL || undefined })
      : new OpenAIRealtimeProvider({ baseURL: config.voice.baseURL || undefined, deployment: config.voice.deployment || undefined });
    const thread = agentStore.getOrCreatePersonalThread();
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
          name: displayPersonalAgentName(config.agent.personalAgentName),
          language: config.voice.language,
          // The active projects' skills, as the personal agent's own list.
          skillsManifest: skills.registry.renderManifest("personal", { projectIds: input.activeProjectIds() }),
          // Built when the session opens; context refreshes never carry memory.
          memorySection: personalScope.buildMemorySection?.(thread.id) ?? ""
        }),
        tools: voiceToolSurface(personalScope).tools
      },
      dispatcher: voiceToolSurface(personalScope).dispatcher,
      buildToolScope: (threadId) => personalScope.buildToolScope(threadId),
      toolReview: runtime.toolReview,
      sse,
      idleTimeoutMs: config.voice.idleTimeoutMs,
      maxSessionMs: config.voice.maxSessionMs,
      contextMessageCount: config.voice.contextMessageCount,
      buildRuntimeContext: async () => (await personalScope.buildRuntimeContext?.(thread.id)) ?? null,
      subscribeContextChanges: contextChanges,
      subscribeSpokenUpdates: spokenUpdates,
      heardUpdates: clocks.heardUpdates,
      startedAtMs: clocks.startedAtMs,
      lastSpeechAtMs: clocks.lastSpeechAtMs,
      ...(input.pagePublisher ? { afterResponse: () => input.pagePublisher!.afterAgentTurn() } : {})
    });
  };
}

/** Changing a learned skill or asking for a review is done in writing, not
 *  spoken: neither is offered, and one
 *  called anyway is unknown, as any tool off the list is. */
const NOT_BY_VOICE: ReadonlySet<string> = new Set(["manage_skill", "request_skill_review"]);

export function voiceToolSurface(scope: Pick<ScopeRuntime, "toolDefinitions" | "wrappedDispatcher">): { tools: ScopeRuntime["toolDefinitions"]; dispatcher: WrappedDispatcher } {
  return {
    tools: scope.toolDefinitions.filter((tool) => !NOT_BY_VOICE.has(tool.name)),
    dispatcher: {
      get registry() { return scope.wrappedDispatcher.registry; },
      dispatch: async (call, ctx) => (NOT_BY_VOICE.has(call.toolName)
        ? { isError: true, error: `unknown tool: ${call.toolName}` }
        : scope.wrappedDispatcher.dispatch(call, ctx))
    }
  };
}
