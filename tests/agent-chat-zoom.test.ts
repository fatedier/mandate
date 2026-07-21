import { afterEach, beforeEach, expect, test } from "bun:test";
import { useAgentChatStore as store, newThreadState, type AgentMessage } from "../src/client/store/agent-chat";

const initial = store.getState();
beforeEach(() => store.setState({
  drawerOpen: true, drawerMode: "side", drawerScope: { type: "worker", featureId: "zoom" },
  threadsByScope: new Map([["worker:zoom", { ...newThreadState(), threadId: "main" }]]),
  sideThread: { ...newThreadState(), threadId: "side" }, sideActive: false
}));
afterEach(() => store.setState(initial, true));

function reply(threadId: string, seq: number): AgentMessage {
  return {
    id: `${threadId}-${seq}`, threadId, seq, role: "assistant", source: "user",
    sourceThreadId: null, wakeId: null, content: { type: "assistant", text: "New reply" },
    createdAt: "2026-09-13T00:00:00.000Z"
  };
}
function unread(side: boolean) {
  return (side ? store.getState().sideThread : store.getState().threadsByScope.get("worker:zoom"))!.unreadAssistantCount;
}

for (const side of [false, true]) {
  test(`${side ? "side" : "main"} replies are unread while Worker zoom hides the open dock`, () => {
    store.setState({ sideActive: side });
    const threadId = side ? "side" : "main";
    store.getState().onMessageAppended(threadId, reply(threadId, 1));
    expect(unread(side)).toBe(0);
    store.getState().setDrawerMode("worker");
    const message = reply(threadId, 2);
    store.getState().onMessageAppended(threadId, message);
    store.getState().onMessageAppended(threadId, message);
    expect(unread(side)).toBe(1);
    expect(store.getState().drawerOpen).toBe(true);
    store.getState().setDrawerMode("side");
    expect(unread(side)).toBe(0);
    store.getState().setDrawerMode("fullscreen");
    store.getState().onMessageAppended(threadId, reply(threadId, 3));
    expect(unread(side)).toBe(0);
  });

  test(`restoring Chat clears only the ${side ? "side" : "main"} conversation actually shown`, () => {
    store.setState({ sideActive: side });
    store.getState().setDrawerMode("worker");
    store.getState().onMessageAppended("main", reply("main", 1));
    store.getState().onMessageAppended("side", reply("side", 1));
    expect(unread(false)).toBe(1);
    expect(unread(true)).toBe(1);
    store.getState().setDrawerMode("fullscreen");
    expect(unread(side)).toBe(0);
    expect(unread(!side)).toBe(1);
  });
}

test("restoring a closed dock preserves unread replies", () => {
  store.setState({ drawerOpen: false });
  store.getState().setDrawerMode("worker");
  store.getState().onMessageAppended("main", reply("main", 1));
  store.getState().onMessageAppended("side", reply("side", 1));
  store.getState().setDrawerMode("side");
  expect(unread(false)).toBe(1);
  expect(unread(true)).toBe(1);
  expect(store.getState().drawerOpen).toBe(false);
});

for (const mode of ["side", "fullscreen"] as const) {
  for (const scope of [{ type: "worker", featureId: "zoom" }, { type: "manager" }] as const) {
    test(`returning from Side clears only the displayed ${scope.type} conversation in ${mode} mode`, () => {
      const key = scope.type === "manager" ? "manager" : "worker:zoom";
      const other = scope.type === "manager" ? "worker:zoom" : "manager";
      store.setState({
        drawerMode: mode, drawerScope: scope, sideActive: true,
        sideThread: { ...newThreadState(), threadId: "side", unreadAssistantCount: 3 },
        threadsByScope: new Map([
          [key, { ...newThreadState(), threadId: "main" }],
          [other, { ...newThreadState(), threadId: "other", unreadAssistantCount: 7 }]
        ])
      });
      store.getState().onMessageAppended("main", reply("main", 1));
      expect(store.getState().threadsByScope.get(key)!.unreadAssistantCount).toBe(1);
      store.getState().showMainConversation();
      expect(store.getState().sideActive).toBe(false);
      expect(store.getState().threadsByScope.get(key)!.unreadAssistantCount).toBe(0);
      expect(store.getState().threadsByScope.get(other)!.unreadAssistantCount).toBe(7);
      expect(store.getState().sideThread!.unreadAssistantCount).toBe(3);
      store.getState().closeDrawer();
      expect(store.getState().threadsByScope.get(key)!.unreadAssistantCount).toBe(0);
    });
  }
}

for (const hidden of ["closed", "worker zoom"]) {
  test(`returning from Side while ${hidden} keeps unseen main replies unread`, () => {
    store.setState({ sideActive: true, drawerOpen: hidden !== "closed", drawerMode: hidden === "closed" ? "side" : "worker" });
    store.getState().onMessageAppended("main", reply("main", 1));
    store.getState().showMainConversation();
    expect(store.getState().sideActive).toBe(false);
    expect(unread(false)).toBe(1);
  });
}

test("closing Side also clears the main replies it reveals", async () => {
  store.setState({ sideActive: true });
  store.getState().onMessageAppended("main", reply("main", 1));
  expect(unread(false)).toBe(1);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ ok: true });
  try {
    await store.getState().closeSideConversation();
    expect(store.getState().sideThread).toBeNull();
    expect(store.getState().sideActive).toBe(false);
    expect(unread(false)).toBe(0);
  } finally { globalThis.fetch = originalFetch; }
});
