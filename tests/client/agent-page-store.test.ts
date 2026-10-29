import { afterEach, expect, jest, test } from "bun:test";
import { resetAgentPageStore, useAgentPageStore, PAGE_DATA_DEBOUNCE_MS } from "@/store/agent-page";
import type { AgentPageSourceDto, AgentPageStateDto } from "@shared/api/agent-page";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { runCleanups } from "../helpers/cleanup.js";
import { fakeClock } from "../helpers/fake-clock.js";

afterEach(() => { runCleanups(); resetAgentPageStore(); });

const STATE = (revision: number | null): AgentPageStateDto => ({
  latest: revision === null ? null : { revision, writer: "agent", createdAt: "2026-10-20T10:06:00.000Z" },
  write: null
});
const SOURCE: AgentPageSourceDto = { name: "prom", run: "echo 1", everyMs: 300_000, cwd: null, paused: false, lastRunAt: null, lastError: null };

/** The server's page: its state, versions and sources; every URL asked for. */
function serve(over: { state?: AgentPageStateDto } = {}) {
  const urls: string[] = [];
  let state = over.state ?? STATE(2);
  mockFetch((call) => {
    const path = new URL(call.url, "http://x").pathname;
    urls.push(path);
    if (path === "/api/agent-page") return jsonResponse(state);
    const version = path.match(/^\/api\/agent-page\/versions\/(\d+)$/);
    if (version) return jsonResponse({ revision: Number(version[1]), html: `<p>v${version[1]}</p>`, writer: "agent", createdAt: "2026-10-20T10:06:00.000Z" });
    if (path === "/api/agent-page/sources") return jsonResponse({ sources: [SOURCE] });
    const data = path.match(/^\/api\/agent-page\/data\/(.+)$/);
    if (data) return jsonResponse({ name: decodeURIComponent(data[1]!), value: urls.length, at: null, error: null });
    return jsonResponse({}, 404);
  });
  return { urls, setState: (next: AgentPageStateDto) => { state = next; } };
}

const settle = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

test("refresh reads state, version and sources; events replace them; a refresh refetches what is followed", async () => {
  const s = serve();
  await useAgentPageStore.getState().refresh();
  await settle();
  const store = useAgentPageStore.getState;
  expect(store().state).toEqual(STATE(2));
  expect(store().version).toMatchObject({ revision: 2, html: "<p>v2</p>" });
  expect(store().sources).toEqual([SOURCE]);
  // A new version published: read by its revision.
  store().applyState(STATE(3));
  await settle();
  expect(store().version).toMatchObject({ revision: 3, html: "<p>v3</p>" });
  // An older state arriving late never brings an older page back.
  store().applyState(STATE(2));
  await settle();
  expect(store().version?.revision).toBe(3);
  // A source ran; then it was removed.
  store().applySource({ name: "prom", source: { ...SOURCE, lastRunAt: "2026-10-20T10:05:00.000Z" }, data: { name: "prom", value: 7, at: "2026-10-20T10:05:00.000Z", error: null } });
  expect([store().sources[0]?.lastRunAt, store().data.get("prom")?.value]).toEqual(["2026-10-20T10:05:00.000Z", 7]);
  store().applySource({ name: "prom", source: null, data: null });
  expect([store().sources, store().data.has("prom")]).toEqual([[], false]);
  // A refresh (the stream came back) reads the followed data again.
  store().follow("threads");
  await settle();
  const before = s.urls.filter((u) => u === "/api/agent-page/data/threads").length;
  await store().refresh();
  expect(s.urls.filter((u) => u === "/api/agent-page/data/threads").length).toBe(before + 1);
});

test("built-in data is refetched on the events that change it, debounced; only what the page follows", async () => {
  fakeClock();
  const s = serve();
  const store = useAgentPageStore.getState;
  store().follow("threads");
  store().follow("usage");
  await Promise.resolve();
  const reads = (name: string) => s.urls.filter((u) => u === `/api/agent-page/data/${name}`).length;
  expect([reads("threads"), reads("usage")]).toEqual([1, 1]);
  // A burst of changes: one read, a second after.
  store().onEvent("work");
  store().onEvent("work");
  store().onEvent("work");
  jest.advanceTimersByTime(PAGE_DATA_DEBOUNCE_MS.work - 1);
  await Promise.resolve();
  expect(reads("threads")).toBe(1);
  jest.advanceTimersByTime(1);
  await Promise.resolve();
  expect(reads("threads")).toBe(2);
  // A change to what the page does not follow reads nothing.
  store().onEvent("questions");
  store().onEvent("canvases");
  jest.advanceTimersByTime(5000);
  await Promise.resolve();
  expect(s.urls.filter((u) => u.includes("questions") || u.includes("canvases"))).toStrictEqual([]);
  // Usage waits half a minute.
  store().onEvent("usage");
  jest.advanceTimersByTime(29_000);
  await Promise.resolve();
  expect(reads("usage")).toBe(1);
  jest.advanceTimersByTime(1000);
  await Promise.resolve();
  expect(reads("usage")).toBe(2);
});

