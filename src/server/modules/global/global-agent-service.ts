import type { AgentStore } from "../agent/agent-store.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import type { Config } from "../../config.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import type { GlobalAgentDto, GlobalHandoffDto } from "../../../shared/api/global-agent.js";
import { voiceConfigured } from "../voice/voice-configured.js";
import { onCodexCredentialsChanged } from "../codex/codex-auth-store.js";
import type { HandoffService } from "./handoff-service.js";

interface GlobalAgentServiceDeps {
  agentStore: AgentStore;
  handoffs: HandoffService;
  /** Mutated in place by a config reload (container.replaceConfigInPlace). */
  config: Config;
  emit?: (agent: GlobalAgentDto) => void;
}

/** The global agent's state for the page: its thread, name, and whether its
 *  conversation has a message the user has not seen. */
export class GlobalAgentService {
  constructor(private readonly deps: GlobalAgentServiceDeps) {}

  state(): GlobalAgentDto {
    const thread = this.deps.agentStore.getOrCreateGlobalThread();
    const name = this.deps.config.agent.globalAgentName;
    const lastVisibleSeq = this.deps.agentStore.lastVisibleSeq(thread.id);
    return {
      threadId: thread.id,
      name,
      named: name !== "",
      unread: lastVisibleSeq > thread.seenSeq,
      voiceConfigured: voiceConfigured(this.deps.config.voice),
      lastVisibleSeq,
      questions: this.deps.agentStore.openQuestions(thread.id)
    };
  }

  markSeen(seq: unknown): GlobalAgentDto | { error: string } {
    if (typeof seq !== "number" || !Number.isFinite(seq)) return { error: "seq must be a number" };
    const thread = this.deps.agentStore.getOrCreateGlobalThread();
    this.deps.agentStore.markThreadSeen(thread.id, seq);
    return this.publish();
  }

  /** The handoffs the page's transcript shows (at most 500), as they stand now. */
  handoffsByIds(ids: readonly string[]): GlobalHandoffDto[] {
    return this.deps.handoffs.byIds(this.deps.agentStore.getOrCreateGlobalThread().id, ids.slice(0, 500));
  }

  publish(): GlobalAgentDto {
    const dto = this.state();
    this.deps.emit?.(dto);
    return dto;
  }
}

/** Re-publishes the agent's state when its thread changed (a message, a
 *  wake) or a handoff did — deferred to a microtask, as the manager-thread
 *  broadcast is, so sinks see the causing event first — and when Codex is
 *  signed in or out, which can turn voice on or off. */
export function startGlobalAgentBroadcast(input: { sse: AgentSseEmitter; service: GlobalAgentService; agentStore: AgentStore }): () => void {
  let pending = false;
  const stopCredentials = onCodexCredentialsChanged(() => input.service.publish());
  const stopSink = input.sse.addSink((e) => {
    const relevant = e.event === SSE_EVENTS.globalHandoffUpdated || (
      (e.event === SSE_EVENTS.agentMessageAppended || e.event === SSE_EVENTS.agentWakeStarted || e.event === SSE_EVENTS.agentWakeFinished)
      && input.agentStore.getThreadById((e.data as { threadId: string }).threadId)?.scope === "global"
    );
    if (!relevant || pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      input.service.publish();
    });
  });
  return () => { stopSink(); stopCredentials(); };
}
