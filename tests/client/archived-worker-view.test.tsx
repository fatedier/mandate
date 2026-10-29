import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { ArchivedWorkerView } from "@/routes/threads/ArchivedWorkerView";
import type { ThreadWorkerRefDto } from "@shared/api/agents";
import { runCleanups } from "../helpers/cleanup.js";
import { mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle, type Mounted } from "../helpers/mount.js";
import { useArchivedThreadsStore } from "@/store/archived-threads";
import { useOlderLoadsStore } from "@/store/older-loads";

afterEach(() => {
  // Unmount first: a chat still mounted reads its emptied store as unread and
  // reads it again, into the next test.
  runCleanups();
  useArchivedThreadsStore.setState({ byId: new Map() });
  useOlderLoadsStore.setState({ byThread: new Map() });
});

const at = "2026-09-27T00:00:00.000Z";

const ref = (id: string): ThreadWorkerRefDto => ({
  featureId: id, name: id, projectId: "p1", projectName: "project-1", workerThreadId: `thr-${id}`, archivedAt: at
});
const msg = (thread: string, seq: number) => ({
  id: `${thread}-${seq}`, threadId: thread, seq, role: "assistant", source: "self", sourceThreadId: null,
  wakeId: null, content: { type: "assistant", text: `${thread} said ${seq}` }, createdAt: at
});

const archived = (worker: ThreadWorkerRefDto) => <MemoryRouter><ArchivedWorkerView worker={worker} /></MemoryRouter>;

async function show(worker: ThreadWorkerRefDto): Promise<Mounted> {
  const view = await mountAsync(archived(worker));
  await settle();
  return view;
}

async function openTab(host: HTMLElement, label: string) {
  const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === label)!;
  await act(async () => { tab.click(); await new Promise((r) => setTimeout(r, 0)); });
}
const openChat = (host: HTMLElement) => openTab(host, "Chat");

