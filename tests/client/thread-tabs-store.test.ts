import { afterEach, expect, test } from "bun:test";
import { SSE_EVENTS, type ThreadTabDto } from "../../src/shared/api-contracts.js";
import { useThreadTabsStore } from "../../src/client/store/thread-tabs.js";
import { attachSnapshotSseListeners } from "../../src/client/lib/snapshot-sse-listeners.js";
import { jsonResponse, mockFetch, type FetchCall } from "../helpers/fetch.js";
import { runCleanups } from "../helpers/cleanup.js";
import { settleRounds } from "../helpers/mount.js";

// The threads opened beside the personal agent, as the server keeps them: read when
// first asked about, after every change the server reports, after a deleted
// thread and after a reconnect; an answer older than the one shown never
// replaces it.

afterEach(() => {
  runCleanups();
  useThreadTabsStore.setState({ tabs: null, latest: 0, applied: 0 });
});

const tab = (threadId: string): ThreadTabDto => ({ threadId, createdAt: "2026-11-03T12:00:00.000Z" });

/** The server's thread tabs: GET lists, POST adds, DELETE removes. */
function serve(initial: string[] = []) {
  let tabs = initial.map(tab);
  return mockFetch((call) => {
    const parts = new URL(call.url, "http://x").pathname.split("/");
    if (call.method === "POST") {
      const { threadId } = JSON.parse(String(call.init?.body)) as { threadId: string };
      if (threadId === "thr_worker") return jsonResponse({ error: "thread not found" }, 404);
      if (!tabs.some((t) => t.threadId === threadId)) tabs = [...tabs, tab(threadId)];
    }
    if (call.method === "DELETE") tabs = tabs.filter((t) => t.threadId !== decodeURIComponent(parts[5]!));
    return jsonResponse({ tabs });
  });
}

const gets = (calls: FetchCall[]) => calls.filter((c) => c.method === "GET").length;
const ids = () => useThreadTabsStore.getState().tabs?.map((t) => t.threadId);

test("loads the tabs, opens and closes one with the server's lists", async () => {
  const calls = serve(["thr_release"]);
  const store = useThreadTabsStore.getState;
  expect(store().tabs).toBeNull();
  await store().load();
  expect(ids()).toEqual(["thr_release"]);
  await store().add("thr_docs");
  expect(ids()).toEqual(["thr_release", "thr_docs"]);
  await store().remove("thr_release");
  expect(ids()).toEqual(["thr_docs"]);
  expect(calls.map((c) => `${c.method} ${new URL(c.url, "http://x").pathname}`)).toEqual([
    "GET /api/agents/personal/thread-tabs",
    "POST /api/agents/personal/thread-tabs",
    "DELETE /api/agents/personal/thread-tabs/thr_release"
  ]);
});

test("a refused open throws the server's reason and changes nothing", async () => {
  serve([]);
  await useThreadTabsStore.getState().load();
  let error: unknown = null;
  try {
    await useThreadTabsStore.getState().add("thr_worker");
  } catch (err) {
    error = err;
  }
  expect(error instanceof Error ? error.message : null).toBe("thread not found");
  expect(ids()).toEqual([]);
});

test("an older answer does not replace a newer one", async () => {
  let releaseRead: (() => void) | null = null;
  mockFetch((call) => {
    if (call.method === "GET") return new Promise<Response>((resolve) => { releaseRead = () => resolve(jsonResponse({ tabs: [] })); });
    return jsonResponse({ tabs: [tab("thr_docs")] });
  });
  const read = useThreadTabsStore.getState().load();
  await useThreadTabsStore.getState().add("thr_docs");
  releaseRead!();
  await read;
  expect(ids()).toEqual(["thr_docs"]);
});

test("changed reads again only once asked about", async () => {
  const calls = serve([]);
  useThreadTabsStore.getState().changed();
  await settleRounds();
  expect(gets(calls)).toBe(0);
  await useThreadTabsStore.getState().load();
  useThreadTabsStore.getState().changed();
  await settleRounds();
  expect(gets(calls)).toBe(2);
});

test("the stream's threadTabsChanged, a deleted thread and a reconnect each read the tabs again", async () => {
  const calls = serve(["thr_release"]);
  await useThreadTabsStore.getState().load();
  const source = new EventTarget() as EventSource;
  attachSnapshotSseListeners(source, { cancelled: () => false, setConnection: () => {}, onReconnect: () => {} });
  source.dispatchEvent(new MessageEvent(SSE_EVENTS.threadTabsChanged, { data: JSON.stringify({}) }));
  await settleRounds();
  expect(gets(calls)).toBe(2);
  source.dispatchEvent(new MessageEvent(SSE_EVENTS.managerThreadDeleted, { data: JSON.stringify({ threadId: "thr_release" }) }));
  await settleRounds();
  expect(gets(calls)).toBe(3);
  source.dispatchEvent(new Event("open"));
  await settleRounds();
  expect(gets(calls)).toBe(4);
});