test("a submit says what the server said; pausing and removing change the list", async () => {
  mockFetch((call) => {
    const path = new URL(call.url, "http://x").pathname;
    const body = call.init?.body ? JSON.parse(String(call.init.body)) : null;
    if (path === "/api/agent-page/answers") {
      return body.value === "big" ? jsonResponse({ error: "an answer is at most 8 KB of JSON" }, 413) : jsonResponse({ answer: { id: "pga_1", value: body.value, at: "x", read: false } });
    }
    if (path === "/api/agent-page/sources/prom" && call.init?.method === "PATCH") return jsonResponse({ source: { ...SOURCE, paused: body.paused } });
    if (path === "/api/agent-page/sources/prom" && call.init?.method === "DELETE") return jsonResponse({ removed: true });
    return jsonResponse({}, 404);
  });
  const store = useAgentPageStore.getState;
  expect(await store().submit({ pick: "c" })).toEqual({ ok: true });
  expect(await store().submit("big")).toEqual({ ok: false, error: "an answer is at most 8 KB of JSON" });
  useAgentPageStore.setState({ sources: [SOURCE] });
  await store().setPaused("prom", true);
  expect(store().sources[0]?.paused).toBe(true);
  await store().remove("prom");
  expect(store().sources).toEqual([]);
});

test("versions read out of order: the newer one stays", async () => {
  let openV3!: () => void;
  const v3Gate = new Promise<void>((resolve) => { openV3 = resolve; });
  mockFetch(async (call) => {
    const path = new URL(call.url, "http://x").pathname;
    const version = path.match(/^\/api\/agent-page\/versions\/(\d+)$/);
    if (!version) return jsonResponse({}, 404);
    if (version[1] === "3") await v3Gate;
    return jsonResponse({ revision: Number(version[1]), html: `<p>v${version[1]}</p>`, writer: "agent", createdAt: "2026-10-20T10:06:00.000Z" });
  });
  const store = useAgentPageStore.getState;
  store().applyState(STATE(3));
  store().applyState(STATE(4));
  await settle();
  expect(store().version?.revision).toBe(4);
  openV3();
  await settle();
  expect(store().version?.revision).toBe(4);
});

test("reads started before a change over the stream never put older state back; a 404 clears the data", async () => {
  let openState!: () => void;
  const stateGate = new Promise<void>((resolve) => { openState = resolve; });
  let openData!: () => void;
  const dataGate = new Promise<void>((resolve) => { openData = resolve; });
  let gone = false;
  mockFetch(async (call) => {
    const path = new URL(call.url, "http://x").pathname;
    if (path === "/api/agent-page") { await stateGate; return jsonResponse(STATE(null)); }
    if (path === "/api/agent-page/sources") return jsonResponse({ sources: [SOURCE] });
    if (path === "/api/agent-page/data/prom") {
      if (gone) return jsonResponse({ error: "page source not found" }, 404);
      await dataGate;
      return jsonResponse({ name: "prom", value: "old", at: null, error: null });
    }
    if (path.startsWith("/api/agent-page/versions/")) return jsonResponse({ revision: 3, html: "<p>v3</p>", writer: "agent", createdAt: "x" });
    return jsonResponse({}, 404);
  });
  const store = useAgentPageStore.getState;
  // A refresh whose state read is overtaken by a published version.
  const refresh = store().refresh();
  store().applyState(STATE(3));
  openState();
  await refresh;
  expect(store().state?.latest?.revision).toBe(3);
  // A data read overtaken by the source's removal does not bring it back.
  useAgentPageStore.setState({ followed: new Set(["prom"]) });
  const read = store().fetchData("prom");
  store().applySource({ name: "prom", source: null, data: null });
  openData();
  await read;
  expect(store().data.has("prom")).toBe(false);
  // Removed while the stream was down: the read after it says so, and the data goes.
  useAgentPageStore.setState({ data: new Map([["prom", { name: "prom", value: 1, at: null, error: null }]]) });
  gone = true;
  await store().fetchData("prom");
  // Settled as absent: old data gone, and a page asking for it gets an answer.
  expect(store().data.get("prom")).toEqual({ name: "prom", value: null, at: null, error: "no such source" });
});