test("an archived worker's older messages load as its chat is scrolled to the top", async () => {
  const calls = mockFetch(({ url }) => {
    if (url.includes("/canvases")) return Response.json({ canvases: [] });
    if (url.includes("/plan")) return Response.json({});
    return url.includes("before=")
      ? Response.json({ thread: { id: "thr-a" }, messages: [msg("thr-a", 1)], hasMore: false })
      : Response.json({ thread: { id: "thr-a" }, messages: [msg("thr-a", 2)], hasMore: true });
  });
  const { host } = await show(ref("a"));
  await openChat(host);
  expect(host.textContent).toContain("thr-a said 2");
  // happy-dom lays nothing out: the scroller is given heights, then scrolled.
  const scroller = host.querySelector<HTMLElement>("[class*='overflow-y-auto']")!;
  Object.defineProperty(scroller, "scrollHeight", { get: () => 3000, configurable: true });
  Object.defineProperty(scroller, "clientHeight", { get: () => 500, configurable: true });
  await act(async () => {
    scroller.scrollTop = 100;
    scroller.dispatchEvent(new window.Event("scroll"));
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(calls.some(({ url: u }) => u.includes("/api/agents/threads/thr-a") && u.includes("before=2"))).toBe(true);
  expect(host.textContent).toContain("thr-a said 1");
});

test("switching to another archived worker never shows the first one's chat", async () => {
  mockFetch(({ url }) => {
    if (url.includes("/canvases")) return Response.json({ canvases: [] });
    if (url.includes("/plan")) return Response.json({});
    // b's conversation never arrives.
    if (url.includes("thr-b")) return new Promise<Response>(() => {});
    return Response.json({ thread: { id: "thr-a" }, messages: [msg("thr-a", 2)], hasMore: false });
  });
  const view = await show(ref("a"));
  const { host } = view;
  await openChat(host);
  expect(host.textContent).toContain("thr-a said 2");
  view.rerender(archived(ref("b")));
  await settle();
  expect(host.textContent).not.toContain("thr-a said 2");
});

test("an archived worker's plan names a pane without linking to a window that is gone", async () => {
  const plan = {
    featureId: "a", conclusion: "", openQuestions: [], updatedAt: at,
    steps: [{ id: 1, title: "Profile", status: "done", note: "measured in %12", createdAt: at, startedAt: at, blockedAt: null, completedAt: at, updatedAt: at }]
  };
  mockFetch(({ url }) => {
    if (url.includes("/canvases")) return Response.json({ canvases: [] });
    if (url.includes("/plan")) return Response.json({ plan });
    return Response.json({ thread: null, messages: [], hasMore: false });
  });
  const { host } = await show(ref("a"));
  const expand = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Profile"));
  if (expand) await act(async () => { expand.click(); await new Promise((r) => setTimeout(r, 0)); });
  expect(host.textContent).toContain("%12");
  expect(host.querySelector('a[href*="/pane/"]') === null).toBe(true);
});

test("an archived worker's chat shows its failed turns, without Retry", async () => {
  mockFetch(({ url }) => {
    if (url.includes("/canvases")) return Response.json({ canvases: [] });
    if (url.includes("/plan")) return Response.json({});
    return Response.json({
      thread: { id: "thr-a" }, hasMore: false,
      messages: [msg("thr-a", 2), {
        id: "thr-a-3", threadId: "thr-a", seq: 3, role: "system", source: "wake-failure", sourceThreadId: null, wakeId: "w1", createdAt: at,
        content: { type: "wake_failure", status: "error", message: "Model request timed out. Please retry.", stepCount: 1 }
      }]
    });
  });
  const { host } = await show(ref("a"));
  await openChat(host);
  expect(host.querySelector('[data-slot="wake-failure"]')?.textContent ?? "").toContain("Model request timed out. Please retry.");
  expect(host.querySelectorAll('[data-slot="wake-failure"] button')).toHaveLength(0);
});

test("an archived worker's chat that fails to load says so and can retry", async () => {
  let attempts = 0;
  mockFetch(({ url }) => {
    if (url.includes("/canvases")) return Response.json({ canvases: [] });
    if (url.includes("/plan")) return Response.json({});
    if (url.includes("/api/agents/threads/thr-a")) {
      attempts++;
      if (attempts === 1) throw new TypeError("Failed to fetch");
    }
    return Response.json({ thread: { id: "thr-a" }, messages: [msg("thr-a", 2)], hasMore: false });
  });
  const { host } = await show(ref("a"));
  await openChat(host);
  const alert = host.querySelector('[data-slot="inline-error"]')!;
  expect(alert.textContent).toContain("Couldn't load the conversation.");
  expect(alert.textContent).toContain("Failed to fetch");
  await act(async () => { alert.querySelector("button")!.click(); await new Promise((r) => setTimeout(r, 0)); });
  await settle();
  expect(host.querySelector('[data-slot="inline-error"]') === null).toBe(true);
  expect(host.textContent).toContain("thr-a said 2");
});


// An archived worker's conversation is its own, not its Chat tab's: closed and
// opened again, the tab shows what was read without reading it again, and an
// older page on its way lands there (it used to go to the closed tab, and the
// opened one said no older messages came back).
test("an archived worker's older page on its way lands though its Chat tab was closed and opened again", async () => {
  let release: () => void = () => {};
  const calls = mockFetch(({ url }) => {
    if (url.includes("/canvases")) return Response.json({ canvases: [] });
    if (url.includes("/plan")) return Response.json({});
    if (url.includes("before=")) {
      return new Promise<Response>((resolve) => {
        release = () => resolve(Response.json({ thread: { id: "thr-r" }, messages: [msg("thr-r", 1)], hasMore: false }));
      });
    }
    return Response.json({ thread: { id: "thr-r" }, messages: [msg("thr-r", 2)], hasMore: true });
  });
  const { host } = await show(ref("r"));
  await openChat(host);
  const scroller = host.querySelector<HTMLElement>("[class*='overflow-y-auto']")!;
  Object.defineProperty(scroller, "scrollHeight", { get: () => 3000, configurable: true });
  Object.defineProperty(scroller, "clientHeight", { get: () => 500, configurable: true });
  await act(async () => {
    scroller.scrollTop = 100;
    scroller.dispatchEvent(new window.Event("scroll"));
    await new Promise((r) => setTimeout(r, 0));
  });
  await openTab(host, "Plan");
  await openChat(host);
  await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
  await settle();
  expect(host.textContent).toContain("thr-r said 1");
  expect(host.querySelector('[data-slot="inline-error"]') === null).toBe(true);
  const reads = calls.filter(({ url }) => url.includes("/api/agents/threads/thr-r"));
  expect(reads.filter(({ url }) => !url.includes("before="))).toHaveLength(1);
  expect(reads.filter(({ url }) => url.includes("before="))).toHaveLength(1);
});

// A read that answers after the tab was closed fills the conversation for the
// tab opened again, even when that tab's own read failed: what was read shows.
test("an archived chat's first read that lands after its tab was reopened shows, over the reopened tab's failed read", async () => {
  let releaseFirst: () => void = () => {};
  let reads = 0;
  mockFetch(({ url }) => {
    if (!url.includes("/api/agents/threads/thr-s")) return Response.json({});
    reads += 1;
    if (reads === 1) {
      return new Promise<Response>((resolve) => {
        releaseFirst = () => resolve(Response.json({ thread: { id: "thr-s" }, messages: [msg("thr-s", 2)], hasMore: false }));
      });
    }
    throw new TypeError("Failed to fetch");
  });
  const { host } = await show(ref("s"));
  await openChat(host);
  await openTab(host, "Plan");
  await openChat(host);
  await settle();
  expect(host.textContent).toContain("Couldn't load the conversation.");
  await act(async () => { releaseFirst(); await new Promise((r) => setTimeout(r, 0)); });
  await settle();
  expect(host.textContent).toContain("thr-s said 2");
  expect(host.textContent).not.toContain("Couldn't load the conversation.");
});
