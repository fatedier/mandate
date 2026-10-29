import type { Config } from "../config.js";
import { modelCacheLifetimeMinutes } from "../config/model-resolution.js";
import type { AgentStore } from "../modules/agent/agent-store.js";
import type { AgentAlarmManager } from "../modules/agent/agent-alarm-manager.js";
import type { FeaturesStore } from "../modules/features/features-store.js";
import { isCompactableThread } from "../modules/agent/idle-compaction/cache-lifetime.js";
import type { IdleCompactor, IdleCompactorDeps } from "../modules/agent/idle-compaction/idle-compactor.js";
import type { AgentSseEmitter } from "../modules/sse/sse-events.js";
import { SSE_EVENTS } from "../../shared/api/sse.js";

/**
 * What the runtime hands the idle clock: the
 * config's switch and numbers as they are now, each model's typed cache
 * lifetime by its connection and id, whether the thread may be compacted,
 * and whether one of its pending alarms is due first. The step prompt and
 * the compaction itself come from the wake scheduler and the compression
 * controller, passed through.
 */
export function idleCompactorDeps(input: {
  /** The live config: the runtime replaces it on a save. */
  config: () => Config;
  agentStore: Pick<AgentStore, "getThreadById">;
  featuresStore: Pick<FeaturesStore, "getById">;
  alarms: Pick<AgentAlarmManager, "list">;
  stepPromptFor: IdleCompactorDeps["stepPromptFor"];
  compact: IdleCompactorDeps["compact"];
}): IdleCompactorDeps {
  return {
    settings: () => {
      const agent = input.config().agent;
      return { enabled: agent.idleCompactionEnabled === true, leadMinutes: agent.idleCompactionLeadMinutes, minTokens: agent.idleCompactionMinTokens };
    },
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return { cancel: () => clearTimeout(timer) };
    },
    typedLifetime: (candidate) => modelCacheLifetimeMinutes(input.config(), `${candidate.meta?.providerName ?? ""}/${candidate.meta?.model ?? ""}`),
    stepPromptFor: input.stepPromptFor,
    threadCompactable: (threadId) => {
      const thread = input.agentStore.getThreadById(threadId);
      const feature = thread?.scope === "worker" && thread.scopeId ? input.featuresStore.getById(thread.scopeId) : null;
      return isCompactableThread(thread, Boolean(feature?.archivedAt));
    },
    // Pending alarms only (list's default).
    alarmDueBy: (threadId, atMs) => input.alarms.list(threadId).some((alarm) => Date.parse(alarm.fireAt) <= atMs),
    compact: input.compact
  };
}

/**
 * A voice line is written to its thread with no model call, so the idle
 * clock would not see someone talking: each one drops the thread's clock as
 * a call does (the next call that keeps the cache arms it again). Without
 * it a compaction could start mid-conversation and hide the lines spoken
 * while it ran, which its summary never read. Returns the unsubscribe.
 */
export function dropIdleClockOnVoice(sse: Pick<AgentSseEmitter, "addSink">, idle: Pick<IdleCompactor, "noteCallStarted">): () => void {
  return sse.addSink((e) => {
    if (e.event !== SSE_EVENTS.agentMessageAppended) return;
    const { threadId, message } = e.data as { threadId: string; message: { source?: string } };
    if (message?.source === "voice") idle.noteCallStarted(threadId);
  });
}
