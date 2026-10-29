import { beforeEach, describe, expect, test } from "bun:test";
import {
  newThreadState, scopeKey, useAgentChatStore,
  type AgentChatScope, type AgentMessage, type ThreadState
} from "@/store/agent-chat";
import type { AgentContextUsageDto, AgentThreadDto, AgentThreadResponse } from "@shared/api-contracts";
import { mockFetch } from "../helpers/fetch.js";

const now = "2026-09-15T00:00:00.000Z";
const usage: AgentContextUsageDto = {
  inputTokens: 8000, budgetTokens: 20000, updatedAt: now, source: "compression_budget"
};
const state = () => useAgentChatStore.getState();

function message(threadId: string, seq: number): AgentMessage {
  return {
    id: `${threadId}-${seq}`, threadId, seq, role: "assistant", source: "self",
    sourceThreadId: null, wakeId: "old-wake", wakeReason: "user",
    content: { type: "assistant", text: `Reply ${seq}` }, createdAt: now
  };
}

function page(scope: AgentChatScope, threadId: string | null, messages: AgentMessage[] = []): AgentThreadResponse {
  const thread: AgentThreadDto | null = threadId ? {
    id: threadId, scope: scope.type, scopeId: scope.type === "worker" ? scope.featureId : null,
    createdAt: now, updatedAt: now, archivedAt: null, title: null, seenSeq: 0
  } : null;
  return { thread, messages, hasMore: false, contextUsage: usage };
}

function deferResponses() {
  const requests: Array<{
    url: string;
    body: { clientRequestId?: string };
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
  }> = [];
  mockFetch(({ url, init }) => {
    return new Promise<Response>((resolve, reject) => {
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {}, resolve, reject });
    });
  });
  return requests;
}

function seed(scope: AgentChatScope, overrides: Partial<ThreadState> = {}) {
  useAgentChatStore.setState({ threadsByScope: new Map([[scopeKey(scope), {
    ...newThreadState(), threadId: "old-thread", messages: [message("old-thread", 51)],
    oldestSeqLoaded: 51, hasMoreOlder: true, ...overrides
  }]]) });
}

