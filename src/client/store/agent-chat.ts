import { create } from "zustand";
import {
  cancelWake as postWakeCancel,
  closeSideThread,
  createSideThread,
  deleteQueuedMessage as deleteQueuedMessageOnServer,
  deleteThreadQueuedMessage,
  endpointBase,
  fetchSideSummaryDraft,
  fetchThreadById,
  fetchThreadPage,
  postMessage,
  postThreadMessage,
  retargetSideSummary as retargetSideSummaryOnServer,
  transferSideSummary as transferSideSummaryOnServer
} from "./agent-chat-api";
import {
  genLocalId,
  lastSeq,
  mergeMessages,
  mergeWakeMetadata,
  mergeWakeReasons,
  newThreadState,
  reconcilePendingWithMessages,
  scopeFromKey,
  scopeKey,
  withWakeReason
} from "./agent-chat-utils";
import { refetchScopeSince, updateThread } from "./agent-chat-store-helpers";
import { createSseHandlers } from "./agent-chat-sse-handlers";
import type { AgentChatScope, AgentChatSet, AgentChatStore, ThreadState } from "./agent-chat-types";

export const CHAT_DRAWER_OPEN_STORAGE_KEY = "mandate.chat.drawerOpen.v1";

const defaultDrawerScope: AgentChatScope = { type: "manager" };

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readChatDrawerOpenPreference(): boolean | null {
  const storage = safeLocalStorage();
  if (!storage) return null;
  const raw = storage.getItem(CHAT_DRAWER_OPEN_STORAGE_KEY);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

function writeChatDrawerOpenPreference(open: boolean): void {
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(CHAT_DRAWER_OPEN_STORAGE_KEY, open ? "true" : "false");
  } catch {
    // UI preference only; failure should not block chat.
  }
}

function isDesktopViewport(): boolean {
  if (typeof window === "undefined") return true;
  if (typeof window.matchMedia === "function") {
    return window.matchMedia("(min-width: 768px)").matches;
  }
  return typeof window.innerWidth === "number" ? window.innerWidth >= 768 : true;
}

export function getInitialChatDrawerState(): Pick<AgentChatStore, "drawerOpen" | "drawerScope"> {
  const storedOpen = readChatDrawerOpenPreference();
  const drawerOpen = storedOpen ?? isDesktopViewport();
  return {
    drawerOpen,
    drawerScope: drawerOpen ? defaultDrawerScope : null
  };
}

export type {
  AgentChatScope,
  AgentChatStore,
  AgentContextUsage,
  AgentMessage,
  PendingMessage,
  ThreadState
} from "./agent-chat-types";
export { newThreadState, scopeFromKey, scopeKey } from "./agent-chat-utils";

const initialDrawerState = getInitialChatDrawerState();

// Boot hydration and the mounted chat panel can request the same scope together.
const threadLoads = new Map<string, { threadId: string | null; request: Promise<void> }>();