test("a source is followed while some frame follows it, and let go of when none does", async () => {
  mockFetch(() => jsonResponse({ name: "threads", value: [], at: null, error: null }));
  const store = useAgentPageStore.getState;
  store().follow("threads");
  store().follow("threads");
  store().unfollow("threads");
  expect(store().followed.has("threads")).toBe(true);
  store().unfollow("threads");
  expect(store().followed.has("threads")).toBe(false);
});

test("a sources read overtaken by a removal does not bring the source back", async () => {
  let openSources!: () => void;
  const gate = new Promise<void>((resolve) => { openSources = resolve; });
  mockFetch(async (call) => {
    const path = new URL(call.url, "http://x").pathname;
    if (path === "/api/agent-page") return jsonResponse(STATE(null));
    if (path === "/api/agent-page/sources") { await gate; return jsonResponse({ sources: [SOURCE] }); }
    return jsonResponse({}, 404);
  });
  const store = useAgentPageStore.getState;
  useAgentPageStore.setState({ sources: [SOURCE] });
  const refresh = store().refresh();
  await settle();
  store().applySource({ name: "prom", source: null, data: null });
  openSources();
  await refresh;
  expect(store().sources).toEqual([]);
});

/** A promise and its release. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

test("a source followed again after nobody followed it is read afresh", async () => {
  let reads = 0;
  mockFetch(() => { reads += 1; return jsonResponse({ name: "threads", value: reads, at: null, error: null }); });
  const store = useAgentPageStore.getState;
  store().follow("threads");
  await settle();
  store().unfollow("threads");
  store().follow("threads");
  await settle();
  expect([reads, store().data.get("threads")?.value]).toEqual([2, 2]);
});

test("of two reads of one source, the newer wins, whichever answers last; an event during the body's read wins too", async () => {
  const first = gate();
  const bodyGate = gate();
  let n = 0;
  mockFetch(async () => {
    n += 1;
    if (n === 1) { await first.promise; return jsonResponse({ name: "prom", value: "older", at: null, error: null }); }
    if (n === 2) return jsonResponse({ name: "prom", value: "newer", at: null, error: null });
    // A body that arrives late.
    const body = new ReadableStream({ async start(controller) { await bodyGate.promise; controller.enqueue(new TextEncoder().encode(JSON.stringify({ name: "prom", value: "late", at: null, error: null }))); controller.close(); } });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  });
  const store = useAgentPageStore.getState;
  const older = store().fetchData("prom");
  const newer = store().fetchData("prom");
  await newer;
  first.open();
  await older;
  expect(store().data.get("prom")?.value).toBe("newer");
  const late = store().fetchData("prom");
  await settle();
  store().applySource({ name: "prom", source: SOURCE, data: { name: "prom", value: "from the stream", at: null, error: null } });
  bodyGate.open();
  await late;
  expect(store().data.get("prom")?.value).toBe("from the stream");
});

test("of two refreshes, the newer one's state stays even when the older answers first", async () => {
  const older = gate();
  let n = 0;
  mockFetch(async (call) => {
    const path = new URL(call.url, "http://x").pathname;
    if (path === "/api/agent-page") {
      n += 1;
      if (n === 1) { await older.promise; return jsonResponse(STATE(1)); }
      return jsonResponse(STATE(2));
    }
    if (path === "/api/agent-page/sources") return jsonResponse({ sources: [] });
    return jsonResponse({ revision: 2, html: "<p>2</p>", writer: "agent", createdAt: "x" });
  });
  const store = useAgentPageStore.getState;
  const first = store().refresh();
  const second = store().refresh();
  await second;
  older.open();
  await first;
  expect(store().state?.latest?.revision).toBe(2);
  // And the other way round: the older answering first is replaced by the newer.
  resetAgentPageStore();
  const late = gate();
  n = 0;
  mockFetch(async (call) => {
    const path = new URL(call.url, "http://x").pathname;
    if (path === "/api/agent-page") {
      n += 1;
      if (n === 2) { await late.promise; return jsonResponse(STATE(2)); }
      return jsonResponse(STATE(1));
    }
    if (path === "/api/agent-page/sources") return jsonResponse({ sources: [] });
    return jsonResponse({ revision: 1, html: "<p>1</p>", writer: "agent", createdAt: "x" });
  });
  const a = store().refresh();
  const b = store().refresh();
  await a;
  late.open();
  await b;
  expect(store().state?.latest?.revision).toBe(2);
});

test("a sources read that a source's event overtakes keeps every other source it read", async () => {
  const listGate = gate();
  const paused = { ...SOURCE, name: "quiet", paused: true };
  mockFetch(async (call) => {
    const path = new URL(call.url, "http://x").pathname;
    if (path === "/api/agent-page") return jsonResponse(STATE(null));
    if (path === "/api/agent-page/sources") { await listGate.promise; return jsonResponse({ sources: [SOURCE, paused] }); }
    return jsonResponse({}, 404);
  });
  const store = useAgentPageStore.getState;
  const refresh = store().refresh();
  await settle();
  // prom ran while the list was read; a new one, ci, was listed.
  store().applySource({ name: "prom", source: { ...SOURCE, lastRunAt: "2026-10-20T10:10:00.000Z" }, data: null });
  store().applySource({ name: "ci", source: { ...SOURCE, name: "ci" }, data: null });
  listGate.open();
  await refresh;
  expect(store().sources.map((s) => [s.name, s.lastRunAt])).toEqual([["prom", "2026-10-20T10:10:00.000Z"], ["quiet", null], ["ci", null]]);
});

test("a pause whose answer comes after another tab removed the source does not bring it back", async () => {
  const patchGate = gate();
  mockFetch(async (call) => {
    if (call.init?.method === "PATCH") { await patchGate.promise; return jsonResponse({ source: { ...SOURCE, paused: true } }); }
    return jsonResponse({}, 404);
  });
  const store = useAgentPageStore.getState;
  useAgentPageStore.setState({ sources: [SOURCE] });
  const pause = store().setPaused("prom", true);
  await settle();
  store().applySource({ name: "prom", source: null, data: null });
  patchGate.open();
  await pause;
  expect(store().sources).toEqual([]);
});

test("data read again with nothing changed keeps its object, so the page is not sent it again", async () => {
  let at = 0;
  mockFetch(() => { at += 1; return jsonResponse({ name: "threads", value: [{ id: "thr_1" }], at: `2026-10-20T10:00:0${at}.000Z`, error: null }); });
  const store = useAgentPageStore.getState;
  await store().fetchData("threads");
  const first = store().data.get("threads");
  await store().fetchData("threads");
  expect(store().data.get("threads") === first).toBe(true);
});

test("a pause and a removal clicked close together both take, in the order clicked, whichever answers first", async () => {
  for (const order of ["pause first", "remove first"] as const) {
    resetAgentPageStore();
    const pauseGate = gate();
    const removeGate = gate();
    mockFetch(async (call) => {
      if (call.init?.method === "PATCH") { await pauseGate.promise; return jsonResponse({ source: { ...SOURCE, paused: true } }); }
      if (call.init?.method === "DELETE") { await removeGate.promise; return jsonResponse({ removed: true }); }
      return jsonResponse({}, 404);
    });
    const store = useAgentPageStore.getState;
    useAgentPageStore.setState({ sources: [SOURCE] });
    const pause = store().setPaused("prom", true);
    const remove = store().remove("prom");
    await settle();
    if (order === "pause first") { pauseGate.open(); await pause; removeGate.open(); await remove; }
    else { removeGate.open(); await remove; pauseGate.open(); await pause; }
    expect([order, store().sources]).toEqual([order, []]);
  }
});

test("a source's run that read what it had sends its line only: the data stays, and a read in flight still lands", async () => {
  const body = gate();
  mockFetch(async () => { await body.promise; return jsonResponse({ name: "prom", value: 7, at: "2026-10-20T10:05:00.000Z", error: null }); });
  const store = useAgentPageStore.getState;
  const read = store().fetchData("prom");
  await settle();
  const ran = { ...SOURCE, lastRunAt: "2026-10-20T10:10:00.000Z" };
  store().applySource({ name: "prom", source: ran });
  body.open();
  await read;
  expect(store().sources).toEqual([ran]);
  expect(store().data.get("prom")?.value).toBe(7);
  // Once there, the data keeps its object through more such runs.
  const kept = store().data.get("prom");
  store().applySource({ name: "prom", source: { ...ran, lastRunAt: "2026-10-20T10:15:00.000Z" } });
  expect(store().data.get("prom")).toBe(kept);
  expect(store().sources[0]?.lastRunAt).toBe("2026-10-20T10:15:00.000Z");
});