// A worker's chat is addressed by its feature, so a response can name a
// conversation other than the one shown; a manager thread is addressed by id.
const scopes: Array<Extract<AgentChatScope, { type: "worker" }>> = [{ type: "worker", featureId: "worker-1" }];
for (const scope of scopes) {
  describe(`${scope.type} chat request identity`, () => {
    const thread = () => state().threadsByScope.get(scopeKey(scope))!;
    beforeEach(() => {
      useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
      seed(scope);
    });

    test("history validates the response thread as well as the local thread", async () => {
      const requests = deferResponses();
      const original = thread();
      const loading = state().loadOlder(scope);
      // Another client can rotate the server conversation before it handles
      // this scope-based request, while this client still displays the old one.
      // The page is not taken, and the load fails: asked again, the server
      // would answer the same, so it must not read as done.
      requests[0]!.resolve(Response.json(page(scope, "server-new-thread", [message("server-new-thread", 1)])));
      await expect(loading).rejects.toThrow("The server answered with another conversation.");
      expect(thread()).toBe(original);
    });

    test("a scope that moved on to another conversation meanwhile drops the page without failing", async () => {
      const requests = deferResponses();
      const loading = state().loadOlder(scope);
      // The scope shows the server's new conversation now: nothing asks for
      // the old one's history here any more.
      useAgentChatStore.setState((s) => ({
        threadsByScope: new Map(s.threadsByScope).set(scopeKey(scope), { ...newThreadState(), threadId: "server-new-thread" })
      }));
      const moved = thread();
      requests[0]!.resolve(Response.json(page(scope, "server-new-thread", [message("server-new-thread", 1)])));
      await loading;
      expect(thread()).toBe(moved);
    });

    test("ordinary scope navigation still allows history to populate its own cache", async () => {
      const requests = deferResponses();
      const loading = state().loadOlder(scope);
      // Another conversation opens meanwhile.
      useAgentChatStore.setState((s) => ({
        threadsByScope: new Map(s.threadsByScope).set("worker:another-worker", newThreadState())
      }));
      requests[0]!.resolve(Response.json(page(scope, "old-thread", [message("old-thread", 1)])));
      await loading;
      expect(thread().messages.map((m) => m.seq)).toEqual([1, 51]);
      expect(thread().contextUsage).toEqual(usage);
      expect(thread().oldestSeqLoaded).toBe(1);
      expect(thread().hasMoreOlder).toBe(false);
    });

    for (const queued of [false, true]) {
      test(`a different server thread settles a ${queued ? "queued" : "sent"} message without changing the current wake`, async () => {
        const requests = deferResponses();
        const sending = state().sendMessage(scope, "Hello");
        const current = thread();
        requests[0]!.resolve(Response.json({
          threadId: "different-thread", messageId: queued ? null : "message", wakeId: queued ? null : "wake", queued
        }));
        expect(await sending).toBe(queued ? "queued" : "sent");
        expect(thread().threadId).toBe("old-thread");
        expect(thread().wakePhase).toBe(current.wakePhase);
        expect(thread().wakeReasonsById).toBe(current.wakeReasonsById);
        expect(thread().messages).toBe(current.messages);
        const pending = [...thread().pendingUserMessages.values()][0]!;
        expect(pending.status).toBe(queued ? "queued" : "sent");
        if (queued) {
          const canceling = state().deleteQueuedMessage(scope, pending.localId);
          expect(requests[1]!.url).toContain(`/queued-messages/${pending.localId}`);
          requests[1]!.resolve(Response.json({ ok: true, removed: true }));
          await canceling;
          expect(thread().pendingUserMessages.size).toBe(0);
        }
      });
    }

    test("SSE reconciliation before the send response does not revive a completed wake", async () => {
      const requests = deferResponses();
      const sending = state().sendMessage(scope, "Hello");
      state().onMessageAppended("old-thread", {
        ...message("old-thread", 52), role: "user", source: "user", wakeId: null,
        content: { type: "text", text: "Hello", clientRequestId: requests[0]!.body.clientRequestId! }
      });
      state().onWakeStarted("old-thread", "old-wake", "user");
      state().onWakeFinished("old-thread", "old-wake", "finished");
      const current = thread();
      requests[0]!.resolve(Response.json({ threadId: "old-thread", messageId: "old-thread-52", wakeId: "old-wake" }));
      await sending;
      expect(thread()).toBe(current);
      expect(thread().pendingUserMessages.size).toBe(0);
      expect(thread().wakePhase.phase).toBe("idle");
    });

    test("initial hydration can reconcile the message before the send response supplies its wake", async () => {
      seed(scope, { ...newThreadState() });
      const requests = deferResponses();
      const loading = state().ensureThreadLoaded(scope);
      const sending = state().sendMessage(scope, "Hello");
      const sent: AgentMessage = {
        ...message("old-thread", 1), role: "user", source: "user", wakeId: null, wakeReason: null,
        content: { type: "text", text: "Hello", clientRequestId: requests[1]!.body.clientRequestId! }
      };
      const runtimeContext: AgentMessage = {
        ...message("old-thread", 2), role: "user", source: "runtime-context",
        content: { type: "text", text: "Runtime context", metadata: { runtimeContextKind: "state" } }
      };
      // These events arrive before this client's thread ID has been bound.
      state().onMessageAppended("old-thread", sent);
      state().onWakeStarted("old-thread", "old-wake", "user");
      requests[0]!.resolve(Response.json(page(scope, "old-thread", [sent, runtimeContext])));
      await loading;
      expect(thread().pendingUserMessages.size).toBe(0);
      expect(thread().wakePhase.phase).toBe("idle");
      expect(thread().wakeReasonsById.get("old-wake")).toBe("user");
      requests[1]!.resolve(Response.json({ threadId: "old-thread", messageId: sent.id, wakeId: "old-wake" }));
      await sending;
      expect(thread().wakePhase).toEqual({ wakeId: "old-wake", phase: "thinking" });
      expect(thread().pendingUserMessages.size).toBe(0);
      expect(thread().messages).toEqual([sent, runtimeContext]);
    });

    test("a late send response preserves a wake already finished before message reconciliation", async () => {
      const requests = deferResponses();
      const sending = state().sendMessage(scope, "Hello");
      state().onWakeFinished("old-thread", "old-wake", "finished");
      requests[0]!.resolve(Response.json({ threadId: "old-thread", messageId: "sent-message", wakeId: "old-wake" }));
      await sending;
      expect(thread().wakePhase).toEqual({ wakeId: "old-wake", phase: "idle" });
      expect([...thread().pendingUserMessages.values()][0]!.status).toBe("sent");
    });

    test("incremental refresh rejects a response for another server conversation", async () => {
      const requests = deferResponses();
      const current = thread();
      const refreshing = state().refetchIncrementalForOpenScopes();
      requests[0]!.resolve(Response.json(page(scope, "different-thread")));
      await refreshing;
      expect(thread()).toBe(current);
    });
  });
}
