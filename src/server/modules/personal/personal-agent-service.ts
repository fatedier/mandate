import type { AgentStore } from "../agent/agent-store.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import type { Config } from "../../config.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import type { PersonalAgentDto, PersonalHandoffDto } from "../../../shared/api/personal-agent.js";
import type { HeldBackSignal } from "../../../shared/thread-dot.js";
import { voiceConfigured } from "../voice/voice-configured.js";
import { onCodexCredentialsChanged } from "../codex/codex-auth-store.js";
import type { HandoffService } from "./handoff-service.js";

interface PersonalAgentServiceDeps {
  agentStore: AgentStore;
  handoffs: HandoffService;
  /** Mutated in place by a config reload (container.replaceConfigInPlace). */
  config: Config;
  emit?: (agent: PersonalAgentDto) => void;
  /** The tool-call review's mark on its thread, if any. */
  heldBack?: (threadId: string) => HeldBackSignal | null;
}

/** The personal agent's state for the page: its thread, name, and whether its
 *  conversation has a message the user has not seen. */
export class PersonalAgentService {
  constructor(private readonly deps: PersonalAgentServiceDeps) {}

  state(): PersonalAgentDto {
    const thread = this.deps.agentStore.getOrCreatePersonalThread();
    const name = this.deps.config.agent.personalAgentName;
    const lastVisibleSeq = this.deps.agentStore.lastVisibleSeq(thread.id);
    return {
      threadId: thread.id,
      name,
      named: name !== "",
      // The agent's own words: a notice of another thread is read to
      // (lastVisibleSeq), but lights nothing.
      unread: this.deps.agentStore.lastSaidSeq(thread.id) > thread.seenSeq,
      voiceConfigured: voiceConfigured(this.deps.config.voice),
      lastVisibleSeq,
      seenSeq: thread.seenSeq,
      questions: this.deps.agentStore.openQuestions(thread.id),
      heldBack: this.deps.heldBack?.(thread.id) ?? null
    };
  }

  markSeen(seq: unknown): PersonalAgentDto | { error: string } {
    if (typeof seq !== "number" || !Number.isFinite(seq)) return { error: "seq must be a number" };
    const thread = this.deps.agentStore.getOrCreatePersonalThread();
    this.deps.agentStore.markThreadSeen(thread.id, seq);
    return this.publish();
  }

  /** The handoffs the page's transcript shows (at most 500), as they stand now. */
  handoffsByIds(ids: readonly string[]): PersonalHandoffDto[] {
    return this.deps.handoffs.byIds(this.deps.agentStore.getOrCreatePersonalThread().id, ids.slice(0, 500));
  }

  publish(): PersonalAgentDto {
    const dto = this.state();
    this.deps.emit?.(dto);
    return dto;
  }
}

/** Re-publishes the agent's state when its thread changed (a message, a
 *  wake) or a handoff did — deferred to a microtask, as the manager-thread
 *  broadcast is, so sinks see the causing event first — and when Codex is
 *  signed in or out, which can turn voice on or off. */
export function startPersonalAgentBroadcast(input: { sse: AgentSseEmitter; service: PersonalAgentService; agentStore: AgentStore }): () => void {
  let pending = false;
  const stopCredentials = onCodexCredentialsChanged(() => input.service.publish());
  const stopSink = input.sse.addSink((e) => {
    // What Home shows changed: a mark the review set on its thread (a
    // subagent's hold, say) is read again.
    const relevant = e.event === SSE_EVENTS.personalHandoffUpdated || e.event === SSE_EVENTS.threadStatus || (
      (e.event === SSE_EVENTS.agentMessageAppended || e.event === SSE_EVENTS.agentWakeStarted || e.event === SSE_EVENTS.agentWakeFinished)
      && input.agentStore.getThreadById((e.data as { threadId: string }).threadId)?.scope === "personal"
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

/** What the user sent behind a running turn changed a conversation's queue
 *  (an answer taken in, skipped or taken back closes or reopens a question
 *  before the turn reads it): its state is published then. A manager's
 *  thread goes out as itself, which the status reads; the personal agent's goes out
 *  as its card, and the status, which reads its questions, is worked out
 *  again. */
export function publishQueueChange(input: {
  managerThreads: { publish(threadId: string): unknown };
  agentStore: Pick<AgentStore, "getThreadById">;
  personalAgent: Pick<PersonalAgentService, "publish">;
  status: { poke(): void };
}): (threadId: string) => void {
  return (threadId) => {
    if (input.managerThreads.publish(threadId)) return;
    if (input.agentStore.getThreadById(threadId)?.scope !== "personal") return;
    input.personalAgent.publish();
    input.status.poke();
  };
}