export const useAgentChatStore = create<AgentChatStore>((set, get) => ({
  drawerOpen: initialDrawerState.drawerOpen,
  drawerScope: initialDrawerState.drawerScope,
  drawerMode: "side",
  threadsByScope: new Map(),
  messageStreams: new Map(),
  sideThread: null,
  sideParentScope: null,
  sideActive: false,
  sideTransferNeedsRetargetId: null,
  pendingChatRef: null,

  openDrawerWithWorkItemRef: (scope, ref) => {
    get().openDrawer(scope);
    set({ pendingChatRef: { scope, ref } });
  },

  clearChatRef: () => set({ pendingChatRef: null }),

  openDrawer: (scope) =>
    set((state) => {
      writeChatDrawerOpenPreference(true);
      const key = scopeKey(scope);
      const next = new Map(state.threadsByScope);
      if (!next.has(key)) next.set(key, newThreadState());
      const t = next.get(key)!;
      next.set(key, { ...t, unreadAssistantCount: 0 });
      return { drawerOpen: true, drawerScope: scope, threadsByScope: next, sideActive: false };
    }),

  closeDrawer: () =>
    set(() => {
      writeChatDrawerOpenPreference(false);
      return {
        drawerOpen: false,
        drawerMode: "side"
      };
    }),

  setDrawerMode: (mode) => set((state) => {
    // Worker zoom hides an open dock. Mark only the conversation that becomes
    // visible as read when restoring; a closed dock still has unread replies.
    if (state.drawerMode !== "worker" || mode === "worker" || !state.drawerOpen) {
      return { drawerMode: mode };
    }
    if (state.sideActive) {
      return {
        drawerMode: mode,
        sideThread: state.sideThread ? { ...state.sideThread, unreadAssistantCount: 0 } : null
      };
    }
    return { drawerMode: mode, ...clearVisibleMainUnread({ ...state, drawerMode: mode }) };
  }),

  startSideConversation: async (scope) => {
    await get().ensureThreadLoaded(scope);
    const parent = get().threadsByScope.get(scopeKey(scope));
    if (!parent?.threadId) throw new Error("main conversation has not started");
    const fork = await createSideThread(parent.threadId);
    const page = await fetchThreadById(fork.thread.id);
    const messages = mergeMessages([], page.messages);
    set({
      sideThread: {
        ...newThreadState(),
        threadId: fork.thread.id,
        streamingAssistant: get().messageStreams.get(fork.thread.id) ?? null,
        messages,
        wakeReasonsById: mergeWakeReasons(new Map(), messages),
        wakeMetadataById: mergeWakeMetadata(new Map(), messages),
        oldestSeqLoaded: messages[0]?.seq ?? null,
        hasMoreOlder: page.hasMore,
        contextUsage: page.contextUsage
      },
      sideParentScope: scope,
      sideActive: true
    });
  },

  showMainConversation: () => set((state) => ({ sideActive: false, ...clearVisibleMainUnread(state) })),
  showSideConversation: () => {
    if (get().sideThread) set({ sideActive: true });
  },

  closeSideConversation: async () => {
    const threadId = get().sideThread?.threadId;
    if (!threadId) return;
    await closeSideThread(threadId);
    set((state) => ({ sideThread: null, sideParentScope: null, sideActive: false, ...clearVisibleMainUnread(state) }));
  },

  sendSideMessage: async (content, attachments = []) => {
    const threadId = get().sideThread?.threadId;
    if (!threadId) return "failed";
    const localId = genLocalId();
    const createdAt = new Date().toISOString();
    updateSideThread(set, (thread) => {
      const pendingUserMessages = new Map(thread.pendingUserMessages);
      pendingUserMessages.set(localId, {
        localId, content, attachments, status: "sending", createdAt
      });
      return { ...thread, pendingUserMessages };
    });
    try {
      const result = await postThreadMessage(threadId, content, attachments, localId);
      updateSideThread(set, (thread) => {
        const pendingUserMessages = new Map(thread.pendingUserMessages);
        const pending = pendingUserMessages.get(localId);
        if (pending) {
          pendingUserMessages.set(localId, {
            ...pending,
            status: result.queued ? "queued" : "sent",
            ...(result.messageId ? { messageId: result.messageId } : {})
          });
        }
        return {
          ...thread,
          pendingUserMessages,
          wakeReasonsById: result.wakeId
            ? withWakeReason(thread.wakeReasonsById, result.wakeId, "user")
            : thread.wakeReasonsById,
          wakePhase: result.wakeId
            ? { wakeId: result.wakeId, phase: "thinking" }
            : thread.wakePhase
        };
      });
      return result.queued ? "queued" : "sent";
    } catch (err) {
      updateSideThread(set, (thread) => {
        const pendingUserMessages = new Map(thread.pendingUserMessages);
        const pending = pendingUserMessages.get(localId);
        if (pending) pendingUserMessages.set(localId, {
          ...pending,
          status: "failed",
          error: err instanceof Error ? err.message : String(err)
        });
        return { ...thread, pendingUserMessages };
      });
      return "failed";
    }
  },

  retrySideFailedMessage: async (localId) => {
    const failed = get().sideThread?.pendingUserMessages.get(localId);
    if (!failed || failed.status !== "failed") return;
    updateSideThread(set, (thread) => {
      const pendingUserMessages = new Map(thread.pendingUserMessages);
      pendingUserMessages.delete(localId);
      return { ...thread, pendingUserMessages };
    });
    await get().sendSideMessage(failed.content, failed.attachments ?? []);
  },

  deleteSideQueuedMessage: async (localId) => {
    const thread = get().sideThread;
    const pending = thread?.pendingUserMessages.get(localId);
    if (!thread?.threadId || !pending || pending.status !== "queued") return;
    await deleteThreadQueuedMessage(thread.threadId, localId);
    updateSideThread(set, (current) => {
      const pendingUserMessages = new Map(current.pendingUserMessages);
      pendingUserMessages.delete(localId);
      return { ...current, pendingUserMessages };
    });
  },

  dismissSideWakeError: () => updateSideThread(set, (thread) => ({
    ...thread,
    lastWakeError: null
  })),

  cancelSideWake: async () => {
    const wakeId = get().sideThread?.wakePhase.wakeId;
    if (!wakeId || get().sideThread?.wakePhase.phase === "idle") return;
    await postWakeCancel(wakeId);
  },

  getSideSummaryDraft: async () => {
    const threadId = get().sideThread?.threadId;
    if (!threadId) return "";
    return fetchSideSummaryDraft(threadId);
  },

  transferSideSummary: async (content) => {
    const threadId = get().sideThread?.threadId;
    if (!threadId) throw new Error("side conversation is not open");
    const result = await transferSideSummaryOnServer(threadId, content, genLocalId());
    const status = result.transfer.status === "delivered"
      ? "delivered"
      : result.transfer.status === "needs_retarget"
        ? "needs_retarget"
        : "pending";
    if (status === "needs_retarget") {
      set({ sideTransferNeedsRetargetId: result.transfer.id });
    }
    return { status, transferId: result.transfer.id };
  },

  retargetSideSummary: async (transferId) => {
    const scope = get().sideParentScope ?? get().drawerScope;
    if (!scope) throw new Error("side parent scope is unavailable");
    await get().ensureThreadLoaded(scope);
    const targetThreadId = get().threadsByScope.get(scopeKey(scope))?.threadId;
    if (!targetThreadId) throw new Error("current main conversation is unavailable");
    const result = await retargetSideSummaryOnServer(transferId, targetThreadId);
    if (result.transfer.status === "delivered") set({ sideTransferNeedsRetargetId: null });
    return result.transfer.status === "delivered" ? "delivered" : "pending";
  },

  onSideTransferUpdated: (transfer) => set({
    sideTransferNeedsRetargetId: transfer.status === "needs_retarget"
      ? transfer.id
      : get().sideTransferNeedsRetargetId === transfer.id
        ? null
        : get().sideTransferNeedsRetargetId
  }),

  sendMessage: async (scope, content, attachments = [], workItemRef) => {
    const localId = genLocalId();
    const createdAt = new Date().toISOString();
    updateThread(set, scope, (t) => {
      const m = new Map(t.pendingUserMessages);
      m.set(localId, { localId, content, attachments, status: "sending", createdAt });
      return { ...t, pendingUserMessages: m };
    });
    try {
      const { threadId, messageId, wakeId, queued } = await postMessage(
        scope,
        content,
        attachments,
        localId,
        workItemRef
      );
      let catchUpSince: number | null = null;
      updateThread(set, scope, (t) => {
        const existing = t.pendingUserMessages.get(localId);
        // A first send may bind an empty conversation, but a reset must not
        // bind an old response after discarding its pending entry.
        if (!existing && t.threadId !== threadId) return t;
        const m = new Map(t.pendingUserMessages);
        if (existing) m.set(localId, {
          ...existing,
          status: queued ? "queued" : "sent",
          ...(messageId ? { messageId } : {})
        });
        // Another tab may have rotated the server's active conversation.
        // Settle our send without attributing that conversation's wake here.
        if (t.threadId !== null && t.threadId !== threadId) return { ...t, pendingUserMessages: m };
        // Hydration can reconcile the user message before the POST response
        // supplies its wake. Only the phase records lifecycle state; history
        // can contain wake metadata even when its start event was missed.
        const wakeObserved = wakeId && t.wakePhase.wakeId === wakeId;
        if (!existing && (!wakeId || wakeObserved)) return t;
        if (t.threadId === null) catchUpSince = lastSeq(t);
        return {
          ...t,
          threadId: t.threadId ?? threadId,
          streamingAssistant: get().messageStreams.get(t.threadId ?? threadId) ?? t.streamingAssistant,
          wakeReasonsById: wakeId
            ? withWakeReason(t.wakeReasonsById, wakeId, "user")
            : t.wakeReasonsById,
          wakePhase: wakeId && !wakeObserved ? { wakeId, phase: "thinking" } : t.wakePhase,
          pendingUserMessages: m
        };
      });
      if (catchUpSince !== null) {
        refetchScopeSince(set, get, scope, catchUpSince).catch(() => {
          // SSE should deliver future events; reconnect catch-up handles this if the one-shot fetch fails.
        });
      }
      return queued ? "queued" : "sent";
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      updateThread(set, scope, (t) => {
        const existing = t.pendingUserMessages.get(localId);
        if (!existing) return t;
        const m = new Map(t.pendingUserMessages);
        m.set(localId, { ...existing, status: "failed", error });
        return { ...t, pendingUserMessages: m };
      });
      return "failed";
    }
  },

  retryFailedMessage: async (scope, localId) => {
    const key = scopeKey(scope);
    const t = get().threadsByScope.get(key);
    const old = t?.pendingUserMessages.get(localId);
    if (!old || old.status !== "failed") return;
    updateThread(set, scope, (curr) => {
      const m = new Map(curr.pendingUserMessages);
      m.delete(localId);
      return { ...curr, pendingUserMessages: m };
    });
    await get().sendMessage(scope, old.content, old.attachments ?? []);
  },

  deleteQueuedMessage: async (scope, localId) => {
    const key = scopeKey(scope);
    const pending = get().threadsByScope.get(key)?.pendingUserMessages.get(localId);
    if (!pending || pending.status !== "queued") return;
    await deleteQueuedMessageOnServer(scope, localId);
    updateThread(set, scope, (t) => {
      const m = new Map(t.pendingUserMessages);
      m.delete(localId);
      return { ...t, pendingUserMessages: m };
    });
  },

  ensureThreadLoaded: async (scope) => {
    const key = scopeKey(scope);
    const existing = get().threadsByScope.get(key);
    const threadId = existing?.threadId ?? null;
    const pending = threadLoads.get(key);
    if (pending?.threadId === threadId) return threadId === null ? pending.request : undefined;
    const request = (async () => {
      // Already loaded — kick off an incremental refetch so any messages that
      // arrived while we were away (dropped SSE events, silent reconnects,
      // background-tab throttling) show up without a page reload.
      if (existing && existing.threadId !== null) {
        await refetchScopeSince(set, get, scope, lastSeq(existing)).catch(() => {
          // ignore — SSE will retry on its own reconnect
        });
        return;
      }
      const r = await fetchThreadPage(scope);
      updateThread(set, scope, (t) => {
        const fetchedThreadId = r.thread?.id ?? null;
        if (t.threadId !== null && t.threadId !== fetchedThreadId) return t;
        const messages = mergeMessages(t.messages, r.messages);
        return {
          ...t,
          threadId: t.threadId ?? fetchedThreadId,
          streamingAssistant: get().messageStreams.get(t.threadId ?? fetchedThreadId ?? "") ?? t.streamingAssistant,
          messages,
          wakeReasonsById: mergeWakeReasons(t.wakeReasonsById, messages),
          wakeMetadataById: mergeWakeMetadata(t.wakeMetadataById, messages),
          pendingUserMessages: reconcilePendingWithMessages(t.pendingUserMessages, messages),
          oldestSeqLoaded: messages.length > 0 ? messages[0]!.seq : null,
          hasMoreOlder: (t.threadId ?? fetchedThreadId) !== null && r.hasMore,
          contextUsage: r.contextUsage
        };
      });
    })().finally(() => {
      if (threadLoads.get(key)?.request === request) threadLoads.delete(key);
    });
    threadLoads.set(key, { threadId, request });
    // Existing threads refresh in the background; opening Side must not wait
    // for an unrelated history read. Only initial hydration blocks callers.
    return threadId === null ? request : undefined;
  },

  loadOlder: async (scope) => {
    const key = scopeKey(scope);
    const t = get().threadsByScope.get(key);
    if (!t?.threadId || t.oldestSeqLoaded === null || !t.hasMoreOlder) return;
    const r = await fetchThreadPage(scope, t.oldestSeqLoaded);
    updateThread(set, scope, (curr) => {
      if (curr.threadId !== t.threadId || r.thread?.id !== t.threadId) return curr;
      if (r.messages.length === 0) return { ...curr, hasMoreOlder: false };
      return {
        ...curr,
        messages: [...r.messages, ...curr.messages],
        wakeReasonsById: mergeWakeReasons(curr.wakeReasonsById, r.messages),
        wakeMetadataById: mergeWakeMetadata(curr.wakeMetadataById, r.messages),
        oldestSeqLoaded: r.messages[0]!.seq,
        hasMoreOlder: r.hasMore,
        contextUsage: r.contextUsage ?? curr.contextUsage
      };
    });
  },

  ...createSseHandlers(set, get),

  dismissWakeError: (scope) => updateThread(set, scope, (t) => ({ ...t, lastWakeError: null })),

  cancelWake: async (scope) => {
    const key = scopeKey(scope);
    const current = get().threadsByScope.get(key);
    const wakeId = current?.wakePhase.wakeId ?? null;
    if (!wakeId || current?.wakePhase.phase === "idle") return;
    updateThread(set, scope, (t) => ({
      ...t,
      wakePhase: { wakeId, phase: "idle" },
      streamingAssistant: t.streamingAssistant?.wakeId === wakeId ? null : t.streamingAssistant
    }));
    try {
      await postWakeCancel(wakeId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateThread(set, scope, (t) => ({
        ...t,
        lastWakeError: { wakeId, status: "error", message }
      }));
    }
  },

  startNewChat: async (scope) => {
    const r = await fetch(`${endpointBase(scope)}/new-chat`, { method: "POST" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = (await r.json()) as { newThreadId?: string };
    set((state) => {
      const next = new Map(state.threadsByScope);
      next.set(scopeKey(scope), { ...newThreadState(), threadId: body.newThreadId ?? null });
      return { threadsByScope: next };
    });
  },

  refetchIncrementalForOpenScopes: async () => {
    const entries: Array<{ scope: AgentChatScope; lastSeq: number }> = [];
    for (const [key, t] of get().threadsByScope) {
      if (t.threadId === null) continue;
      const scope = scopeFromKey(key);
      if (!scope) continue;
      entries.push({ scope, lastSeq: lastSeq(t) });
    }
    await Promise.all(
      entries.map(async ({ scope, lastSeq }) => {
        try {
          await refetchScopeSince(set, get, scope, lastSeq);
        } catch {
          /* ignore — next reconnect will retry */
        }
      })
    );
    const sideId = get().sideThread?.threadId;
    if (sideId) {
      try {
        const side = get().sideThread!;
        const page = await fetchThreadById(sideId, undefined, lastSeq(side));
        if (get().sideThread?.threadId !== sideId) return;
        for (const message of page.messages) get().onMessageAppended(sideId, message, true);
      } catch { /* ignore — next reconnect will retry */ }
    }
  }
}));

/** State patch shared by actions that bring the main conversation into view. */
function clearVisibleMainUnread(state: AgentChatStore): Partial<Pick<AgentChatStore, "threadsByScope">> {
  if (!state.drawerOpen || state.drawerMode === "worker" || !state.drawerScope) return {};
  const key = scopeKey(state.drawerScope);
  const thread = state.threadsByScope.get(key);
  if (!thread?.unreadAssistantCount) return {};
  const threadsByScope = new Map(state.threadsByScope);
  threadsByScope.set(key, { ...thread, unreadAssistantCount: 0 });
  return { threadsByScope };
}

function updateSideThread(
  set: AgentChatSet,
  mutate: (thread: ThreadState) => ThreadState
): void {
  set((state: AgentChatStore) => state.sideThread
    ? { sideThread: mutate(state.sideThread) }
    : {});
}
