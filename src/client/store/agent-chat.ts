import { create } from "zustand";
import { toast } from "sonner";
import {
  cancelWake as postWakeCancel,
  retryWake as postWakeRetry,
  deleteScopeQueuedMessage,
  fetchScopePage,
  postScopeMessage,
  skipThreadQuestion,
  SUBAGENT_READ_ONLY,
  type MessageMark
} from "./agent-chat-api";
import {
  genLocalId,
  lastSeq,
  mergeMessages,
  mergeWakeMetadata,
  mergeWakeReasons,
  newThreadState,
  reconcilePendingWithMessages,
  reconcileMonitorsRead,
  reconcileWakeRead,
  scopeFromKey,
  scopeKey,
  withWakeReason
} from "./agent-chat-utils";
import { generationOf, refetchScopeSince, retireEntry, updateThread } from "./agent-chat-store-helpers";
import { createSseHandlers } from "./agent-chat-sse-handlers";
import { useInterruptedWakesStore } from "./interrupted-wakes";
import type { AgentChatGet, AgentChatSet, AgentChatStore, ChatThreadScope } from "./agent-chat-types";
import type { AgentMessageAttachment } from "@shared/agent-message-types";
import type { AnsweredQuestion } from "@shared/questions";
import type { Mention } from "@shared/mentions";
import { errorText } from "@shared/error-text";

export type {
  AgentChatScope,
  AgentContextUsage,
  AgentMessage,
  ChatThreadScope,
  PendingMessage,
  ThreadState
} from "./agent-chat-types";
export { newThreadState, scopeFromKey, scopeKey } from "./agent-chat-utils";
export { generationOf } from "./agent-chat-store-helpers";

// Boot hydration and the mounted chat panel can request the same scope together.
const threadLoads = new Map<string, { threadId: string | null; request: Promise<void> }>();
// How many views hold each conversation that is let go when none does
// (holdThread), and the timer that lets go of one none holds.
const holds = new Map<string, number>();
const releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** How long one no view shows is kept before it is let go: closed and opened
 *  again soon after (a step left and come back to), it is drawn from what is
 *  kept, not read again. */
export const RELEASE_AFTER_MS = 60_000;

/** One message of the user's, shown at once and settled by the server's
 *  answer. `mark`: the open questions it answers by a pick, or the control
 *  that sent it. A marked message that does not go (a pick whose question
 *  closed meanwhile, a Continue that could not be sent) is taken away again:
 *  it is not words to keep and send once more, as a typed one that failed is. */
async function sendUserMessage(
  set: AgentChatSet,
  get: AgentChatGet,
  scope: ChatThreadScope,
  content: string,
  attachments: AgentMessageAttachment[],
  mark?: MessageMark,
  answering?: AnsweredQuestion[],
  mentions?: Mention[]
): Promise<{ status: "sent" | "queued" } | { status: "failed"; error: string }> {
  // Nothing is sent to a subagent: no pending message, no request.
  if (scope.type === "subagent") return { status: "failed", error: SUBAGENT_READ_ONLY };
  const localId = genLocalId();
  const createdAt = new Date().toISOString();
  updateThread(set, scope, (t) => {
    const m = new Map(t.pendingUserMessages);
    m.set(localId, {
      localId, content, attachments, status: "sending", createdAt,
      ...(answering ? { answers: answering } : {}),
      ...(mentions && mentions.length > 0 ? { mentions } : {})
    });
    return { ...t, pendingUserMessages: m };
  });
  try {
    const { threadId, messageId, wakeId, wakeStartedAt, queued } = await postScopeMessage(
      scope,
      content,
      attachments,
      localId,
      mark,
      mentions
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
        wakePhase: wakeId && !wakeObserved
          ? { wakeId, phase: "thinking", ...(wakeStartedAt ? { startedAt: wakeStartedAt } : {}) }
          : t.wakePhase,
        pendingUserMessages: m
      };
    });
    if (catchUpSince !== null) {
      refetchScopeSince(set, get, scope, catchUpSince).catch(() => {
        // SSE should deliver future events; reconnect catch-up handles this if the one-shot fetch fails.
      });
    }
    return { status: queued ? "queued" : "sent" };
  } catch (err) {
    const error = errorText(err);
    updateThread(set, scope, (t) => {
      const existing = t.pendingUserMessages.get(localId);
      if (!existing) return t;
      const m = new Map(t.pendingUserMessages);
      if (mark) m.delete(localId);
      else m.set(localId, { ...existing, status: "failed", error });
      return { ...t, pendingUserMessages: m };
    });
    return { status: "failed", error };
  }
}

