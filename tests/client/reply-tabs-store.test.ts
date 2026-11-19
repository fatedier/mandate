import { afterEach, expect, test } from "bun:test";
import { SSE_EVENTS, type ReplyTabDto } from "../../src/shared/api-contracts.js";
import { useReplyTabsStore } from "../../src/client/store/reply-tabs.js";
import { attachSnapshotSseListeners } from "../../src/client/lib/snapshot-sse-listeners.js";
import { jsonResponse, mockFetch, type FetchCall } from "../helpers/fetch.js";
import { runCleanups } from "../helpers/cleanup.js";
import { settleRounds } from "../helpers/mount.js";

// Each thread's reply tabs as the server keeps them: read when first asked
// about, after every change the server reports, and after a reconnect; an
// answer older than the one shown never replaces it.

afterEach(() => {
  runCleanups();
  useReplyTabsStore.setState({ byThread: new Map(), latest: new Map(), applied: new Map() });
});

const tab = (id: string, messageId: string, threadId = "thr_1"): ReplyTabDto => ({
  id, threadId, messageId, text: `Reply ${messageId}`, repliedAt: "2026-10-29T12:00:00.000Z", createdAt: "2026-10-29T12:01:00.000Z"
});

/** The server's reply tabs for every thread: GET lists, POST adds, DELETE removes. */
function serve(initial: Record<string, ReplyTabDto[]> = {}) {
  const tabs = new Map(Object.entries(initial));
  let next = 1;
  const calls = mockFetch((call) => {
    const parts = new URL(call.url, "http://x").pathname.split("/");
    const threadId = decodeURIComponent(parts[4]!);
    const list = tabs.get(threadId) ?? [];
    if (call.method === "POST") {
      const { messageId, text } = JSON.parse(String(call.init?.body)) as { messageId: string; text: string };
      if (text === "refused") return jsonResponse({ error: "reply not found in this thread" }, 404);
      tabs.set(threadId, [...list, { ...tab(`rtab_${next++}`, messageId, threadId), text }]);
    }
    if (call.method === "DELETE") tabs.set(threadId, list.filter((t) => t.id !== decodeURIComponent(parts[6]!)));
    return jsonResponse({ tabs: tabs.get(threadId) ?? [] });
  });
  return calls;
}

const gets = (calls: FetchCall[], threadId: string) => calls.filter((c) => c.method === "GET" && c.url.includes(`/threads/${threadId}/`)).length;

test("loads a thread's tabs, adds and removes with the server's lists", async () => {
  const calls = serve({ thr_1: [tab("rtab_old", "msg_0")] });
  const store = useReplyTabsStore.getState;
  await store().load("thr_1");
  expect(store().byThread.get("thr_1")?.map((t) => t.id)).toEqual(["rtab_old"]);
  const created = await store().add("thr_1", "msg_1", "**Release check**: two of three ready.");
  expect(created).toMatchObject({ messageId: "msg_1", text: "**Release check**: two of three ready." });
  expect(store().byThread.get("thr_1")?.map((t) => t.messageId)).toEqual(["msg_0", "msg_1"]);
  await store().remove("thr_1", "rtab_old");
  expect(store().byThread.get("thr_1")?.map((t) => t.messageId)).toEqual(["msg_1"]);
  expect(calls.map((c) => `${c.method} ${new URL(c.url, "http://x").pathname}`)).toEqual([
    "GET /api/agents/threads/thr_1/reply-tabs",
    "POST /api/agents/threads/thr_1/reply-tabs",
    "DELETE /api/agents/threads/thr_1/reply-tabs/rtab_old"
  ]);
});

test("a refused add throws the server's reason and changes nothing", async () => {
  serve({ thr_1: [] });
  await useReplyTabsStore.getState().load("thr_1");
  let error: unknown = null;
  try {
    await useReplyTabsStore.getState().add("thr_1", "msg_9", "refused");
  } catch (err) {
    error = err;
  }
  expect(error instanceof Error ? error.message : null).toBe("reply not found in this thread");
  expect(useReplyTabsStore.getState().byThread.get("thr_1")).toEqual([]);
});

test("an older answer does not replace a newer one", async () => {
  let releaseRead: (() => void) | null = null;
  mockFetch((call) => {
    if (call.method === "GET") return new Promise<Response>((resolve) => { releaseRead = () => resolve(jsonResponse({ tabs: [] })); });
    return jsonResponse({ tabs: [tab("rtab_1", "msg_1")] });
  });
  const read = useReplyTabsStore.getState().load("thr_1");
  await useReplyTabsStore.getState().add("thr_1", "msg_1", "Reply msg_1");
  releaseRead!();
  await read;
  expect(useReplyTabsStore.getState().byThread.get("thr_1")?.map((t) => t.id)).toEqual(["rtab_1"]);
});

test("changed reloads only threads already asked about; changedAll reloads them all", async () => {
  const calls = serve({ thr_1: [], thr_2: [], thr_3: [] });
  const store = useReplyTabsStore.getState;
  await store().load("thr_1");
  await store().load("thr_3");
  store().changed("thr_2");
  store().changed("thr_1");
  await settleRounds();
  expect([gets(calls, "thr_1"), gets(calls, "thr_2"), gets(calls, "thr_3")]).toEqual([2, 0, 1]);
  store().changedAll();
  await settleRounds();
  expect([gets(calls, "thr_1"), gets(calls, "thr_2"), gets(calls, "thr_3")]).toEqual([3, 0, 2]);
});

test("the stream's replyTabsChanged reads the thread again, and a reconnect reads every thread asked about", async () => {
  const calls = serve({ thr_1: [], thr_2: [] });
  await useReplyTabsStore.getState().load("thr_1");
  await useReplyTabsStore.getState().load("thr_2");
  const source = new EventTarget() as EventSource;
  attachSnapshotSseListeners(source, { cancelled: () => false, setConnection: () => {}, onReconnect: () => {} });
  source.dispatchEvent(new MessageEvent(SSE_EVENTS.replyTabsChanged, { data: JSON.stringify({ threadId: "thr_1" }) }));
  await settleRounds();
  expect([gets(calls, "thr_1"), gets(calls, "thr_2")]).toEqual([2, 1]);
  source.dispatchEvent(new Event("open"));
  await settleRounds();
  expect([gets(calls, "thr_1"), gets(calls, "thr_2")]).toEqual([3, 2]);
});
