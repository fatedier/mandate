import { appendMessageToThread, monitorsRevisionBefore, scopeKey, withWakeReason } from "./agent-chat-utils";
import { findScopeKeyByThreadId, updateThreadByKey } from "./agent-chat-store-helpers";
import type {
  AgentChatGet,
  AgentChatSet,
  AgentContextUsage,
  AgentMessage,
  ThreadState
} from "./agent-chat-types";
import type { AgentMessagePatchDto, AgentMessageStreamDto, AgentMonitorsRevision, AgentPendingMonitorDto } from "@shared/api-contracts";
import type { AgentScope, AgentWakeReason } from "@shared/api-contracts";
import type { DutyReportOutcome } from "@shared/api/schedules";

/** Report marks heard live that the store keeps apart from their messages. */
const DUTY_MARKS_KEPT = 200;

export function createSseHandlers(set: AgentChatSet, get: AgentChatGet) {
  return {
    onMessageAppended: (threadId: string, message: AgentMessage, fromHistory = false) => {
      if (!fromHistory && message.role === "assistant" && message.wakeId) {
        clearMessageStream(set, get, threadId, message.wakeId);
      }
      const state = get();
      const key = findScopeKeyByThreadId(state, threadId);
      if (!key) return;
      // A subagent's conversation is read whole, for its steps: none of it is
      // dropped, or the steps would be read again at every step it takes.
      // Or held whole by a second view (History): its rows stay under it.
      const trimMessages = !key.startsWith("subagent:") && !state.wholeHeld.has(key);
      const append = (thread: ThreadState) => {
        const next = appendMessageToThread(thread, message, { trimMessages });
        // History may already contain this message. A live completion still
        // clears the bubble even when appendMessageToThread deduplicates it.
        if (!fromHistory && message.role === "assistant" && next.streamingAssistant?.wakeId === message.wakeId) {
          return { ...next, streamingAssistant: null };
        }
        // Reconnect history may contain an earlier step from this same wake.
        // It must not erase the active stream just restored by the SSE snapshot.
        const active = fromHistory ? state.messageStreams.get(threadId) : null;
        return active ? { ...next, streamingAssistant: active } : next;
      };
      updateThreadByKey(set, key, (t) => append(t));
    },

    onMessagesDeleted: (threadId: string, messageIds: readonly string[]) => {
      const key = findScopeKeyByThreadId(get(), threadId);
      if (!key) return;
      const gone = new Set(messageIds);
      updateThreadByKey(set, key, (thread) => {
        // Kept by id too: a read on its way may still carry one.
        if (messageIds.every((id) => thread.deletedIds?.has(id))) return thread;
        const deletedIds = new Set([...thread.deletedIds ?? [], ...messageIds]);
        return thread.messages.some((m) => gone.has(m.id))
          ? { ...thread, deletedIds, messages: thread.messages.filter((m) => !gone.has(m.id)) }
          : { ...thread, deletedIds };
      });
    },

    onDutyReport: (threadId: string, messageId: string, outcome: DutyReportOutcome) => {
      set((state) => {
        const dutyMarks = new Map(state.dutyMarks).set(messageId, outcome);
        // The newest only: older marks are on their messages by then.
        for (const old of dutyMarks.keys()) {
          if (dutyMarks.size <= DUTY_MARKS_KEPT) break;
          dutyMarks.delete(old);
        }
        return { dutyMarks };
      });
      const key = findScopeKeyByThreadId(get(), threadId);
      if (!key) return;
      updateThreadByKey(set, key, (thread) => thread.messages.some((m) => m.id === messageId)
        ? { ...thread, messages: thread.messages.map((m) => (m.id === messageId ? { ...m, dutyReport: outcome } : m)) }
        : thread);
    },

    onMessageStreams: (streams: AgentMessageStreamDto[]) => set((state) => {
      const messageStreams = new Map(streams.map(({ threadId, wakeId, totalText }) => [threadId, { wakeId, totalText }]));
      const restore = (thread: ThreadState): ThreadState => ({
        ...thread, streamingAssistant: messageStreams.get(thread.threadId ?? "") ?? null
      });
      return {
        messageStreams,
        threadsByScope: new Map([...state.threadsByScope].map(([key, thread]) => [key, restore(thread)]))
      };
    }),

    onMessagePatch: ({ threadId, wakeId, offset, deltaText }: AgentMessagePatchDto): boolean => {
      const previous = get().messageStreams.get(threadId);
      // SSE is ordered. A missing baseline means reconnect for an authoritative
      // snapshot rather than silently showing an incomplete reply.
      if (!Number.isSafeInteger(offset) || offset < 0 || typeof deltaText !== "string") return false;
      if (offset !== 0 && (previous?.wakeId !== wakeId || offset > previous.totalText.length)) return false;
      const streamingAssistant = { wakeId, totalText: (offset ? previous!.totalText.slice(0, offset) : "") + deltaText };
      set((state) => {
        const messageStreams = new Map(state.messageStreams);
        messageStreams.set(threadId, streamingAssistant);
        const key = findScopeKeyByThreadId(state, threadId);
        const threadsByScope = new Map(state.threadsByScope);
        if (key) threadsByScope.set(key, { ...threadsByScope.get(key)!, streamingAssistant });
        return { messageStreams, threadsByScope };
      });
      return true;
    },

    onWakeStarted: (
      threadId: string,
      wakeId: string,
      reason: AgentWakeReason,
      startedAt: string,
      scope?: AgentScope,
      scopeId?: string | null
    ) => {
      let key = findScopeKeyByThreadId(get(), threadId);
      // A worker's conversation that did not exist when its page read it, or
      // while that read is on its way (no thread then): its first wake names
      // it. Bind it and read it once, so what it says (its pending monitors
      // among it) reaches the page; a read on its way reads again for it.
      // Only an entry still without a thread is bound, so this cannot loop.
      if (!key && scope === "worker" && scopeId) {
        const workerKey = scopeKey({ type: "worker", workerId: scopeId });
        if (get().threadsByScope.get(workerKey)?.threadId === null) {
          updateThreadByKey(set, workerKey, (t) => ({ ...t, threadId }));
          key = workerKey;
          void get().ensureThreadLoaded({ type: "worker", workerId: scopeId }).catch(() => {});
        }
      }
      if (!key) return;
      updateThreadByKey(set, key, (t) => ({
        ...t,
        wakeReasonsById: withWakeReason(t.wakeReasonsById, wakeId, reason),
        wakePhase: { wakeId, phase: "thinking", startedAt }
      }));
    },

    onMonitorsChanged: (threadId: string, monitors: AgentPendingMonitorDto[], revision: AgentMonitorsRevision) => {
      const key = findScopeKeyByThreadId(get(), threadId);
      if (!key) return;
      updateThreadByKey(set, key, (t) => (
        t.monitorsRevision !== null && monitorsRevisionBefore(revision, t.monitorsRevision) ? t : { ...t, monitors, monitorsRevision: revision }
      ));
    },

    onContextUsageUpdated: (threadId: string, _wakeId: string, contextUsage: AgentContextUsage) => {
      const key = findScopeKeyByThreadId(get(), threadId);
      if (!key) return;
      updateThreadByKey(set, key, (t) => ({
        ...t,
        contextUsage
      }));
    },

    onWakeFinished: (threadId: string, wakeId: string, contextUsage?: AgentContextUsage | null) => {
      clearMessageStream(set, get, threadId, wakeId);
      const key = findScopeKeyByThreadId(get(), threadId);
      if (!key) return;
      updateThreadByKey(set, key, (t) => ({
        ...t,
        // Its start stays: it is how a page read taken before this wake began
        // is known to be older (see adoptActiveWake).
        wakePhase: { wakeId, phase: "idle", ...(t.wakePhase.wakeId === wakeId && t.wakePhase.startedAt ? { startedAt: t.wakePhase.startedAt } : {}) },
        streamingAssistant: t.streamingAssistant?.wakeId === wakeId ? null : t.streamingAssistant,
        contextUsage: contextUsage ?? t.contextUsage
      }));
    },

    onCompressionStarted: (threadId: string, compressionId: string, startedAt: string) => {
      const key = findScopeKeyByThreadId(get(), threadId);
      if (!key) return;
      updateThreadByKey(set, key, (t) => ({
        ...t,
        compressionPhase: { compressionId, startedAt }
      }));
    },

    onCompressionFinished: (
      threadId: string,
      compressionId: string,
      contextUsage?: AgentContextUsage | null
    ) => {
      const clear = (t: ThreadState): ThreadState => ({
        ...t,
        compressionPhase:
          !t.compressionPhase || t.compressionPhase.compressionId === compressionId
            ? null
            : t.compressionPhase,
        contextUsage: contextUsage ?? t.contextUsage
      });
      const key = findScopeKeyByThreadId(get(), threadId);
      if (!key) return;
      updateThreadByKey(set, key, clear);
    },

    onCompressionFailed: (threadId: string, compressionId: string) => {
      get().onCompressionFinished(threadId, compressionId);
    }
  };
}

function clearMessageStream(set: AgentChatSet, get: AgentChatGet, threadId: string, wakeId: string): void {
  if (get().messageStreams.get(threadId)?.wakeId !== wakeId) return;
  set((state) => {
    const messageStreams = new Map(state.messageStreams);
    messageStreams.delete(threadId);
    return { messageStreams };
  });
}