export const useAgentChatStore = create<AgentChatStore>((set, get) => ({
  threadsByScope: new Map(),
  messageStreams: new Map(),

  sendMessage: async (scope, content, attachments = [], mentions) =>
    (await sendUserMessage(set, get, scope, content, attachments, undefined, undefined, mentions)).status,

  answerQuestion: async (scope, question, label) => {
    const sent = await sendUserMessage(set, get, scope, label, [], { answers: [question.id] }, [{ id: question.id, question: question.question }]);
    return sent.status === "failed" ? sent.error : null;
  },

  skipQuestion: async (scope, questionId) => {
    // Only a manager thread or the agent asks the user; a worker's plan does.
    if (scope.type === "worker") return "A worker's question cannot be skipped.";
    if (scope.type === "subagent") return SUBAGENT_READ_ONLY;
    try {
      await skipThreadQuestion(scope.threadId, questionId);
      return null;
    } catch (err) {
      return errorText(err);
    }
  },

  continueTurn: async (scope) => {
    await sendUserMessage(set, get, scope, "Continue", [], { control: "continue" });
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
    await get().sendMessage(scope, old.content, old.attachments ?? [], old.mentions);
  },

  deleteQueuedMessage: async (scope, localId) => {
    const key = scopeKey(scope);
    const pending = get().threadsByScope.get(key)?.pendingUserMessages.get(localId);
    if (!pending || pending.status !== "queued") return;
    await deleteScopeQueuedMessage(scope, localId);
    updateThread(set, scope, (t) => {
      const m = new Map(t.pendingUserMessages);
      m.delete(localId);
      return { ...t, pendingUserMessages: m };
    });
  },

  ensureThreadLoaded: async (scope) => {
    const key = scopeKey(scope);
    const existing = get().threadsByScope.get(key);
    // Loaded once a page arrived, empty or not. A manager thread's entry
    // carries its id before that (seeded below), and live messages can land
    // in it before that too: only the flag says a page arrived.
    const loaded = existing?.threadId != null && existing.loaded;
    const threadId = loaded ? existing!.threadId : null;
    const pending = threadLoads.get(key);
    if (pending?.threadId === threadId) return threadId === null ? pending.request : undefined;
    const load = (async (): Promise<number | null> => {
      // Already loaded — kick off an incremental refetch so any messages that
      // arrived while we were away (dropped SSE events, silent reconnects,
      // background-tab throttling) show up without a page reload.
      if (loaded) {
        await refetchScopeSince(set, get, scope, lastSeq(existing!)).catch(() => {
          // ignore — SSE will retry on its own reconnect
        });
        return null;
      }
      // A read for this entry: let go meanwhile, it writes nothing.
      const generation = generationOf(key);
      // The entry exists from here on. A manager thread's id is known: bind
      // it now, so a send before the page arrives lands in this thread. A
      // worker's may not exist yet: its first wake binds it here if that
      // comes first.
      if (!existing) {
        set((state) => (state.threadsByScope.has(key) ? {} : {
          threadsByScope: new Map(state.threadsByScope).set(key, {
            ...newThreadState(), threadId: scope.type === "worker" ? null : scope.threadId
          })
        }));
      }
      let r = await fetchScopePage(scope);
      // A worker's thread was named while this read was on its way, by its
      // first wake, and the read, made before, found none: read again, for
      // the thread named.
      const named = get().threadsByScope.get(key)?.threadId ?? null;
      if (named !== null && named !== (r.thread?.id ?? null)) r = await fetchScopePage(scope);
      updateThread(set, scope, (t) => {
        const fetchedThreadId = r.thread?.id ?? null;
        if (generationOf(key) !== generation) return t;
        if (t.threadId !== null && t.threadId !== fetchedThreadId) return t;
        const messages = mergeMessages(t.messages, r.messages);
        return reconcileMonitorsRead(reconcileWakeRead({
          ...t,
          threadId: t.threadId ?? fetchedThreadId,
          streamingAssistant: get().messageStreams.get(t.threadId ?? fetchedThreadId ?? "") ?? t.streamingAssistant,
          messages,
          wakeReasonsById: mergeWakeReasons(t.wakeReasonsById, messages),
          wakeMetadataById: mergeWakeMetadata(t.wakeMetadataById, messages),
          pendingUserMessages: reconcilePendingWithMessages(t.pendingUserMessages, messages),
          oldestSeqLoaded: messages.length > 0 ? messages[0]!.seq : null,
          hasMoreOlder: (t.threadId ?? fetchedThreadId) !== null && r.hasMore,
          contextUsage: r.contextUsage,
          loaded: true
        }, r), r);
      });
      if (generationOf(key) !== generation || get().threadsByScope.get(key)?.threadId !== (r.thread?.id ?? null)) return null;
      return r.messages.reduce((top, message) => Math.max(top, message.seq), 0);
    })();
    const done = () => {
      if (threadLoads.get(key)?.request === request) threadLoads.delete(key);
    };
    const request: Promise<void> = load.then((top) => {
      done();
      // The page is whole up to its newest row as of when the server read
      // it. What came after reached the page live, or did not: a worker's
      // events had no thread to land in before the page named it, and a
      // reconnect during the read skips a thread whose first page is on the
      // way. One read on from the page's top closes that window; from then
      // on the thread is caught up like any loaded one.
      if (top !== null) void refetchScopeSince(set, get, scope, top).catch(() => {});
    }, (err: unknown) => {
      done();
      throw err;
    });
    threadLoads.set(key, { threadId, request });
    // Existing threads refresh in the background. Only initial hydration
    // blocks callers.
    return threadId === null ? request : undefined;
  },

  loadOlder: async (scope, apply = (write) => write()) => {
    const key = scopeKey(scope);
    const t = get().threadsByScope.get(key);
    if (!t?.threadId || t.oldestSeqLoaded === null || !t.hasMoreOlder) return;
    const generation = generationOf(key);
    const r = await fetchScopePage(scope, t.oldestSeqLoaded);
    // The server answered for another conversation than the one this scope
    // still shows (another client rotated it): the page cannot be taken, and
    // asked again it would answer the same, so this is a failure, not the
    // start. A scope that moved on meanwhile just drops the page.
    if (r.thread?.id !== t.threadId && get().threadsByScope.get(key)?.threadId === t.threadId) {
      throw new Error("The server answered with another conversation.");
    }
    apply(() => updateThread(set, scope, (curr) => {
      // Let go and read again meanwhile: the page was for the entry before.
      if (generationOf(key) !== generation) return curr;
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
    }));
  },

  ...createSseHandlers(set, get),

  retryWake: async (scope, wakeId) => {
    // A subagent's turns are its task's: only the task's Stop reaches them.
    if (scope.type === "subagent") return;
    try {
      await postWakeRetry(wakeId);
    } catch (err) {
      toast.error(`Could not retry: ${errorText(err)}`);
    }
    // Refused or not, the page learns where the thread stands: the retry's
    // wake if it started (its start event may never come), else the rest.
    const current = get().threadsByScope.get(scopeKey(scope));
    if (current?.loaded) await refetchScopeSince(set, get, scope, lastSeq(current)).catch(() => {});
  },

  cancelWake: async (scope) => {
    if (scope.type === "subagent") return;
    const key = scopeKey(scope);
    const current = get().threadsByScope.get(key);
    const wakeId = current?.wakePhase.wakeId ?? null;
    if (!wakeId || current?.wakePhase.phase === "idle") return;
    // Marked stopped before it is shown idle: idle and unmarked, it would
    // read as a turn that finished until its end event came.
    useInterruptedWakesStore.getState().stopping(wakeId);
    updateThread(set, scope, (t) => ({
      ...t,
      wakePhase: t.wakePhase.wakeId === wakeId ? { ...t.wakePhase, phase: "idle" } : { wakeId, phase: "idle" },
      streamingAssistant: t.streamingAssistant?.wakeId === wakeId ? null : t.streamingAssistant
    }));
    try {
      await postWakeCancel(wakeId);
    } catch (err) {
      toast.error(`Could not stop the turn: ${errorText(err)}`);
    }
  },

  holdThread: (scope) => {
    const key = scopeKey(scope);
    holds.set(key, (holds.get(key) ?? 0) + 1);
    // Shown again: the while it had left starts over at its next close.
    clearTimeout(releaseTimers.get(key));
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const left = (holds.get(key) ?? 1) - 1;
      if (left > 0) {
        holds.set(key, left);
        return;
      }
      holds.delete(key);
      releaseTimers.set(key, setTimeout(() => {
        releaseTimers.delete(key);
        // A read on its way for it writes nothing once it is gone (its
        // generation moves on), and the next view reads it anew.
        retireEntry(key);
        threadLoads.delete(key);
        set((state) => {
          if (!state.threadsByScope.has(key)) return {};
          const next = new Map(state.threadsByScope);
          next.delete(key);
          return { threadsByScope: next };
        });
      }, RELEASE_AFTER_MS));
    };
  },

  refetchIncrementalForOpenScopes: async () => {
    const entries: Array<{ scope: ChatThreadScope; lastSeq: number }> = [];
    const unbound: ChatThreadScope[] = [];
    for (const [key, t] of get().threadsByScope) {
      // A worker that had no conversation when its page read it: its first
      // wake, the event that binds it, may have come while the stream was
      // down, and nothing replays it. Read it again.
      if (t.threadId === null) {
        const scope = scopeFromKey(key);
        if (scope?.type === "worker") unbound.push(scope);
        continue;
      }
      // Its first page is on the way and covers this. A manager thread's id
      // is bound before that page, and a catch-up from 0 would read it all.
      if (threadLoads.get(key)?.threadId === null) continue;
      const scope = scopeFromKey(key);
      if (!scope) continue;
      entries.push({ scope, lastSeq: lastSeq(t) });
    }
    await Promise.all([
      ...entries.map(async ({ scope, lastSeq }) => {
        try {
          await refetchScopeSince(set, get, scope, lastSeq);
        } catch {
          /* ignore — next reconnect will retry */
        }
      }),
      ...unbound.map((scope) => get().ensureThreadLoaded(scope)?.catch(() => {
        /* ignore — next reconnect will retry */
      }))
    ]);
  }
}));
