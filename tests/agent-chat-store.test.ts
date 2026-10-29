import { afterEach, describe, expect, test } from "bun:test";
import {
  useAgentChatStore,
  scopeKey,
  scopeFromKey,
  newThreadState,
  AgentMessage,
  type AgentChatScope,
  type ChatThreadScope
} from "../src/client/store/agent-chat.js";
import type { Mention } from "../src/shared/mentions.js";
import { mockFetch } from "./helpers/fetch.js";
import { useInterruptedWakesStore } from "../src/client/store/interrupted-wakes.js";
import { onCleanup } from "./helpers/cleanup.js";

function reset() {
  useAgentChatStore.setState({
    threadsByScope: new Map(),
    messageStreams: new Map()
  });
}

/** An empty entry for the scope, as a conversation that has been opened. */
function seed(scope: ChatThreadScope) {
  useAgentChatStore.setState((s) => ({
    threadsByScope: new Map(s.threadsByScope).set(scopeKey(scope), newThreadState())
  }));
}

test("agent-chat store: sendMessage adds pending entry and calls fetch (optimistic)", async () => {
  reset();
  const scope = { type: "worker" as const, featureId: "f1" };
  seed(scope);
  let capturedBody: any = null;
  mockFetch(({ method, init }) => {
    if (method === "GET") {
      return new Response(JSON.stringify({ messages: [] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ threadId: "t1", messageId: "m1", wakeId: "w1" }),
      { status: 202, headers: { "content-type": "application/json" } });
  });
  await useAgentChatStore.getState().sendMessage(scope, "hello");
  const t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect(t.pendingUserMessages.size).toBe(1);
  const pending = [...t.pendingUserMessages.values()][0];
  expect(pending.status).toBe("sent");
  expect(pending.messageId).toBe("m1");
  expect(t.threadId).toBe("t1");
  expect(capturedBody.content).toBe("hello");
  expect(capturedBody.clientRequestId).toMatch(/^local-/);
});

test("agent-chat store: queued server response reconciles later by clientRequestId", async () => {
  reset();
  const scope = { type: "worker" as const, featureId: "f1" };
  seed(scope);
  let clientRequestId = "";
  mockFetch(({ method, init }) => {
    if (method === "GET") {
      return new Response(JSON.stringify({ messages: [] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = JSON.parse(String(init?.body));
    clientRequestId = body.clientRequestId;
    return new Response(JSON.stringify({
      threadId: "t1", messageId: null, wakeId: null, queued: true
    }), { status: 202, headers: { "content-type": "application/json" } });
  });
  await useAgentChatStore.getState().sendMessage(scope, "queued hello");
  let t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect([...t.pendingUserMessages.values()][0].status).toBe("queued");

  useAgentChatStore.getState().onMessageAppended("t1", {
    id: "m-delayed", threadId: "t1", seq: 1, role: "user", source: "user",
    sourceThreadId: null, wakeId: null,
    content: { type: "text", text: "queued hello", clientRequestId }, createdAt: "x"
  });

  t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect(t.pendingUserMessages.size).toBe(0);
  expect(t.messages.map((m) => m.id)).toEqual(["m-delayed"]);
});

test("agent-chat store: deleteQueuedMessage removes queued pending after server cancel", async () => {
  reset();
  const scope = { type: "worker" as const, featureId: "f1" };
  seed(scope);
  let deleteUrl = "";
  mockFetch(({ url, method }) => {
    if (method === "DELETE") {
      deleteUrl = url;
      return new Response(JSON.stringify({ ok: true, removed: true }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "GET") {
      return new Response(JSON.stringify({ messages: [] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      threadId: "t1", messageId: null, wakeId: null, queued: true
    }), { status: 202, headers: { "content-type": "application/json" } });
  });
  await useAgentChatStore.getState().sendMessage(scope, "queued hello");
  let t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  const localId = [...t.pendingUserMessages.keys()][0]!;
  expect(t.pendingUserMessages.get(localId)?.status).toBe("queued");

  await useAgentChatStore.getState().deleteQueuedMessage(scope, localId);
  t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect(deleteUrl).toContain(`/api/agents/workers/f1/queued-messages/${encodeURIComponent(localId)}`);
  expect(t.pendingUserMessages.size).toBe(0);
});

test("agent-chat store: sendMessage binds new threadId and catch-up applies missed messages", async () => {
  reset();
  const scope = { type: "manager" as const, threadId: "ov-thread" };
  seed(scope);
  mockFetch(({ url, method }) => {
    if (method === "POST") {
      expect(url).toContain("/api/agents/threads/ov-thread/messages");
      return new Response(JSON.stringify({ threadId: "ov-thread", messageId: "u1", wakeId: "w1" }),
        { status: 202, headers: { "content-type": "application/json" } });
    }
    expect(url).toContain("/api/agents/threads/ov-thread?");
    expect(url).toContain("since=0");
    return new Response(JSON.stringify({ thread: { id: "ov-thread" }, messages: [
      { id: "u1", threadId: "ov-thread", seq: 1, role: "user", source: "user",
        sourceThreadId: null, wakeId: null, content: { type: "text", text: "hi" }, createdAt: "x" },
      { id: "a1", threadId: "ov-thread", seq: 2, role: "assistant", source: "self",
        sourceThreadId: null, wakeId: "w1", content: { type: "assistant", text: "hello" }, createdAt: "x" }
    ] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  await useAgentChatStore.getState().sendMessage(scope, "hi");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const t = useAgentChatStore.getState().threadsByScope.get("manager:ov-thread")!;
  expect(t.threadId).toBe("ov-thread");
  expect(t.pendingUserMessages.size).toBe(0);
  expect(t.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
  expect(t.wakePhase.phase).toBe("idle");
});

test("agent-chat store: sendMessage marks failed on network error", async () => {
  reset();
  const scope = { type: "worker" as const, featureId: "f1" };
  seed(scope);
  mockFetch(() => { throw new TypeError("boom"); });
  await useAgentChatStore.getState().sendMessage(scope, "hi");
  const t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  const pending = [...t.pendingUserMessages.values()][0];
  expect(pending.status).toBe("failed");
  expect(pending.error!).toMatch(/boom/);
});

test("agent-chat store: retryFailedMessage re-sends a failed pending entry", async () => {
  reset();
  const scope = { type: "worker" as const, featureId: "f1" };
  seed(scope);
  let calls = 0;
  mockFetch(({ method }) => {
    if (method === "GET") {
      return new Response(JSON.stringify({ messages: [] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    calls++;
    if (calls === 1) throw new TypeError("first fail");
    return new Response(JSON.stringify({ threadId: "t1", messageId: "m2", wakeId: "w2" }),
      { status: 202, headers: { "content-type": "application/json" } });
  });
  await useAgentChatStore.getState().sendMessage(scope, "hi");
  const t1 = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  const failed = [...t1.pendingUserMessages.values()][0];
  expect(failed.status).toBe("failed");
  await useAgentChatStore.getState().retryFailedMessage(scope, failed.localId);
  const t2 = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  const pendings = [...t2.pendingUserMessages.values()];
  expect(pendings.length).toBe(1);
  expect(pendings[0].status).toBe("sent");
  expect(pendings[0].messageId).toBe("m2");
});

describe("mentions", () => {
  const state = () => useAgentChatStore.getState();
  const scope: AgentChatScope = { type: "manager", threadId: "thr_manager" };
  const M: Mention = { kind: "thread", id: "thr_errors", label: "Parser errors" };

  afterEach(() => useAgentChatStore.setState({ threadsByScope: new Map() }));

  // A message's mentions go with it to the server, and a send that failed
  // keeps them for its retry: the retry is the same message.
  test("a message's mentions go in its body and stay for a retry", async () => {
    useAgentChatStore.setState({ threadsByScope: new Map([[scopeKey(scope), { ...newThreadState(), threadId: "thr_manager", loaded: true }]]) });
    const bodies: Array<Record<string, unknown>> = [];
    let fail = true;
    mockFetch(({ url, init }) => {
      if (url.includes("/messages") && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        if (fail) { fail = false; return new Response(JSON.stringify({ error: "down" }), { status: 503, headers: { "content-type": "application/json" } }); }
        return new Response(JSON.stringify({ threadId: "thr_manager", messageId: "msg_1", wakeId: null, queued: false }), { status: 202, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    });
    expect(await state().sendMessage(scope, "Follow up on @Parser errors", [], [M])).toBe("failed");
    expect(bodies[0]).toMatchObject({ content: "Follow up on @Parser errors", mentions: [M] });
    const failed = [...state().threadsByScope.get(scopeKey(scope))!.pendingUserMessages.values()][0]!;
    expect(failed.mentions).toEqual([M]);
    await state().retryFailedMessage(scope, failed.localId);
    expect(bodies[1]).toMatchObject({ content: "Follow up on @Parser errors", mentions: [M] });
    // A message without mentions sends no key.
    await state().sendMessage(scope, "plain");
    expect("mentions" in bodies[2]!).toBe(false);
  });
});

test("agent-chat store: ensureThreadLoaded fetches latest 50 + sets oldestSeqLoaded", async () => {
  reset();
  const scope = { type: "worker" as const, featureId: "f1" };
  mockFetch(() => new Response(JSON.stringify({
    thread: { id: "t1", scope: "worker", scopeId: "f1" },
    messages: [
      { id: "m1", threadId: "t1", seq: 10, role: "user", source: "user",
        content: { type: "text", text: "hi" }, createdAt: "x" },
      { id: "m2", threadId: "t1", seq: 11, role: "assistant", source: "user",
        wakeId: "w1", wakeReason: "user",
        wakeMetadata: { recovery: { wakeIds: ["w0"], originalReason: "user", originalTriggerMessageId: null } },
        content: { type: "assistant", text: "hello" }, createdAt: "x" }
    ],
    hasMore: true
  }), { status: 200, headers: { "content-type": "application/json" } }));
  await useAgentChatStore.getState().ensureThreadLoaded(scope);
  const t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect(t.threadId).toBe("t1");
  expect(t.messages.length).toBe(2);
  expect(t.oldestSeqLoaded).toBe(10);
  expect(t.hasMoreOlder).toBe(true);
  expect(t.wakeReasonsById.get("w1")).toBe("user");
  expect(t.wakeMetadataById.get("w1")?.recovery?.wakeIds).toEqual(["w0"]);
});

test("agent-chat store: concurrent thread hydration shares a request and retries after failure", async () => {
  reset();
  const scope = { type: "worker" as const, featureId: "shared-load" };
  let calls = 0;
  let finish!: (response: Response) => void;
  mockFetch(() => {
    calls++;
    return new Promise<Response>((resolve) => { finish = resolve; });
  });
  try {
    const first = useAgentChatStore.getState().ensureThreadLoaded(scope);
    const second = useAgentChatStore.getState().ensureThreadLoaded({ ...scope });
    expect(calls).toBe(1);
    finish(new Response(null, { status: 503 }));
    const results = await Promise.allSettled([first, second]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);

    const retry = useAgentChatStore.getState().ensureThreadLoaded(scope);
    expect(calls).toBe(2);
    finish(Response.json({ thread: { id: "loaded-thread" }, messages: [], hasMore: false }));
    await retry;
    expect(useAgentChatStore.getState().threadsByScope.get("worker:shared-load")?.threadId).toBe("loaded-thread");
  } finally { reset(); }
});

test("agent-chat store: loaded scopes refresh once in the background without blocking callers", async () => {
  reset();
  const scope = { type: "manager" as const, threadId: "main" };
  const first: AgentMessage = {
    id: "m1", threadId: "main", seq: 1, role: "user", source: "user", sourceThreadId: null, wakeId: null,
    content: { type: "text", text: "hi" }, createdAt: "x"
  };
  useAgentChatStore.setState({ threadsByScope: new Map([["manager:main", { ...newThreadState(), threadId: "main", messages: [first], oldestSeqLoaded: 1, loaded: true }]]) });
  let reads = 0;
  let finish!: (response: Response) => void;
  let readFinished!: () => void;
  const finished = new Promise<void>((resolve) => { readFinished = resolve; });
  mockFetch(({ url }) => {
    if (url.includes("since=")) {
      reads++;
      return new Promise<Response>((resolve) => { finish = resolve; }).then((response) => { readFinished(); return response; });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  try {
    await useAgentChatStore.getState().ensureThreadLoaded(scope);
    await useAgentChatStore.getState().ensureThreadLoaded(scope);
    expect(reads).toBe(1);
  } finally {
    finish(Response.json({ thread: { id: "main" }, messages: [] }));
    await finished;
    await Bun.sleep(0);
    reset();
  }
});

test("agent-chat store: ensureThreadLoaded handles empty thread", async () => {
  reset();
  const scope = { type: "worker" as const, featureId: "f1" };
  mockFetch(() => new Response(JSON.stringify({
    thread: null, messages: []
  }), { status: 200, headers: { "content-type": "application/json" } }));
  await useAgentChatStore.getState().ensureThreadLoaded(scope);
  const t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect(t.threadId).toBe(null);
  expect(t.messages.length).toBe(0);
  expect(t.hasMoreOlder).toBe(false);
});

test("agent-chat store: ensureThreadLoaded merges instead of clobbering concurrent messages", async () => {
  reset();
  const scope = { type: "manager" as const, threadId: "t1" };
  let resolveFetch!: (response: Response) => void;
  mockFetch(() => new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  }));
  const loading = useAgentChatStore.getState().ensureThreadLoaded(scope);
  const message: AgentMessage = {
    id: "m1", threadId: "t1", seq: 1, role: "user", source: "user",
    sourceThreadId: null, wakeId: null,
    content: { type: "text", text: "sent while loading" }, createdAt: "x"
  };
  useAgentChatStore.setState({
    threadsByScope: new Map(useAgentChatStore.getState().threadsByScope)
      .set("manager:t1", { ...newThreadState(), threadId: "t1", messages: [message] })
  });
  resolveFetch(new Response(JSON.stringify({
    thread: { id: "t1", scope: "manager", scopeId: null },
    messages: [],
    hasMore: false
  }), { status: 200, headers: { "content-type": "application/json" } }));
  await loading;
  const t = useAgentChatStore.getState().threadsByScope.get("manager:t1")!;
  expect(t.threadId).toBe("t1");
  expect(t.messages.map((m) => m.id)).toEqual(["m1"]);
});

test("agent-chat store: onMessageAppended adds assistant + clears streaming", () => {
  reset();
  const scope = { type: "worker" as const, featureId: "f1" };
  seed(scope);
  const t0 = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  useAgentChatStore.setState({
    threadsByScope: new Map(useAgentChatStore.getState().threadsByScope)
      .set("worker:f1", { ...t0, threadId: "t1",
        streamingAssistant: { wakeId: "w1", totalText: "partial" } })
  });
  useAgentChatStore.getState().onMessageAppended("t1", {
    id: "m1", threadId: "t1", seq: 1, role: "assistant", source: "user",
    sourceThreadId: null, wakeId: "w1",
    content: { type: "assistant", text: "hi" }, createdAt: "x"
  });
  const t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect(t.messages.length).toBe(1);
  expect(t.streamingAssistant).toBe(null);
});

test("agent-chat store: onMessageAppended user message reconciles pending by messageId", async () => {
  reset();
  const scope = { type: "worker" as const, featureId: "f1" };
  seed(scope);
  mockFetch(({ method }) => {
    if (method === "GET") {
      return new Response(JSON.stringify({ messages: [] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      threadId: "t1", messageId: "m1", wakeId: "w1"
    }), { status: 202, headers: { "content-type": "application/json" } });
  });
  await useAgentChatStore.getState().sendMessage(scope, "hi");
  const t0 = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  useAgentChatStore.setState({
    threadsByScope: new Map(useAgentChatStore.getState().threadsByScope)
      .set("worker:f1", { ...t0, threadId: "t1" })
  });
  useAgentChatStore.getState().onMessageAppended("t1", {
    id: "m1", threadId: "t1", seq: 1, role: "user", source: "user",
    sourceThreadId: null, wakeId: null,
    content: { type: "text", text: "hi" }, createdAt: "x"
  });
  const t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect(t.pendingUserMessages.size).toBe(0);
  expect(t.messages.length).toBe(1);
  expect(t.messages[0].id).toBe("m1");
});

test("agent-chat store: onWakeStarted sets phase=thinking; onWakeFinished sets idle", () => {
  reset();
  const scope = { type: "worker" as const, featureId: "f1" };
  seed(scope);
  const t0 = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  useAgentChatStore.setState({
    threadsByScope: new Map(useAgentChatStore.getState().threadsByScope)
      .set("worker:f1", { ...t0, threadId: "t1" })
  });
  useAgentChatStore.getState().onWakeStarted("t1", "w1", "user");
  let t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect(t.wakePhase.phase).toBe("thinking");
  useAgentChatStore.getState().onWakeFinished("t1", "w1", "finished", null, {
    inputTokens: 17,
    budgetTokens: 170,
    updatedAt: "x",
    source: "compression_budget"
  });
  t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect(t.wakePhase.phase).toBe("idle");
  expect(t.contextUsage?.inputTokens).toBe(17);
});

test("agent-chat store: Stop marks its turn stopped before it shows it idle, and before the server has answered", async () => {
  reset();
  useInterruptedWakesStore.setState({ ids: new Set() });
  onCleanup(() => useInterruptedWakesStore.setState({ ids: new Set() }));
  const scope = { type: "worker" as const, featureId: "f1" };
  seed(scope);
  const thread = () => useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  useAgentChatStore.setState({ threadsByScope: new Map(useAgentChatStore.getState().threadsByScope).set("worker:f1", { ...thread(), threadId: "t1" }) });
  const asked: string[] = [];
  let answer!: () => void;
  const held = new Promise<void>((resolve) => { answer = resolve; });
  mockFetch(async ({ url, method }) => {
    asked.push(`${method} ${url}`);
    await held;
    return new Response(JSON.stringify({ ok: true, wakeId: "w1", status: "running" }), { status: 200, headers: { "content-type": "application/json" } });
  });
  useAgentChatStore.getState().onWakeStarted("t1", "w1", "user");
  expect([...useInterruptedWakesStore.getState().ids]).toEqual([]);
  // What a reader of the chat sees at each change of it: never idle and unmarked.
  const seen: Array<[string, boolean]> = [];
  const unsubscribe = useAgentChatStore.subscribe((state) => {
    seen.push([state.threadsByScope.get("worker:f1")!.wakePhase.phase, useInterruptedWakesStore.getState().ids.has("w1")]);
  });
  onCleanup(unsubscribe);
  const stopping = useAgentChatStore.getState().cancelWake(scope);
  expect(seen).toStrictEqual([["idle", true]]);
  expect(thread().wakePhase.phase).toBe("idle");
  answer();
  await stopping;
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain("w1");
  // A turn already idle is not stopped again, and not marked.
  useAgentChatStore.getState().onWakeStarted("t1", "w2", "user");
  useAgentChatStore.getState().onWakeFinished("t1", "w2", "finished");
  await useAgentChatStore.getState().cancelWake(scope);
  expect([...useInterruptedWakesStore.getState().ids]).toEqual(["w1"]);
  expect(asked).toHaveLength(1);
});

test("agent-chat store: onWakeStarted stores wake metadata", () => {
  reset();
  const scope = { type: "worker" as const, featureId: "f1" };
  seed(scope);
  const t0 = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  useAgentChatStore.setState({
    threadsByScope: new Map(useAgentChatStore.getState().threadsByScope)
      .set("worker:f1", { ...t0, threadId: "t1" })
  });
  const metadata = {
    recovery: { wakeIds: ["w0"], originalReason: "user" as const, originalTriggerMessageId: null }
  };

  useAgentChatStore.getState().onWakeStarted("t1", "w1", "user", metadata);

  const t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect(t.wakeReasonsById.get("w1")).toBe("user");
  expect(t.wakeMetadataById.get("w1")).toEqual(metadata);
});

test("agent-chat store: onMessageAppended merges wake metadata from message DTOs", () => {
  reset();
  useAgentChatStore.setState({
    threadsByScope: new Map().set("worker:f1", { ...newThreadState(), threadId: "t1" })
  });
  const metadata = {
    recovery: { wakeIds: ["w0"], originalReason: "user" as const, originalTriggerMessageId: null }
  };

  useAgentChatStore.getState().onMessageAppended("t1", {
    id: "m1", threadId: "t1", seq: 1, role: "assistant", source: "self",
    sourceThreadId: null, wakeId: "w1", wakeReason: "user", wakeMetadata: metadata,
    content: { type: "assistant", text: "done" }, createdAt: "x"
  });

  const t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect(t.wakeMetadataById.get("w1")).toEqual(metadata);
});

test("agent-chat store: compression summary append does not clear a newer phase", () => {
  reset();
  useAgentChatStore.setState({
    threadsByScope: new Map().set("worker:f1", { ...newThreadState(), threadId: "t1" })
  });
  useAgentChatStore.getState().onCompressionStarted("t1", "c2", "now");
  let t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect(t.compressionPhase?.compressionId).toBe("c2");
  useAgentChatStore.getState().onMessageAppended("t1", {
    id: "s1", threadId: "t1", seq: 10, role: "user", source: "compression",
    sourceThreadId: null, wakeId: null,
    content: {
      type: "summary", summary: "old context",
      replacedRange: [1, 9], replacedCount: 9,
      retained: []
    }, createdAt: "x"
  });
  t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect(t.compressionPhase?.compressionId).toBe("c2");
  useAgentChatStore.getState().onCompressionFinished("t1", "c1");
  t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect(t.compressionPhase?.compressionId).toBe("c2");
  useAgentChatStore.getState().onCompressionFinished("t1", "c2", {
    inputTokens: 5,
    budgetTokens: 100,
    updatedAt: "y",
    source: "compression_budget"
  });
  t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect(t.compressionPhase).toBe(null);
  expect(t.contextUsage?.inputTokens).toBe(5);
});

test("agent-chat store: live append caps automatic growth at recent 500 messages", () => {
  reset();
  const seed: AgentMessage[] = Array.from({ length: 500 }, (_, i) => ({
    id: `m${i}`, threadId: "t1", seq: i + 1, role: "user" as const, source: "user" as const,
    sourceThreadId: null, wakeId: null,
    content: { type: "text", text: `m${i}` }, createdAt: "x"
  }));
  useAgentChatStore.setState({
    threadsByScope: new Map().set("worker:f1", {
      ...newThreadState(), threadId: "t1", messages: seed
    })
  });
  useAgentChatStore.getState().onMessageAppended("t1", {
    id: "m500", threadId: "t1", seq: 501, role: "assistant", source: "user",
    sourceThreadId: null, wakeId: "w1", content: { type: "assistant", text: "new" }, createdAt: "x"
  });
  const t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect(t.messages.length).toBe(500);
  expect(t.messages[0].seq).toBe(2);
  expect(t.oldestSeqLoaded).toBe(2);
  expect(t.hasMoreOlder).toBe(true);
  expect(t.messages[t.messages.length - 1].id).toBe("m500");
});

test("agent-chat store: a finished compaction's usage with no figure replaces the size from before it", () => {
  reset();
  useAgentChatStore.setState({
    threadsByScope: new Map([["worker:f1", {
      ...newThreadState(), threadId: "t1", loaded: true,
      contextUsage: { inputTokens: 180_400, budgetTokens: 250_000, updatedAt: "before", source: "compression_budget" as const },
      compressionPhase: { compressionId: "c1", startedAt: "now" }
    }]])
  });
  // What the server sends when a compaction ends: the budget, and no size
  // until the next reply measures the compacted window.
  useAgentChatStore.getState().onCompressionFinished("t1", "c1", {
    inputTokens: null, budgetTokens: 250_000, updatedAt: "after", source: "compression_budget"
  });
  const t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect([t.compressionPhase, t.contextUsage]).toEqual([
    null, { inputTokens: null, budgetTokens: 250_000, updatedAt: "after", source: "compression_budget" }
  ]);
});

test("agent-chat store: compression summary survives recent-window cap without clearing phase", () => {
  reset();
  const seed: AgentMessage[] = Array.from({ length: 500 }, (_, i) => ({
    id: `m${i}`, threadId: "t1", seq: i + 1, role: "user" as const, source: "user" as const,
    sourceThreadId: null, wakeId: null,
    content: { type: "text", text: `m${i}` }, createdAt: "x"
  }));
  useAgentChatStore.setState({
    threadsByScope: new Map().set("worker:f1", {
      ...newThreadState(),
      threadId: "t1",
      messages: seed,
      oldestSeqLoaded: 1,
      compressionPhase: { compressionId: "c1", startedAt: "now" }
    })
  });
  useAgentChatStore.getState().onMessageAppended("t1", {
    id: "summary-1", threadId: "t1", seq: 501, role: "user", source: "compression",
    sourceThreadId: null, wakeId: null,
    content: {
      type: "summary", summary: "old context",
      replacedRange: [1, 400], replacedCount: 400,
      retained: []
    }, createdAt: "x"
  });
  const t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect(t.messages.length).toBe(500);
  expect(t.messages[0].seq).toBe(2);
  expect(t.messages[t.messages.length - 1].id).toBe("summary-1");
  expect(t.compressionPhase?.compressionId).toBe("c1");
});

test("agent-chat store: scopeFromKey round-trips manager + worker", () => {
  expect(scopeFromKey("manager:thr_m")).toEqual({ type: "manager", threadId: "thr_m" });
  expect(scopeFromKey("worker:abc-123")).toEqual({ type: "worker", featureId: "abc-123" });
  expect(scopeFromKey("garbage")).toBe(null);
});

test("a manager scope loads and posts by thread id", async () => {
  reset();
  const calls: string[] = [];
  mockFetch(({ url, method }) => {
    calls.push(`${method} ${url}`);
    if (method === "GET") return new Response(JSON.stringify({ thread: { id: "thr_m" }, messages: [], hasMore: false }), { status: 200 });
    return new Response(JSON.stringify({ threadId: "thr_m", messageId: "m1", wakeId: "w1" }), { status: 202 });
  });
  try {
    const scope = { type: "manager" as const, threadId: "thr_m" };
    await useAgentChatStore.getState().ensureThreadLoaded(scope);
    await useAgentChatStore.getState().sendMessage(scope, "hi");
    // The page, the read on from its top, then the send.
    expect(calls[0]).toContain("GET /api/agents/threads/thr_m?");
    expect(calls[1]).toContain("GET /api/agents/threads/thr_m?");
    expect(calls[1]).toContain("since=0");
    expect(calls[2]).toContain("POST /api/agents/threads/thr_m/messages");
    expect(useAgentChatStore.getState().threadsByScope.get("manager:thr_m")?.threadId).toBe("thr_m");
  } finally { reset(); }
});

test("a manager thread's entry is bound to its id before its first page arrives", async () => {
  reset();
  let respond!: (r: Response) => void;
  mockFetch(() => new Promise<Response>((resolve) => { respond = resolve; }));
  try {
    const loading = useAgentChatStore.getState().ensureThreadLoaded({ type: "manager", threadId: "thr_m" });
    // A message streamed in while the page is in flight lands in this thread.
    expect(useAgentChatStore.getState().threadsByScope.get("manager:thr_m")?.threadId).toBe("thr_m");
    respond(new Response(JSON.stringify({ thread: { id: "thr_m" }, messages: [], hasMore: false }), { status: 200 }));
    await loading;
  } finally { reset(); }
});

test("an empty conversation is loaded once: reopening it catches up instead of refetching the page", async () => {
  reset();
  const calls: string[] = [];
  mockFetch(({ url }) => {
    calls.push(url);
    return Response.json({ thread: { id: "fresh" }, messages: [], hasMore: false });
  });
  try {
    const scope = { type: "worker" as const, featureId: "f-empty" };
    await useAgentChatStore.getState().ensureThreadLoaded(scope);
    await useAgentChatStore.getState().ensureThreadLoaded(scope);
    await Bun.sleep(0);
    // The page is followed by a read on from its top; the second call reads
    // what arrived since, not the first page again.
    expect(calls.map((u) => u.includes("since=") ? "since" : "page")).toStrictEqual(["page", "since", "since"]);
  } finally { reset(); }
});

test("a live message that landed while the first page failed is not a loaded history", async () => {
  reset();
  const calls: string[] = [];
  let fail = true;
  mockFetch(({ url }) => {
    const since = new URL(url, "http://x").searchParams.get("since");
    calls.push(since === null ? "page" : `since=${since}`);
    if (fail) throw new TypeError("Failed to fetch");
    return Response.json({ thread: { id: "thr_m" }, messages: [], hasMore: false });
  });
  try {
    const scope = { type: "manager" as const, threadId: "thr_m" };
    await useAgentChatStore.getState().ensureThreadLoaded(scope).catch(() => {});
    useAgentChatStore.getState().onMessageAppended("thr_m", {
      id: "live", threadId: "thr_m", seq: 40, role: "assistant", source: "self", sourceThreadId: null,
      wakeId: "w", content: { type: "assistant", text: "live" }, createdAt: "x"
    });
    fail = false;
    await useAgentChatStore.getState().ensureThreadLoaded(scope);
    // The first page again, not "since 40": seqs 1–39 were never read. Then
    // a read on from that page's top, again not from 40.
    expect(calls).toStrictEqual(["page", "page", "since=0"]);
  } finally { reset(); }
});

test("agent-chat store: onMessageAppended is idempotent by message id", () => {
  reset();
  useAgentChatStore.setState({
    threadsByScope: new Map().set("worker:f1", { ...newThreadState(), threadId: "t1" })
  });
  const msg: AgentMessage = {
    id: "m1", threadId: "t1", seq: 1, role: "assistant", source: "user",
    sourceThreadId: null, wakeId: "w1", content: { type: "assistant", text: "hi" }, createdAt: "x"
  };
  useAgentChatStore.getState().onMessageAppended("t1", msg);
  useAgentChatStore.getState().onMessageAppended("t1", msg);
  const t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect(t.messages.length).toBe(1);
});

test("agent-chat store: refetchIncrementalForOpenScopes pulls since lastSeq and merges new messages", async () => {
  reset();
  // Two loaded scopes: manager (lastSeq 5) and worker f1 (lastSeq 10).
  // Worker f2 had no thread: it is read again from its first page, since its
  // first wake may have come while the stream was down.
  const overviewSeed: AgentMessage = {
    id: "ov-5", threadId: "ov-thread", seq: 5, role: "user", source: "user",
    sourceThreadId: null, wakeId: null, content: { type: "text", text: "old" }, createdAt: "x"
  };
  const featureSeed: AgentMessage = {
    id: "f1-10", threadId: "f1-thread", seq: 10, role: "user", source: "user",
    sourceThreadId: null, wakeId: null, content: { type: "text", text: "old" }, createdAt: "x"
  };
  const map = new Map<string, any>()
    .set("manager:ov-thread", { ...newThreadState(), threadId: "ov-thread", messages: [overviewSeed] })
    .set("worker:f1", { ...newThreadState(), threadId: "f1-thread", messages: [featureSeed] })
    .set("worker:f2", { ...newThreadState(), threadId: null, loaded: true });
  useAgentChatStore.setState({ threadsByScope: map });

  const calls: string[] = [];
  mockFetch(({ url }) => {
    calls.push(url);
    if (url.includes("/api/agents/threads/ov-thread?")) {
      return new Response(JSON.stringify({ thread: { id: "ov-thread" }, messages: [
        { id: "ov-6", threadId: "ov-thread", seq: 6, role: "assistant", source: "self",
          sourceThreadId: null, wakeId: "w-ov", content: { type: "assistant", text: "missed" }, createdAt: "x" }
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/api/agents/workers/f1/thread")) {
      return new Response(JSON.stringify({ thread: { id: "f1-thread" }, messages: [
        // delivered out of order on purpose — refetch should sort by seq
        { id: "f1-12", threadId: "f1-thread", seq: 12, role: "assistant", source: "self",
          sourceThreadId: null, wakeId: "w-f1", content: { type: "assistant", text: "second" }, createdAt: "x" },
        { id: "f1-11", threadId: "f1-thread", seq: 11, role: "user", source: "user",
          sourceThreadId: null, wakeId: null, content: { type: "text", text: "first" }, createdAt: "x" }
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/api/agents/workers/f2/thread")) {
      return new Response(JSON.stringify({ thread: null, messages: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  await useAgentChatStore.getState().refetchIncrementalForOpenScopes();

  // f2: its first page once, never a catch-up from 0; still no thread.
  expect(calls.filter((u) => u.includes("/workers/f2/"))).toStrictEqual(["/api/agents/workers/f2/thread?limit=50"]);
  expect(useAgentChatStore.getState().threadsByScope.get("worker:f2")!.threadId).toBeNull();
  // both URLs include since=<lastSeq>
  expect(calls.some((u) => u.includes("/threads/ov-thread?") && u.includes("since=5"))).toBe(true);
  expect(calls.some((u) => u.includes("/workers/f1/thread?since=10"))).toBe(true);

  const ov = useAgentChatStore.getState().threadsByScope.get("manager:ov-thread")!;
  expect(ov.messages.map((m) => m.id)).toEqual(["ov-5", "ov-6"]);

  const f1 = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect(f1.messages.map((m) => m.id)).toEqual(["f1-10", "f1-11", "f1-12"]);
});

test("agent-chat store: reconnect catch-up keeps compression summary under recent-window cap", async () => {
  reset();
  const seed: AgentMessage[] = Array.from({ length: 500 }, (_, i) => ({
    id: `m${i + 1}`, threadId: "t1", seq: i + 1, role: "user" as const, source: "user" as const,
    sourceThreadId: null, wakeId: null,
    content: { type: "text", text: `m${i + 1}` }, createdAt: "x"
  }));
  useAgentChatStore.setState({
    threadsByScope: new Map().set("manager:t1", {
      ...newThreadState(), threadId: "t1", messages: seed, oldestSeqLoaded: 1
    })
  });
  let calledUrl = "";
  mockFetch(({ url }) => {
    calledUrl = url;
    return new Response(JSON.stringify({
      thread: { id: "t1" },
      messages: [{
        id: "summary-1", threadId: "t1", seq: 501, role: "user", source: "compression",
        sourceThreadId: null, wakeId: null,
        content: {
          type: "summary", summary: "old context",
          replacedRange: [1, 400], replacedCount: 400
        }, createdAt: "x"
      }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  await useAgentChatStore.getState().refetchIncrementalForOpenScopes();

  expect(calledUrl).toContain("/api/agents/threads/t1?");
  expect(calledUrl).toContain("since=500");
  const t = useAgentChatStore.getState().threadsByScope.get("manager:t1")!;
  expect(t.messages.length).toBe(500);
  expect(t.messages[0].seq).toBe(2);
  expect(t.messages[t.messages.length - 1].id).toBe("summary-1");
  expect(t.hasMoreOlder).toBe(true);
});

test("agent-chat store: refetchIncrementalForOpenScopes deduplicates against existing messages", async () => {
  reset();
  const seed: AgentMessage = {
    id: "m1", threadId: "t1", seq: 1, role: "user", source: "user",
    sourceThreadId: null, wakeId: null, content: { type: "text", text: "hi" }, createdAt: "x"
  };
  useAgentChatStore.setState({
    threadsByScope: new Map().set("manager:t1", {
      ...newThreadState(), threadId: "t1", messages: [seed]
    })
  });
  // Server returns the SAME message we already have (e.g. since=0 when lastSeq=1
  // would skip it, but a lagging clock could plausibly redeliver).
  mockFetch(() => new Response(JSON.stringify({
    thread: { id: "t1" }, messages: [seed]
  }), { status: 200, headers: { "content-type": "application/json" } }));
  await useAgentChatStore.getState().refetchIncrementalForOpenScopes();
  const t = useAgentChatStore.getState().threadsByScope.get("manager:t1")!;
  expect(t.messages.length).toBe(1);
});

test("agent-chat store: loadOlder fetches before oldestSeqLoaded and prepends", async () => {
  reset();
  const scope = { type: "worker" as const, featureId: "f1" };
  const calls: string[] = [];
  mockFetch(({ url }) => {
    calls.push(url);
    if (url.includes("since=")) {
      return new Response(JSON.stringify({ thread: { id: "t1", scope: "worker", scopeId: "f1" }, messages: [] }), { status: 200 });
    }
    if (!url.includes("before=")) {
      return new Response(JSON.stringify({
        thread: { id: "t1", scope: "worker", scopeId: "f1" },
        messages: [
          { id: "m20", threadId: "t1", seq: 20, role: "user", source: "user", content: { type: "text", text: "twenty" }, createdAt: "x" }
        ],
        hasMore: true
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      thread: { id: "t1", scope: "worker", scopeId: "f1" },
      messages: [
        { id: "m18", threadId: "t1", seq: 18, role: "user", source: "user", content: { type: "text", text: "eighteen" }, createdAt: "x" },
        { id: "m19", threadId: "t1", seq: 19, role: "user", source: "user", content: { type: "text", text: "nineteen" }, createdAt: "x" }
      ],
      hasMore: false
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  await useAgentChatStore.getState().ensureThreadLoaded(scope);
  await useAgentChatStore.getState().loadOlder(scope);
  const t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect(t.messages.length).toBe(3);
  expect(t.messages[0].seq).toBe(18);
  expect(t.messages[2].seq).toBe(20);
  expect(t.hasMoreOlder).toBe(false);
  expect(t.oldestSeqLoaded).toBe(18);
  expect(calls.filter((u) => u.includes("before="))).toStrictEqual([expect.stringContaining("before=20")]);
});

// A suggested answer of an open question is sent as the user's own message,
// with the question it answers. The server refuses one whose question has
// closed meanwhile: that is not a message to keep and retry.
test("agent-chat store: a picked answer is posted with its question; a refused pick leaves no bubble and says why", async () => {
  reset();
  const scope = { type: "manager" as const, threadId: "thr_a" };
  seed(scope);
  const bodies: any[] = [];
  let refuse = false;
  mockFetch(({ method, init }) => {
    if (method === "GET") return Response.json({ thread: { id: "thr_a" }, messages: [], hasMore: false });
    bodies.push(JSON.parse(String(init?.body)));
    return refuse
      ? Response.json({ error: "That question is no longer open." }, { status: 409 })
      : Response.json({ threadId: "thr_a", messageId: "m1", wakeId: "w1" }, { status: 202 });
  });
  const pending = () => [...useAgentChatStore.getState().threadsByScope.get(scopeKey(scope))!.pendingUserMessages.values()];
  expect(await useAgentChatStore.getState().answerQuestion(scope, { id: "q_1", question: "Push the branch?" }, "Push now")).toBeNull();
  expect(bodies[0]).toMatchObject({ content: "Push now", answers: ["q_1"] });
  // The bubble shown meanwhile already quotes the question it answers.
  expect(pending().map((p) => [p.content, p.status, p.answers])).toEqual([["Push now", "sent", [{ id: "q_1", question: "Push the branch?" }]]]);
  refuse = true;
  expect(await useAgentChatStore.getState().answerQuestion(scope, { id: "q_2", question: "Tag it?" }, "Tag it")).toBe("That question is no longer open.");
  expect(pending().map((p) => p.content)).toEqual(["Push now"]);
  // What the user typed and could not send stays, to be sent again; it names no question.
  expect(await useAgentChatStore.getState().sendMessage(scope, "And announce it")).toBe("failed");
  expect(bodies.at(-1).answers).toBeUndefined();
  expect(pending().map((p) => [p.content, p.status])).toEqual([["Push now", "sent"], ["And announce it", "failed"]]);
});

// Continue is the user's message, sent by a control: the server is told so,
// for it answers no question the turn had asked.
test("agent-chat store: Continue is posted as the control's; a thread's only, and one that could not be sent is not kept", async () => {
  reset();
  const scope = { type: "manager" as const, threadId: "thr_c" };
  seed(scope);
  const posts: Array<{ url: string; body: any }> = [];
  let fail = false;
  mockFetch(({ method, url, init }) => {
    if (method === "GET") return Response.json({ thread: { id: "thr_c" }, messages: [], hasMore: false });
    posts.push({ url, body: JSON.parse(String(init?.body)) });
    return fail ? Response.json({ error: "database is locked" }, { status: 500 }) : Response.json({ threadId: "thr_c", messageId: "m1", wakeId: "w1" }, { status: 202 });
  });
  const pending = () => [...useAgentChatStore.getState().threadsByScope.get(scopeKey(scope))!.pendingUserMessages.values()];
  await useAgentChatStore.getState().continueTurn(scope);
  expect(posts[0]!.body).toMatchObject({ content: "Continue", control: "continue" });
  expect(posts[0]!.body.answers).toBeUndefined();
  expect(pending().map((p) => [p.content, p.status])).toEqual([["Continue", "sent"]]);
  // It could not be sent: the button is still there to press; nothing is left to send again as typed words.
  fail = true;
  await useAgentChatStore.getState().continueTurn(scope);
  expect(pending().map((p) => p.status)).toEqual(["sent"]);
  // What the user types says nothing of a control.
  fail = false;
  await useAgentChatStore.getState().sendMessage(scope, "Continue");
  expect(posts.at(-1)!.body.control).toBeUndefined();
});
