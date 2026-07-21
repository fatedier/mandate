import { appendMessageToThread } from "./agent-chat-utils";
import { scopeKey } from "./agent-chat-utils";
import { withWakeMetadata } from "./agent-chat-utils";
import { withWakeReason } from "./agent-chat-utils";
import {
  findScopeKeyByThreadId,
  updateThreadByKey
} from "./agent-chat-store-helpers";
import type {
  AgentChatGet,
  AgentChatSet,
  AgentContextUsage,
  AgentMessage,
  ThreadState,
  WakeError
} from "./agent-chat-types";
import type { AgentMessagePatchDto, AgentMessageStreamDto, AgentWakeUserErrorDto } from "@shared/api-contracts";
import type { AgentWakeMetadata, AgentWakeReason } from "@shared/api-contracts";

export function createSseHandlers(set: AgentChatSet, get: AgentChatGet) {
  return {
    onMessageAppended: (threadId: string, message: AgentMessage, fromHistory = false) => {
      if (!fromHistory && message.role === "assistant" && message.wakeId) {
        clearMessageStream(set, get, threadId, message.wakeId);
      }
      const state = get();
      const drawerVisible = state.drawerOpen && state.drawerMode !== "worker";
      const append = (thread: ThreadState, incrementUnread: boolean) => {
        const next = appendMessageToThread(thread, message, { trimMessages: true, incrementUnread });
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
      if (state.sideThread?.threadId === threadId) {
        updateSideThread(set, get, (thread) => append(thread, !state.sideActive || !drawerVisible));
        return;
      }
      const key = findScopeKeyByThreadId(state, threadId);
      if (!key) return;
      const isVisibleScope = !state.sideActive && state.drawerScope && scopeKey(state.drawerScope) === key;
      updateThreadByKey(set, key, (t) =>
        append(t, message.role === "assistant" && (!isVisibleScope || !drawerVisible))
      );
    },

    onMessageStreams: (streams: AgentMessageStreamDto[]) => set((state) => {
      const messageStreams = new Map(streams.map(({ threadId, wakeId, totalText }) => [threadId, { wakeId, totalText }]));
      const restore = (thread: ThreadState): ThreadState => ({
        ...thread, streamingAssistant: messageStreams.get(thread.threadId ?? "") ?? null
      });
      return {
        messageStreams,
        threadsByScope: new Map([...state.threadsByScope].map(([key, thread]) => [key, restore(thread)])),
        sideThread: state.sideThread ? restore(state.sideThread) : null
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
        return {
          messageStreams, threadsByScope,
          sideThread: state.sideThread?.threadId === threadId ? { ...state.sideThread, streamingAssistant } : state.sideThread
        };
      });
      return true;
    },

    onMessageDelta: (threadId: string, wakeId: string, _deltaText: string, totalText: string) => {
      if (get().sideThread?.threadId === threadId) {
        updateSideThread(set, get, (thread) => ({
          ...thread,
          streamingAssistant: { wakeId, totalText }
        }));
        return;
      }
      const key = findScopeKeyByThreadId(get(), threadId);
      if (!key) return;
      updateThreadByKey(set, key, (t) => ({
        ...t,
        streamingAssistant: { wakeId, totalText }
      }));
    },

    onWakeStarted: (
      threadId: string,
      wakeId: string,
      reason: AgentWakeReason,
      metadata?: AgentWakeMetadata | null
    ) => {
      if (get().sideThread?.threadId === threadId) {
        updateSideThread(set, get, (thread) => ({
          ...thread,
          wakeReasonsById: withWakeReason(thread.wakeReasonsById, wakeId, reason),
          wakeMetadataById: withWakeMetadata(thread.wakeMetadataById, wakeId, metadata),
          wakePhase: { wakeId, phase: "thinking" },
          lastWakeError: null
        }));
        return;
      }
      const key = findScopeKeyByThreadId(get(), threadId);
      if (!key) return;
      updateThreadByKey(set, key, (t) => ({
        ...t,
        wakeReasonsById: withWakeReason(t.wakeReasonsById, wakeId, reason),
        wakeMetadataById: withWakeMetadata(t.wakeMetadataById, wakeId, metadata),
        wakePhase: { wakeId, phase: "thinking" },
        // New wake supersedes any prior error display.
        lastWakeError: null
      }));
    },

    onContextUsageUpdated: (threadId: string, _wakeId: string, contextUsage: AgentContextUsage) => {
      if (get().sideThread?.threadId === threadId) {
        updateSideThread(set, get, (thread) => ({ ...thread, contextUsage }));
        return;
      }
      const key = findScopeKeyByThreadId(get(), threadId);
      if (!key) return;
      updateThreadByKey(set, key, (t) => ({
        ...t,
        contextUsage
      }));
    },

    onWakeFinished: (
      threadId: string,
      wakeId: string,
      status: string,
      errorMessage?: string | null,
      contextUsage?: AgentContextUsage | null,
      userError?: AgentWakeUserErrorDto | null
    ) => {
      clearMessageStream(set, get, threadId, wakeId);
      const error: WakeError | null =
        status === "error" || status === "limit_reached"
          ? {
              wakeId,
              status,
              message:
                userError?.message ??
                errorMessage ??
                (status === "limit_reached" ? "Wake hit step limit." : "Agent wake failed."),
              ...(userError?.category ? { category: userError.category } : {}),
              ...(userError?.code ? { code: userError.code } : {}),
              ...(userError?.retryable !== undefined ? { retryable: userError.retryable } : {}),
              ...(userError?.detail ? { detail: userError.detail } : {})
            }
          : null;
      if (get().sideThread?.threadId === threadId) {
        updateSideThread(set, get, (thread) => ({
          ...thread,
          wakePhase: { wakeId, phase: "idle" },
          streamingAssistant: thread.streamingAssistant?.wakeId === wakeId
            ? null
            : thread.streamingAssistant,
          contextUsage: contextUsage ?? thread.contextUsage,
          lastWakeError: error
        }));
        return;
      }
      const key = findScopeKeyByThreadId(get(), threadId);
      if (!key) return;
      updateThreadByKey(set, key, (t) => ({
        ...t,
        wakePhase: { wakeId, phase: "idle" },
        streamingAssistant: t.streamingAssistant?.wakeId === wakeId ? null : t.streamingAssistant,
        contextUsage: contextUsage ?? t.contextUsage,
        // Set on failure; clear on success (already cleared by onWakeStarted, but
        // belt-and-suspenders for any case where that event was missed).
        lastWakeError: error
      }));
    },

    onCompressionStarted: (threadId: string, compressionId: string, startedAt: string) => {
      if (get().sideThread?.threadId === threadId) {
        updateSideThread(set, get, (thread) => ({
          ...thread,
          compressionPhase: { compressionId, startedAt }
        }));
        return;
      }
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
      if (get().sideThread?.threadId === threadId) {
        updateSideThread(set, get, clear);
        return;
      }
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

function updateSideThread(
  set: AgentChatSet,
  get: AgentChatGet,
  mutate: (thread: ThreadState) => ThreadState
): void {
  const current = get().sideThread;
  if (!current) return;
  set({ sideThread: mutate(current) });
}
