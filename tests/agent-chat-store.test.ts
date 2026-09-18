import { expect, test } from "bun:test";
import {
  CHAT_DRAWER_OPEN_STORAGE_KEY,
  getInitialChatDrawerState,
  useAgentChatStore,
  scopeKey,
  scopeFromKey,
  newThreadState,
  AgentMessage
} from "../src/client/store/agent-chat.js";

function reset() {
  localStorage.removeItem(CHAT_DRAWER_OPEN_STORAGE_KEY);
  useAgentChatStore.setState({
    drawerOpen: false,
    drawerScope: null,
    threadsByScope: new Map(),
    messageStreams: new Map(),
    sideThread: null,
    sideParentScope: null,
    sideActive: false,
    sideTransferNeedsRetargetId: null
  });
}

function withMatchMedia(matches: (query: string) => boolean, fn: () => void) {
  const original = window.matchMedia;
  (window as any).matchMedia = (query: string) => ({
    matches: matches(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false
  });
  try {
    fn();
  } finally {
    (window as any).matchMedia = original;
  }
}

test("agent-chat store: test reset state", () => {
  reset();
  const s = useAgentChatStore.getState();
  expect(s.drawerOpen).toBe(false);
  expect(s.drawerScope).toBe(null);
  expect(s.threadsByScope.size).toBe(0);
});

test("agent-chat store: drawer defaults open on desktop without a saved preference", () => {
  localStorage.removeItem(CHAT_DRAWER_OPEN_STORAGE_KEY);
  withMatchMedia((query) => query.includes("min-width"), () => {
    expect(getInitialChatDrawerState()).toEqual({
      drawerOpen: true,
      drawerScope: { type: "manager" }
    });
  });
});

test("agent-chat store: drawer defaults closed on mobile without a saved preference", () => {
  localStorage.removeItem(CHAT_DRAWER_OPEN_STORAGE_KEY);
  withMatchMedia(() => false, () => {
    expect(getInitialChatDrawerState()).toEqual({
      drawerOpen: false,
      drawerScope: null
    });
  });
});

test("agent-chat store: saved drawer preference overrides viewport default", () => {
  localStorage.setItem(CHAT_DRAWER_OPEN_STORAGE_KEY, "false");
  withMatchMedia((query) => query.includes("min-width"), () => {
    expect(getInitialChatDrawerState()).toEqual({
      drawerOpen: false,
      drawerScope: null
    });
  });
});

test("agent-chat store: scopeKey produces stable key per scope", () => {
  expect(scopeKey({ type: "worker", featureId: "abc" })).toBe("worker:abc");
});

test("agent-chat store: openDrawer sets scope and opens", () => {
  reset();
  useAgentChatStore.getState().openDrawer({ type: "worker", featureId: "f1" });
  const s = useAgentChatStore.getState();
  expect(s.drawerOpen).toBe(true);
  expect(s.drawerScope).toEqual({ type: "worker", featureId: "f1" });
});

/** openDrawer clears exactly one scope's unread count. The collapsed rail used
 *  to badge the *sum* of every thread's unread while its click opened only the
 *  current route's scope, so reading what you were shown left the badge up and
 *  the app kept insisting there was something unread. Any trigger's badge has
 *  to count the same scope its click will clear — this pins the store half of
 *  that contract. */
test("agent-chat store: openDrawer clears only the opened scope's unread", () => {
  reset();
  const a = scopeKey({ type: "worker", featureId: "f1" });
  const b = scopeKey({ type: "manager" });
  useAgentChatStore.setState({
    threadsByScope: new Map([
      [a, { ...newThreadState(), unreadAssistantCount: 4 }],
      [b, { ...newThreadState(), unreadAssistantCount: 7 }]
    ])
  });

  useAgentChatStore.getState().openDrawer({ type: "worker", featureId: "f1" });

  const threads = useAgentChatStore.getState().threadsByScope;
  expect(threads.get(a)?.unreadAssistantCount).toBe(0);
  expect(threads.get(b)?.unreadAssistantCount).toBe(7);

  // Closing must not clear anything either — the other scope is still unread.
  useAgentChatStore.getState().closeDrawer();
  const after = useAgentChatStore.getState().threadsByScope;
  expect(after.get(a)?.unreadAssistantCount).toBe(0);
  expect(after.get(b)?.unreadAssistantCount).toBe(7);
});

test("agent-chat store: closeDrawer closes (scope kept)", () => {
  reset();
  useAgentChatStore.getState().openDrawer({ type: "worker", featureId: "f1" });
  expect(localStorage.getItem(CHAT_DRAWER_OPEN_STORAGE_KEY)).toBe("true");
  useAgentChatStore.getState().closeDrawer();
  const s = useAgentChatStore.getState();
  expect(s.drawerOpen).toBe(false);
  expect(s.drawerScope).toEqual({ type: "worker", featureId: "f1" });
  expect(localStorage.getItem(CHAT_DRAWER_OPEN_STORAGE_KEY)).toBe("false");
});

test("agent-chat store: starts a side conversation and routes its SSE independently", async () => {
  reset();
  const scope = { type: "manager" as const };
  useAgentChatStore.setState({
    drawerOpen: true,
    drawerScope: scope,
    threadsByScope: new Map().set("manager", {
      ...newThreadState(),
      threadId: "main-1",
      messages: [{
        id: "main-message",
        threadId: "main-1",
        seq: 1,
        role: "user",
        source: "user",
        sourceThreadId: null,
        wakeId: null,
        content: { type: "text", text: "main" },
        createdAt: "x"
      }]
    })
  });
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, opts: RequestInit = {}) => {
    if (String(url).endsWith("/main-1/forks")) {
      return new Response(JSON.stringify({
        thread: { id: "side-1", kind: "side", parentThreadId: "main-1" },
        parentThread: { id: "main-1", kind: "main" }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).includes("/api/agents/threads/side-1?") && !opts.method) {
      return new Response(JSON.stringify({
        thread: { id: "side-1", kind: "side", parentThreadId: "main-1" },
        messages: [],
        hasMore: false
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    await useAgentChatStore.getState().startSideConversation(scope);
    expect(useAgentChatStore.getState().sideActive).toBe(true);
    expect(useAgentChatStore.getState().sideThread?.threadId).toBe("side-1");

    const sideMessage: AgentMessage = {
      id: "side-message",
      threadId: "side-1",
      seq: 1,
      role: "assistant",
      source: "self",
      sourceThreadId: null,
      wakeId: "side-wake",
      content: { type: "assistant", text: "side answer" },
      createdAt: "x"
    };
    useAgentChatStore.getState().onMessageAppended("side-1", sideMessage);
    expect(useAgentChatStore.getState().sideThread?.messages.map((message) => message.id)).toEqual([
      "side-message"
    ]);
    expect(useAgentChatStore.getState().threadsByScope.get("manager")?.messages.map((message) => message.id)).toEqual([
      "main-message"
    ]);
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});

test("agent-chat store: sendMessage adds pending entry and calls fetch (optimistic)", async () => {
  reset();
  const scope = { type: "worker" as const, featureId: "f1" };
  useAgentChatStore.getState().openDrawer(scope);
  const realFetch = globalThis.fetch;
  let capturedBody: any = null;
  (globalThis as any).fetch = async (_url: string, opts: any = {}) => {
    if (!opts.method) {
      return new Response(JSON.stringify({ messages: [] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    capturedBody = JSON.parse(opts.body);
    return new Response(JSON.stringify({ threadId: "t1", messageId: "m1", wakeId: "w1" }),
      { status: 202, headers: { "content-type": "application/json" } });
  };
  try {
    await useAgentChatStore.getState().sendMessage(scope, "hello");
    const t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
    expect(t.pendingUserMessages.size).toBe(1);
    const pending = [...t.pendingUserMessages.values()][0];
    expect(pending.status).toBe("sent");
    expect(pending.messageId).toBe("m1");
    expect(t.threadId).toBe("t1");
    expect(capturedBody.content).toBe("hello");
    expect(capturedBody.clientRequestId).toMatch(/^local-/);
  } finally { (globalThis as any).fetch = realFetch; }
});

test("agent-chat store: queued server response reconciles later by clientRequestId", async () => {
  reset();
  const scope = { type: "worker" as const, featureId: "f1" };
  useAgentChatStore.getState().openDrawer(scope);
  const realFetch = globalThis.fetch;
  let clientRequestId = "";
  (globalThis as any).fetch = async (_url: string, opts: any = {}) => {
    if (!opts.method) {
      return new Response(JSON.stringify({ messages: [] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = JSON.parse(opts.body);
    clientRequestId = body.clientRequestId;
    return new Response(JSON.stringify({
      threadId: "t1", messageId: null, wakeId: null, queued: true
    }), { status: 202, headers: { "content-type": "application/json" } });
  };
  try {
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
  } finally { (globalThis as any).fetch = realFetch; }
});

test("agent-chat store: deleteQueuedMessage removes queued pending after server cancel", async () => {
  reset();
  const scope = { type: "worker" as const, featureId: "f1" };
  useAgentChatStore.getState().openDrawer(scope);
  const realFetch = globalThis.fetch;
  let deleteUrl = "";
  (globalThis as any).fetch = async (url: string, opts: any = {}) => {
    if (opts.method === "DELETE") {
      deleteUrl = String(url);
      return new Response(JSON.stringify({ ok: true, removed: true }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (!opts.method) {
      return new Response(JSON.stringify({ messages: [] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      threadId: "t1", messageId: null, wakeId: null, queued: true
    }), { status: 202, headers: { "content-type": "application/json" } });
  };
  try {
    await useAgentChatStore.getState().sendMessage(scope, "queued hello");
    let t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
    const localId = [...t.pendingUserMessages.keys()][0]!;
    expect(t.pendingUserMessages.get(localId)?.status).toBe("queued");

    await useAgentChatStore.getState().deleteQueuedMessage(scope, localId);
    t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
    expect(deleteUrl).toContain(`/api/agents/workers/f1/queued-messages/${encodeURIComponent(localId)}`);
    expect(t.pendingUserMessages.size).toBe(0);
  } finally { (globalThis as any).fetch = realFetch; }
});

test("agent-chat store: sendMessage binds new threadId and catch-up applies missed messages", async () => {
  reset();
  const scope = { type: "manager" as const };
  useAgentChatStore.getState().openDrawer(scope);
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, opts: any = {}) => {
    if (opts.method === "POST") {
      return new Response(JSON.stringify({ threadId: "ov-thread", messageId: "u1", wakeId: "w1" }),
        { status: 202, headers: { "content-type": "application/json" } });
    }
    expect(url).toContain("/api/agents/manager/thread?since=0");
    return new Response(JSON.stringify({ thread: { id: "ov-thread" }, messages: [
      { id: "u1", threadId: "ov-thread", seq: 1, role: "user", source: "user",
        sourceThreadId: null, wakeId: null, content: { type: "text", text: "hi" }, createdAt: "x" },
      { id: "a1", threadId: "ov-thread", seq: 2, role: "assistant", source: "self",
        sourceThreadId: null, wakeId: "w1", content: { type: "assistant", text: "hello" }, createdAt: "x" }
    ] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await useAgentChatStore.getState().sendMessage(scope, "hi");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const t = useAgentChatStore.getState().threadsByScope.get("manager")!;
    expect(t.threadId).toBe("ov-thread");
    expect(t.pendingUserMessages.size).toBe(0);
    expect(t.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(t.wakePhase.phase).toBe("idle");
  } finally { (globalThis as any).fetch = realFetch; }
});

test("agent-chat store: sendMessage marks failed on network error", async () => {
  reset();
  const scope = { type: "worker" as const, featureId: "f1" };
  useAgentChatStore.getState().openDrawer(scope);
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { throw new TypeError("boom"); };
  try {
    await useAgentChatStore.getState().sendMessage(scope, "hi");
    const t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
    const pending = [...t.pendingUserMessages.values()][0];
    expect(pending.status).toBe("failed");
    expect(pending.error!).toMatch(/boom/);
  } finally { (globalThis as any).fetch = realFetch; }
});

test("agent-chat store: retryFailedMessage re-sends a failed pending entry", async () => {
  reset();
  const scope = { type: "worker" as const, featureId: "f1" };
  useAgentChatStore.getState().openDrawer(scope);
  const realFetch = globalThis.fetch;
  let calls = 0;
  (globalThis as any).fetch = async (_url: string, opts: any = {}) => {
    if (!opts.method) {
      return new Response(JSON.stringify({ messages: [] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    calls++;
    if (calls === 1) throw new TypeError("first fail");
    return new Response(JSON.stringify({ threadId: "t1", messageId: "m2", wakeId: "w2" }),
      { status: 202, headers: { "content-type": "application/json" } });
  };
  try {
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
  } finally { (globalThis as any).fetch = realFetch; }
});

test("agent-chat store: ensureThreadLoaded fetches latest 50 + sets oldestSeqLoaded", async () => {
  reset();
  const scope = { type: "worker" as const, featureId: "f1" };
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(JSON.stringify({
    thread: { id: "t1", scope: "worker", scopeId: "f1" },
    messages: [
      { id: "m1", threadId: "t1", seq: 10, role: "user", source: "user",
        content: { type: "text", text: "hi" }, createdAt: "x" },
      { id: "m2", threadId: "t1", seq: 11, role: "assistant", source: "user",
        wakeId: "w1", wakeReason: "feature-event",
        wakeMetadata: { featureEvents: [{
          type: "feature_event", kind: "completion", taskId: "task-1", featureId: "feat-1",
          workItemId: null, label: "Implement source labels", summary: "Done."
        }] },
        content: { type: "assistant", text: "hello" }, createdAt: "x" }
    ],
    hasMore: true
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    await useAgentChatStore.getState().ensureThreadLoaded(scope);
    const t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
    expect(t.threadId).toBe("t1");
    expect(t.messages.length).toBe(2);
    expect(t.oldestSeqLoaded).toBe(10);
    expect(t.hasMoreOlder).toBe(true);
    expect(t.wakeReasonsById.get("w1")).toBe("feature-event");
    expect(t.wakeMetadataById.get("w1")?.featureEvents?.[0]?.label).toBe("Implement source labels");
  } finally { (globalThis as any).fetch = realFetch; }
});

test("agent-chat store: concurrent thread hydration shares a request and retries after failure", async () => {
  reset();
  const realFetch = globalThis.fetch;
  const scope = { type: "worker" as const, featureId: "shared-load" };
  let calls = 0;
  let finish!: (response: Response) => void;
  globalThis.fetch = (() => {
    calls++;
    return new Promise<Response>((resolve) => { finish = resolve; });
  }) as unknown as typeof fetch;
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
  } finally { globalThis.fetch = realFetch; reset(); }
});

test("agent-chat store: loaded scopes refresh once in the background without blocking Side", async () => {
  reset();
  const realFetch = globalThis.fetch;
  const scope = { type: "manager" as const };
  useAgentChatStore.setState({ threadsByScope: new Map([["manager", { ...newThreadState(), threadId: "main" }]]) });
  let reads = 0;
  let finish!: (response: Response) => void;
  let readFinished!: () => void;
  const finished = new Promise<void>((resolve) => { readFinished = resolve; });
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("?since=")) {
      reads++;
      return new Promise<Response>((resolve) => { finish = resolve; }).then((response) => { readFinished(); return response; });
    }
    if (url.endsWith("/main/forks")) return Response.json({ thread: { id: "side" } });
    if (url.includes("/threads/side?")) return Response.json({ thread: { id: "side" }, messages: [], hasMore: false });
    throw new Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;
  try {
    await useAgentChatStore.getState().ensureThreadLoaded(scope);
    await useAgentChatStore.getState().startSideConversation(scope);
    expect(reads).toBe(1);
    expect(useAgentChatStore.getState().sideActive).toBe(true);
  } finally {
    finish(Response.json({ thread: { id: "main" }, messages: [] }));
    await finished;
    await Bun.sleep(0);
    globalThis.fetch = realFetch;
    reset();
  }
});

test("agent-chat store: ensureThreadLoaded handles empty thread", async () => {
  reset();
  const scope = { type: "worker" as const, featureId: "f1" };
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(JSON.stringify({
    thread: null, messages: []
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    await useAgentChatStore.getState().ensureThreadLoaded(scope);
    const t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
    expect(t.threadId).toBe(null);
    expect(t.messages.length).toBe(0);
    expect(t.hasMoreOlder).toBe(false);
  } finally { (globalThis as any).fetch = realFetch; }
});

test("agent-chat store: ensureThreadLoaded merges instead of clobbering concurrent messages", async () => {
  reset();
  const scope = { type: "manager" as const };
  useAgentChatStore.getState().openDrawer(scope);
  const realFetch = globalThis.fetch;
  let resolveFetch!: (response: Response) => void;
  (globalThis as any).fetch = async () => new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  try {
    const loading = useAgentChatStore.getState().ensureThreadLoaded(scope);
    const message: AgentMessage = {
      id: "m1", threadId: "t1", seq: 1, role: "user", source: "user",
      sourceThreadId: null, wakeId: null,
      content: { type: "text", text: "sent while loading" }, createdAt: "x"
    };
    useAgentChatStore.setState({
      threadsByScope: new Map(useAgentChatStore.getState().threadsByScope)
        .set("manager", { ...newThreadState(), threadId: "t1", messages: [message] })
    });
    resolveFetch(new Response(JSON.stringify({
      thread: { id: "t1", scope: "manager", scopeId: null },
      messages: [],
      hasMore: false
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await loading;
    const t = useAgentChatStore.getState().threadsByScope.get("manager")!;
    expect(t.threadId).toBe("t1");
    expect(t.messages.map((m) => m.id)).toEqual(["m1"]);
  } finally { (globalThis as any).fetch = realFetch; }
});

test("agent-chat store: onMessageAppended adds assistant + clears streaming", () => {
  reset();
  const scope = { type: "worker" as const, featureId: "f1" };
  useAgentChatStore.getState().openDrawer(scope);
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
  useAgentChatStore.getState().openDrawer(scope);
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: string, opts: any = {}) => {
    if (!opts.method) {
      return new Response(JSON.stringify({ messages: [] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      threadId: "t1", messageId: "m1", wakeId: "w1"
    }), { status: 202, headers: { "content-type": "application/json" } });
  };
  try {
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
  } finally { (globalThis as any).fetch = realFetch; }
});

test("agent-chat store: onMessageDelta updates streamingAssistant", () => {
  reset();
  const scope = { type: "worker" as const, featureId: "f1" };
  useAgentChatStore.getState().openDrawer(scope);
  const t0 = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  useAgentChatStore.setState({
    threadsByScope: new Map(useAgentChatStore.getState().threadsByScope)
      .set("worker:f1", { ...t0, threadId: "t1" })
  });
  useAgentChatStore.getState().onMessageDelta("t1", "w1", "hel", "hel");
  useAgentChatStore.getState().onMessageDelta("t1", "w1", "lo", "hello");
  const t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect(t.streamingAssistant).toEqual({ wakeId: "w1", totalText: "hello" });
});

test("agent-chat store: onWakeStarted sets phase=thinking; onWakeFinished sets idle", () => {
  reset();
  const scope = { type: "worker" as const, featureId: "f1" };
  useAgentChatStore.getState().openDrawer(scope);
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

test("agent-chat store: onWakeStarted stores wake metadata", () => {
  reset();
  const scope = { type: "worker" as const, featureId: "f1" };
  useAgentChatStore.getState().openDrawer(scope);
  const t0 = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  useAgentChatStore.setState({
    threadsByScope: new Map(useAgentChatStore.getState().threadsByScope)
      .set("worker:f1", { ...t0, threadId: "t1" })
  });
  const metadata = {
    featureEvents: [{
      type: "feature_event" as const,
      kind: "completion" as const,
      taskId: "task-1",
      featureId: "feat-1",
      workItemId: "wi-1",
      source: {
        project: { id: "proj-1", name: "Mandate" },
        feature: { id: "feat-1", name: "Event source display" },
        workItem: { id: "wi-1", title: "Implement source labels" },
        capturedAt: "2026-05-28T00:00:00Z"
      },
      label: "Implement source labels",
      summary: "Done."
    }]
  };

  useAgentChatStore.getState().onWakeStarted("t1", "w1", "feature-event", metadata);

  const t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect(t.wakeReasonsById.get("w1")).toBe("feature-event");
  expect(t.wakeMetadataById.get("w1")).toEqual(metadata);
});

test("agent-chat store: onMessageAppended merges wake metadata from message DTOs", () => {
  reset();
  useAgentChatStore.setState({
    threadsByScope: new Map().set("worker:f1", { ...newThreadState(), threadId: "t1" })
  });
  const metadata = {
    featureEvents: [{
      type: "feature_event" as const,
      kind: "completion" as const,
      taskId: "task-1",
      featureId: "feat-1",
      workItemId: null,
      label: "Implement source labels",
      summary: "Done."
    }]
  };

  useAgentChatStore.getState().onMessageAppended("t1", {
    id: "m1", threadId: "t1", seq: 1, role: "assistant", source: "self",
    sourceThreadId: null, wakeId: "w1", wakeReason: "feature-event", wakeMetadata: metadata,
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
      replacedRange: [1, 9], replacedCount: 9
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

test("agent-chat store: drawer closed → assistant message increments unreadAssistantCount", () => {
  reset();
  useAgentChatStore.setState({
    threadsByScope: new Map().set("worker:f1", { ...newThreadState(), threadId: "t1" })
  });
  useAgentChatStore.getState().onMessageAppended("t1", {
    id: "m1", threadId: "t1", seq: 1, role: "assistant", source: "user",
    sourceThreadId: null, wakeId: "w1", content: { type: "assistant", text: "hi" }, createdAt: "x"
  });
  const t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect(t.unreadAssistantCount).toBe(1);
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
      replacedRange: [1, 400], replacedCount: 400
    }, createdAt: "x"
  });
  const t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
  expect(t.messages.length).toBe(500);
  expect(t.messages[0].seq).toBe(2);
  expect(t.messages[t.messages.length - 1].id).toBe("summary-1");
  expect(t.compressionPhase?.compressionId).toBe("c1");
});

test("agent-chat store: scopeKey for manager returns 'manager'", () => {
  expect(scopeKey({ type: "manager" })).toBe("manager");
});

test("agent-chat store: openDrawer with manager scope creates state slot", () => {
  reset();
  useAgentChatStore.getState().openDrawer({ type: "manager" });
  const t = useAgentChatStore.getState().threadsByScope.get("manager");
  expect(t).toBeTruthy();
  expect(t!.threadId).toBe(null);
});

test("agent-chat store: scopeFromKey round-trips manager + worker", () => {
  expect(scopeFromKey("manager")).toEqual({ type: "manager" });
  expect(scopeFromKey("worker:abc-123")).toEqual({ type: "worker", featureId: "abc-123" });
  expect(scopeFromKey("garbage")).toBe(null);
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
  // unread also only counted once even though delivery happened twice
  expect(t.unreadAssistantCount).toBe(1);
});

test("agent-chat store: refetchIncrementalForOpenScopes pulls since lastSeq and merges new messages", async () => {
  reset();
  // Two loaded scopes: manager (lastSeq 5) and worker f1 (lastSeq 10).
  // Scope f2 has no threadId → should be skipped entirely.
  const overviewSeed: AgentMessage = {
    id: "ov-5", threadId: "ov-thread", seq: 5, role: "user", source: "user",
    sourceThreadId: null, wakeId: null, content: { type: "text", text: "old" }, createdAt: "x"
  };
  const featureSeed: AgentMessage = {
    id: "f1-10", threadId: "f1-thread", seq: 10, role: "user", source: "user",
    sourceThreadId: null, wakeId: null, content: { type: "text", text: "old" }, createdAt: "x"
  };
  const map = new Map<string, any>()
    .set("manager", { ...newThreadState(), threadId: "ov-thread", messages: [overviewSeed] })
    .set("worker:f1", { ...newThreadState(), threadId: "f1-thread", messages: [featureSeed] })
    .set("worker:f2", { ...newThreadState(), threadId: null });
  useAgentChatStore.setState({ threadsByScope: map });

  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  (globalThis as any).fetch = async (url: string) => {
    calls.push(url);
    if (url.includes("/api/agents/manager/thread")) {
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
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await useAgentChatStore.getState().refetchIncrementalForOpenScopes();
  } finally { (globalThis as any).fetch = realFetch; }

  // f2 has null threadId — must NOT have been fetched
  expect(calls.some((u) => u.includes("/workers/f2/"))).toBe(false);
  // both URLs include since=<lastSeq>
  expect(calls.some((u) => u.includes("/manager/thread?since=5"))).toBe(true);
  expect(calls.some((u) => u.includes("/workers/f1/thread?since=10"))).toBe(true);

  const ov = useAgentChatStore.getState().threadsByScope.get("manager")!;
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
    threadsByScope: new Map().set("manager", {
      ...newThreadState(), threadId: "t1", messages: seed, oldestSeqLoaded: 1
    })
  });
  const realFetch = globalThis.fetch;
  let calledUrl = "";
  (globalThis as any).fetch = async (url: string) => {
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
  };
  try {
    await useAgentChatStore.getState().refetchIncrementalForOpenScopes();
  } finally { (globalThis as any).fetch = realFetch; }

  expect(calledUrl).toContain("/api/agents/manager/thread?since=500");
  const t = useAgentChatStore.getState().threadsByScope.get("manager")!;
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
    threadsByScope: new Map().set("manager", {
      ...newThreadState(), threadId: "t1", messages: [seed]
    })
  });
  const realFetch = globalThis.fetch;
  // Server returns the SAME message we already have (e.g. since=0 when lastSeq=1
  // would skip it, but a lagging clock could plausibly redeliver).
  (globalThis as any).fetch = async () => new Response(JSON.stringify({
    thread: { id: "t1" }, messages: [seed]
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    await useAgentChatStore.getState().refetchIncrementalForOpenScopes();
  } finally { (globalThis as any).fetch = realFetch; }
  const t = useAgentChatStore.getState().threadsByScope.get("manager")!;
  expect(t.messages.length).toBe(1);
});

test("agent-chat store: loadOlder fetches before oldestSeqLoaded and prepends", async () => {
  reset();
  const scope = { type: "worker" as const, featureId: "f1" };
  const realFetch = globalThis.fetch;
  let callIdx = 0;
  const calls: string[] = [];
  (globalThis as any).fetch = async (url: string) => {
    calls.push(url);
    callIdx++;
    if (callIdx === 1) {
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
  };
  try {
    await useAgentChatStore.getState().ensureThreadLoaded(scope);
    await useAgentChatStore.getState().loadOlder(scope);
    const t = useAgentChatStore.getState().threadsByScope.get("worker:f1")!;
    expect(t.messages.length).toBe(3);
    expect(t.messages[0].seq).toBe(18);
    expect(t.messages[2].seq).toBe(20);
    expect(t.hasMoreOlder).toBe(false);
    expect(t.oldestSeqLoaded).toBe(18);
    expect(calls[1]).toContain("before=20");
  } finally { (globalThis as any).fetch = realFetch; }
});
