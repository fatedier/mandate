import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { toast } from "sonner";
import { ThreadPage } from "@/routes/threads/ThreadPage";
import { PaneHeader } from "@/shell/PaneHeader";
import { PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useAgentChatStore } from "@/store/agent-chat";
import { useProjectsStore, type Project } from "@/store/projects";
import { useWorkItemsStore } from "@/store/work-items";
import { useWorkerPlansStore } from "@/store/worker-plans";
import { useWorkerPanelStore } from "@/store/worker-panel";
import { useCommandsStore } from "@/store/commands";
import type { WorkItemDto } from "@shared/api/work-items";
import { emptyPlan, type WorkerPlanDto } from "@shared/api/plans";
import { workerReportMetadata } from "@shared/worker-report";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mockFetch, withFetch } from "../helpers/fetch.js";
import { mountAsync, settle, settleRounds, settleUntil, type Mounted } from "../helpers/mount.js";
import { clientWorker, clientProject, managerThreadDto } from "../helpers/client-builders.js";
import { reducedMotion } from "../helpers/motion.js";
import { resetCanvasTitles } from "@/store/canvas-titles";
import { useReplyTabsStore } from "@/store/reply-tabs";
import type { ReplyTabDto } from "@shared/api-contracts";
import { fakePhoneWidth } from "../helpers/fake-phone-width.js";
import { useClosedTabsStore } from "@/store/closed-tabs";

// The layout at once: how the side moves is split-row.test.tsx's.
beforeEach(() => { reducedMotion(); });

const at = "2026-09-27T00:00:00.000Z";
let view: Mounted | null = null;
let pathname = "";
let search = "";

afterEach(() => {
  // Unmount before the stores the thread page reads are reset under it.
  runCleanups();
  act(() => {
    useManagerThreadsStore.setState({ threads: new Map(), loaded: false });
    useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
    useProjectsStore.getState().setProjectsState([]);
    useWorkItemsStore.setState({ items: new Map() });
    useWorkerPlansStore.setState({ plans: new Map() });
    useWorkerPanelStore.setState({ byThread: {}, maximized: null, narrow: false, narrowView: "chat" });
    useCommandsStore.setState({ byScope: new Map(), noticeByScope: new Map() });
    useClosedTabsStore.setState({ byPanel: {} });
  });
});

const thread = managerThreadDto("thr_a", { title: "project-1 3.21 release", lastVisibleSeq: 1, seenSeq: 1 });

const project = clientProject("p1", {
  // w3 reported here once, and has since moved to another thread.
  workers: [clientWorker("w1"), clientWorker("w2"), { ...clientWorker("w3"), ownerThreadId: "thr_b" }]
});
const item = (workerId: string): WorkItemDto => ({
  id: `wi-${workerId}`, workerId, projectId: "p1", title: workerId,
  lastActivityAt: at, createdAt: at, updatedAt: at, failedAt: null, failedMessage: null, failedKind: null
});
const donePlan: WorkerPlanDto = {
  ...emptyPlan("w2"),
  steps: [{ id: 1, title: "Tag v3.21", status: "done", note: "pushed", createdAt: at, startedAt: at, blockedAt: null, completedAt: at, updatedAt: at }],
  updatedAt: at
};
/** w1 asks: a question in its plan, and no flag. */
const askingPlan: WorkerPlanDto = { ...emptyPlan("w1"), openQuestions: ["Keep the old flag as an alias?"], updatedAt: at };
const report = {
  id: "m1", threadId: "thr_a", seq: 1, role: "user", source: "worker-report", sourceThreadId: null, wakeId: null, createdAt: at,
  content: {
    type: "text", text: "[Worker report] w2 (w2, project project-1): done — Tagged.",
    metadata: workerReportMetadata({ workerId: "w2", workerName: "w2", projectId: "p1", projectName: "project-1", key: "done", line: "Tagged." })
  }
};

function Where() {
  const location = useLocation();
  pathname = location.pathname;
  search = location.search;
  return null;
}

/** Canvases the server has, by id; their document reads, in order. */
const canvasDocs = new Map<string, Record<string, unknown>>();
const canvasReads: string[] = [];
const canvasDoc = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, title, kind: "report", html: `<p>${title}</p>`, contentRevision: 1,
  scope: "manager", scopeId: null, projectId: null, projectName: null, projectSlug: null,
  workerId: null, workerName: null, workerSlug: null, threadId: "thr_a",
  createdAt: at, updatedAt: "2026-09-27T09:16:00.000Z", ...extra
});
afterEach(() => { canvasDocs.clear(); canvasReads.length = 0; resetCanvasTitles(); });

/** The replies the server keeps open in thr_a's panel. */
let replyTabsServed: ReplyTabDto[] = [];
/** The panel's reply list held unanswered (a page just loaded). */
let replyTabsHeld = false;
const replyTab = (id: string, messageId: string, text: string): ReplyTabDto => ({
  id, threadId: "thr_a", messageId, text, repliedAt: at, createdAt: at
});
afterEach(() => {
  replyTabsServed = [];
  replyTabsHeld = false;
  useReplyTabsStore.setState({ byThread: new Map(), latest: new Map(), applied: new Map() });
});

async function render(url = "/threads/thr_a", transcript: unknown[] = [report], projects: Project[] = [project]) {
  mockFetch(({ url, method, init }) => {
    if (/\/api\/agents\/threads\/thr_a\/reply-tabs$/.test(url)) {
      if (replyTabsHeld) return new Promise<Response>(() => {});
      if (method === "POST") {
        const { messageId, text } = JSON.parse(String(init?.body)) as { messageId: string; text: string };
        replyTabsServed = [...replyTabsServed, replyTab("rtab_new", messageId, text)];
      }
      return Response.json({ tabs: replyTabsServed });
    }
    const titles = /\/api\/canvases\/titles\?ids=([^&]*)/.exec(url);
    if (titles) {
      const ids = decodeURIComponent(titles[1]!).split(",");
      return Response.json({ canvases: ids.flatMap((id) => {
        const doc = canvasDocs.get(id);
        return doc ? [{ id, title: doc.title, kind: doc.kind }] : [];
      }) });
    }
    const doc = /\/api\/canvas\/([A-Za-z0-9_-]+)$/.exec(url);
    if (doc && method === "GET") {
      canvasReads.push(doc[1]!);
      const found = canvasDocs.get(doc[1]!);
      return found ? Response.json({ canvas: found }) : Response.json({ error: "canvas not found" }, { status: 404 });
    }
    if (url.endsWith("/commands")) {
      return method === "GET"
        ? Response.json({ commands: [{ name: "/compact", description: "Summarize earlier messages to free up context", blocked: { running: "A turn is running", compacting: "Already compacting" } }] })
        : Response.json({ taken: true, message: "Nothing to compact yet." });
    }
    if (method !== "GET") return Response.json({ thread });
    if (url.includes("/workers?archived=1")) return Response.json({ workers: [{ workerId: "old", name: "old-worker", projectId: "p1", projectName: "project-1", workerThreadId: "thr-old", archivedAt: at }] });
    // The thread's background tasks: none.
    if (url.endsWith("/tasks")) return Response.json({ tasks: [] });
    if (url.includes("/api/agents/threads/thr-old")) return Response.json({ thread: { id: "thr-old" }, messages: [], hasMore: false });
    if (url.includes("/api/agents/threads/thr_a")) return Response.json({ thread: { id: "thr_a" }, messages: transcript, hasMore: false });
    if (url.includes("/thread")) return Response.json({ thread: null, messages: [], hasMore: false });
    const workerCanvases = /\/api\/workers\/([^/]+)\/canvases$/.exec(url);
    if (workerCanvases) return Response.json({ canvases: [...canvasDocs.values()].filter((doc) => doc.workerId === workerCanvases[1]) });
    if (url.includes("/canvases")) return Response.json({ canvases: [] });
    if (url.includes("/plan")) return Response.json({ plan: url.includes("w2") ? donePlan : askingPlan });
    return Response.json({});
  });
  act(() => {
    useManagerThreadsStore.getState().replaceAll([thread]);
    useProjectsStore.getState().setProjectsState(projects);
    useWorkItemsStore.getState().upsert(item("w1"));
    useWorkerPlansStore.getState().upsert(askingPlan, "fetch");
    useWorkerPlansStore.getState().upsert(donePlan, "fetch");
  });
  view = await mountAsync(
    <MemoryRouter initialEntries={[url]}>
      <PaneHeaderSlotsProvider>
        <PaneHeader />
        <Routes><Route path="/threads/:threadId" element={<ThreadPage />} /><Route path="*" element={null} /></Routes>
        <Where />
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  await settle();
  return view.host;
}

const click = async (node: Element | null | undefined) => {
  expect(node == null).toBe(false);
  await act(async () => { (node as HTMLElement).click(); await new Promise((r) => setTimeout(r, 0)); });
};
const selectedWorkerTab = (el: HTMLElement) =>
  el.querySelector('[data-slot="worker-panel"] [role="tablist"]:not([aria-label]) [aria-selected="true"]')?.textContent;

test("the Workers tab groups this thread's workers by what they need", async () => {
  const el = await render();
  const panel = el.querySelector('[data-slot="worker-panel"]')!;
  // w1 asked and rests: it waits for an answer, which is its manager's first.
  expect(panel.querySelector('section[aria-label="Waiting for an answer"] [data-worker="w1"]') === null).toBe(false);
  expect(panel.querySelector('section[aria-label="Needs you"]') === null).toBe(true);
  // w2 finished its plan: one line under Done, not a card.
  expect(panel.querySelector('section[aria-label="Done"] [data-slot="done-worker"]')?.textContent).toContain("w2");
  expect(panel.querySelector('[data-worker="w2"]') === null).toBe(true);
  // A worker's name is a title people write, not an identifier: the body font.
  expect(panel.querySelector('[data-worker="w1"] span')!.className.split(/\s+/)).not.toContain("font-mono");
});

test("a worker waiting for an answer opens on Chat; a report card opens its worker on Plan", async () => {
  const el = await render();
  await click(el.querySelector('[data-worker="w1"]'));
  expect(el.querySelector('[data-worker-tab="w1"]')?.getAttribute("aria-selected")).toBe("true");
  expect(selectedWorkerTab(el)).toBe("Chat");
  const open = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Open in panel"));
  await click(open);
  expect(el.querySelector('[data-worker-tab="w2"]')?.getAttribute("aria-selected")).toBe("true");
  expect(selectedWorkerTab(el)).toBe("Plan");
  // Closing w1 leaves w2 where it is.
  await click(el.querySelector('[aria-label="Close w1"]'));
  expect(useWorkerPanelStore.getState().get("thr_a")).toMatchObject({ tabs: ["w2"], active: "w2" });
});

test("a report card from a worker the thread no longer owns still opens it", async () => {
  const moved = {
    ...report, id: "m2", seq: 2,
    content: { ...report.content, metadata: workerReportMetadata({ workerId: "w3", workerName: "w3", projectId: "p1", projectName: "project-1", key: "done", line: "Moved." }) }
  };
  const el = await render("/threads/thr_a", [report, moved]);
  const buttons = [...el.querySelectorAll("button")].filter((b) => b.textContent?.includes("Open in panel"));
  await click(buttons[1]);
  expect(el.querySelector('[data-worker-tab="w3"]')?.getAttribute("aria-selected")).toBe("true");
  // It is another thread's now: a note that points there, not its live chat.
  const panel = el.querySelector('[data-slot="worker-panel"]')!;
  expect(panel.textContent).toContain("belongs to another thread");
  expect(panel.querySelector("a")?.getAttribute("href")).toBe("/threads/thr_b?worker=w3");
  expect(panel.querySelector('textarea') === null).toBe(true);
});

test("opening a worker from a hidden panel brings the panel back", async () => {
  const el = await render();
  await click(hidePanel(el));
  expect(el.querySelector('[data-slot="worker-panel"]') === null).toBe(true);
  await click([...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Open in panel")));
  expect(el.querySelector('[data-worker-tab="w2"]')?.getAttribute("aria-selected")).toBe("true");
});

test("a maximized panel is this thread's only: leaving the thread restores the split", async () => {
  const el = await render();
  await click(el.querySelector('[aria-label="Maximize panel"]'));
  expect(useWorkerPanelStore.getState().maximized).toBe("panel");
  view!.unmount();
  expect(useWorkerPanelStore.getState().maximized).toBe(null);
});

test("the side a narrow row shows is this thread's only: leaving the thread goes back to the chat", async () => {
  const el = await renderAt(596);
  await click(workersToggle(el));
  expect(useWorkerPanelStore.getState().narrowView).toBe("panel");
  view!.unmount();
  expect(useWorkerPanelStore.getState().narrowView).toBe("chat");
});

test("?worker= is dropped once the projects arrive, even when there are none", async () => {
  await render("/threads/thr_a?worker=gone", [report], []);
  expect(pathname).toBe("/threads/thr_a");
  expect(search).toBe("");
});

test("an archived worker's tab remembers which of its tabs was open", async () => {
  const el = await render();
  await click(el.querySelector('[data-slot="worker-panel"] button[aria-expanded]'));
  await click(el.querySelector('section[aria-label="Archived"] button'));
  const tabIn = (name: string) => [...el.querySelectorAll<HTMLElement>('[data-slot="worker-panel"] [role="tab"]')].find((t) => t.textContent === name);
  await click(tabIn("Chat"));
  // Away to the Workers tab and back: still on its chat.
  await click(el.querySelector('[data-slot="worker-panel"] [role="tablist"][aria-label="Worker tabs"] [role="tab"]'));
  await click(el.querySelector('[data-worker-tab="archived:old"]'));
  expect(tabIn("Chat")?.getAttribute("aria-selected")).toBe("true");
  expect(useWorkerPanelStore.getState().get("thr_a").workerTab["archived:old"]).toBe("chat");
});

test("the header's Panel toggle hides the panel, remembered for the thread", async () => {
  const el = await render();
  await click(hidePanel(el));
  expect(el.querySelector('[data-slot="worker-panel"]') === null).toBe(true);
  expect(useWorkerPanelStore.getState().get("thr_a").open).toBe(false);
});

test("?worker= opens that worker's tab and leaves the URL", async () => {
  const el = await render("/threads/thr_a?worker=w2");
  expect(el.querySelector('[data-worker-tab="w2"]')?.getAttribute("aria-selected")).toBe("true");
  expect(el.querySelector('[data-worker-tab="w2"] span')!.className.split(/\s+/)).not.toContain("font-mono");
  expect(pathname).toBe("/threads/thr_a");
  expect(search).toBe("");
});

// A worker's name gets up to 224px in its tab: at 128px a 600px pane cut a
// name of a dozen characters short with room to spare. Less only when the tabs outgrow the row and share it
// (e2e/worker-tab-in-sight); the whole name is then the name's tooltip.
test("a worker tab's name has 224px before it truncates, and says the whole of itself on hover", async () => {
  const el = await render("/threads/thr_a?worker=w2");
  const name = el.querySelector('[data-worker-tab="w2"] span[title]')!;
  expect(name.className.split(/\s+/)).toContain("max-w-56");
  expect(name.className.split(/\s+/)).toContain("truncate");
  expect(name.getAttribute("title")).toBe("w2");
});

test("?worker= before the worker's status has arrived opens on the tab that status asks for", async () => {
  // w2's work item is not in yet (a cold load: the projects came first).
  const el = await render("/threads/thr_a?worker=w2");
  expect(el.querySelector('[data-worker-tab="w2"]')?.getAttribute("aria-selected")).toBe("true");
  // Its last turn failed: its Chat, not the Plan guessed without it.
  await act(async () => { useWorkItemsStore.getState().upsert({ ...item("w2"), failedAt: at, failedMessage: "provider returned 500", failedKind: "error" }); await new Promise((r) => setTimeout(r, 0)); });
  expect(selectedWorkerTab(el)).toBe("Chat");
});

test("an archived worker's tab outlives the panel that opened it", async () => {
  const el = await render();
  await click(el.querySelector('[data-slot="worker-panel"] button[aria-expanded]'));
  await click(el.querySelector('section[aria-label="Archived"] button'));
  // Hidden and shown again: the panel is a new one.
  await click(hidePanel(el));
  await click(workersToggle(el));
  expect(el.querySelector('[data-worker-tab="archived:old"]')?.getAttribute("aria-selected")).toBe("true");
  expect(el.querySelector('[data-slot="worker-panel"]')?.textContent).not.toContain("Reopen it from Archived");
  const tabs = [...el.querySelectorAll('[data-slot="worker-panel"] [role="tab"]')].map((t) => t.textContent);
  expect(tabs).toContain("Plan");
  // Reports and designs share the one tab.
  expect(tabs).toContain("Canvases");
});

test("an archived worker's tab keeps its name when the panel comes back", async () => {
  const el = await render();
  await click(el.querySelector('[data-slot="worker-panel"] button[aria-expanded]'));
  // Offline once the list is in: the name comes with the tab, not from another lookup.
  mockFetch(() => new Promise<Response>(() => {}));
  await click(el.querySelector('section[aria-label="Archived"] button'));
  await click(hidePanel(el));
  await click(workersToggle(el));
  expect(el.querySelector('[data-worker-tab="archived:old"]')?.textContent).toContain("old-worker");
});

test("switching to an archived tab whose details are still loading never shows the previous one", async () => {
  // Tabs remembered from before this page loaded, their details not in hand;
  // the first is no longer in the thread's archived list.
  act(() => useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: ["archived:missing", "archived:gone"], active: "archived:missing", workerTab: {} } } }));
  const el = await render();
  const panel = () => el.querySelector('[data-slot="worker-panel"]')!;
  expect(panel().querySelector('[data-slot="state-message"] h2')?.textContent).toBe("Worker not found");
  // The next lookup never answers.
  mockFetch(() => new Promise<Response>(() => {}));
  await click(el.querySelector('[data-worker-tab="archived:gone"]'));
  expect(panel().textContent).toContain("Loading…");
  expect(panel().textContent).not.toContain("not found");
});

test("a worker no longer in the thread's archive says so, and its tab can be closed from there", async () => {
  act(() => useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: ["archived:missing"], active: "archived:missing", workerTab: {} } } }));
  const el = await render();
  const panel = () => el.querySelector('[data-slot="worker-panel"]')!;
  expect(panel().textContent).toContain("It's no longer in this thread's archive.");
  await click([...panel().querySelectorAll('[data-slot="state-message"] button')].find((b) => b.textContent === "Close tab"));
  expect(useWorkerPanelStore.getState().get("thr_a").tabs).toEqual([]);
});

test("an archived tab whose lookup failed says so and can retry — it does not call the worker gone", async () => {
  const el = await render();
  const panel = () => el.querySelector('[data-slot="worker-panel"]')!;
  await withFetch(() => { throw new TypeError("Failed to fetch"); }, async () => {
    await act(async () => {
      useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: ["archived:old"], active: "archived:old", workerTab: {} } } });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(panel().querySelector('[data-slot="state-message"] h2')?.textContent).toBe("Couldn't load this worker");
    expect(panel().textContent).toContain("Failed to fetch");
    expect(panel().textContent).not.toContain("not found");
  });
  await click([...panel().querySelectorAll("button")].find((b) => b.textContent === "Retry"));
  expect(el.querySelector('[data-worker-tab="archived:old"]')?.textContent).toContain("old-worker");
});

test("an archived tab whose lookup answered with an error does not call the worker gone", async () => {
  const el = await render();
  mockFetch(() => Response.json({ error: "internal" }, { status: 500 }));
  await act(async () => {
    useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: ["archived:old"], active: "archived:old", workerTab: {} } } });
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(el.querySelector('[data-slot="worker-panel"] [data-slot="state-message"] h2')?.textContent).toBe("Couldn't load this worker");
});

test("a worker's tab in the panel has the worker's menu: archiving there closes the tab and stays in the thread", async () => {
  const el = await render("/threads/thr_a?worker=w1");
  const calls: string[] = [];
  const base = globalThis.fetch;
  mockFetch(({ url, method, init }) => {
    calls.push(`${method} ${url}`);
    if (url.includes("/archive-check")) return Response.json({ dirtyFiles: 0, unmergedCommits: null, branch: null, baseRef: null, findings: [] });
    if (method === "DELETE") return Response.json({ ok: true });
    return base(url, init);
  });
  const panel = () => el.querySelector('[data-slot="worker-panel"]')!;
  const trigger = panel().querySelector<HTMLElement>('[aria-label="Worker actions"]');
  expect(trigger === null).toBe(false);
  await act(async () => {
    trigger!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  // The worker has no page of its own: the panel is where it opens.
  expect(items.map((i) => i.textContent)).not.toContain("Open worker page");
  await act(async () => { items.find((i) => i.textContent === "Archive worker")!.click(); await new Promise((r) => setTimeout(r, 0)); });
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === "Archive")!;
  await act(async () => { confirm.click(); await new Promise((r) => setTimeout(r, 0)); });
  expect(calls.some((c) => c.startsWith("DELETE /api/workers/w1"))).toBe(true);
  expect(pathname).toBe("/threads/thr_a");
  expect(el.querySelector('[data-worker-tab="w1"]') === null).toBe(true);
});

const workersToggle = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-slot="panel-toggle"]')!;
/** Hiding the panel is the header's Panel toggle: its row has no button for it. */
const hidePanel = workersToggle;
const toggleSays = (el: HTMLElement) => [workersToggle(el).textContent, workersToggle(el).getAttribute("aria-label"), workersToggle(el).getAttribute("title"), workersToggle(el).getAttribute("aria-pressed")];

// The panel holds reports and canvases beside the workers: the header says
// Panel, and the panel's own Workers tab carries the count. The header's
// Panel is there with the panel open or hidden, one button for both ways,
// lit while the panel is open. The panel's row has no hide button of its own.
test("the header's Panel button hides an open panel and shows a hidden one, lit while it is open, and counts nothing", async () => {
  const el = await render();
  expect(toggleSays(el)).toEqual(["Panel", "Hide panel", "Hide panel", "true"]);
  expect(el.querySelector('[data-slot="worker-panel"] button[aria-label="Hide panel"]') === null).toBe(true);
  await click(workersToggle(el));
  expect(el.querySelector('[data-slot="worker-panel"]') === null).toBe(true);
  expect(toggleSays(el)).toEqual(["Panel", "Show panel", "Show panel", "false"]);
  await click(workersToggle(el));
  expect(el.querySelector('[data-slot="worker-panel"]') === null).toBe(false);
  expect(toggleSays(el)).toEqual(["Panel", "Hide panel", "Hide panel", "true"]);
});

// Nothing floats over the transcript: the header's Workers
// toggle gives the chat the whole row, and the panel keeps its own maximize.
test("the chat column carries no control of its own; hiding the workers gives it the row", async () => {
  const el = await render();
  expect(el.querySelector('[data-slot="thread-chat"] [data-pane-zoom]') === null).toBe(true);
  expect(el.querySelector('[aria-label="Maximize chat"]') === null).toBe(true);
  await click(hidePanel(el));
  expect(el.querySelector('[data-slot="worker-panel"]') === null).toBe(true);
});

// The header is the chat's when both sides share the row: over the chat's
// column, with the panel's tabs in the band over the panel. A narrow
// row, one side at a time, keeps the window's band with the toggle in it.
test("with both sides in the row the header is the chat pane's, over its column, and the panel's tabs take the band beside it", async () => {
  const el = await render();
  const headers = el.querySelectorAll('[data-slot="pane-header"]');
  expect(headers.length).toBe(1);
  expect(headers[0]!.closest('[data-slot="thread-chat"]') !== null).toBe(true);
  expect(headers[0]!.querySelector('[data-slot="pane-header-row"]')?.textContent).toContain("project-1 3.21 release");
  const tabRow = el.querySelector('[data-slot="worker-panel"] [role="tablist"]')!.parentElement!;
  expect([tabRow.className.split(/\s+/).includes("h-13"), tabRow.hasAttribute("data-tauri-drag-region")]).toEqual([true, true]);
  runCleanups();
  const narrow = await renderAt(596);
  const band = narrow.querySelectorAll('[data-slot="pane-header"]');
  expect(band.length).toBe(1);
  expect(band[0]!.closest('[data-slot="thread-chat"]') === null).toBe(true);
  expect(band[0]!.querySelector('[data-slot="panel-toggle"]') !== null).toBe(true);
});

// With the row to itself the panel hides the chat, and the chat's header with
// it: the window's band comes back, so the title and actions stay in reach.
test("a maximized panel brings back the window's header, with the thread's title and actions", async () => {
  const el = await render();
  await click(el.querySelector('[aria-label="Maximize panel"]'));
  const headers = el.querySelectorAll('[data-slot="pane-header"]');
  expect(headers.length).toBe(1);
  expect(headers[0]!.closest('[data-slot="thread-chat"]') === null).toBe(true);
  expect(headers[0]!.textContent).toContain("project-1 3.21 release");
  expect(headers[0]!.querySelector('[aria-label="Thread actions"], [aria-haspopup="menu"]') !== null).toBe(true);
});

test("the context meter stays out of the header until a call has measured it", async () => {
  const el = await render();
  const header = el.querySelector('[data-slot="pane-header"]')!;
  const meter = () => header.querySelector('[aria-label^="Last successful agent call used"]');
  expect(meter() === null).toBe(true);
  expect(header.textContent).not.toContain("--");
  act(() => useAgentChatStore.setState((s) => {
    const threadsByScope = new Map(s.threadsByScope);
    const entry = threadsByScope.get("manager:thr_a")!;
    threadsByScope.set("manager:thr_a", { ...entry, contextUsage: { inputTokens: 34_000, budgetTokens: 100_000, updatedAt: at } });
    return { threadsByScope };
  }));
  expect(header.textContent).toContain("34%");
  expect(meter() === null).toBe(false);
});

// Why a worker waits is named as every other surface names it, once: by the
// group its row sits in, which the row no longer repeats.
test("a worker's row in the Workers tab sits under why it waits, as every other surface names it", async () => {
  const el = await render();
  act(() => useWorkItemsStore.getState().upsert({ ...item("w2"), failedAt: at, failedMessage: "provider returned 500", failedKind: "error" }));
  const row = (name: string) => el.querySelector<HTMLElement>(`[data-slot="worker-panel"] [data-worker="${name}"]`)!;
  const group = (name: string) => row(name).closest("section")!;
  expect(group("w2").getAttribute("aria-label")).toBe("Failed");
  expect(group("w2").querySelector("h3")!.textContent).toBe("Failed");
  expect(group("w1").querySelector("h3")!.textContent).toBe("Waiting for an answer");
  expect(row("w2").querySelector('[data-slot="worker-state"]') === null).toBe(true);
  expect(row("w1").querySelector('[data-slot="worker-state"]') === null).toBe(true);
});

// A narrow row: below 720px an even split leaves each side under
// 360px, so the row shows one side at a time — the chat, until the Workers
// toggle or an opened worker brings the panel in. happy-dom lays nothing out:
// the row is told its width, and told again when it "resizes".
let rowWidth = 0;
let resizeRow: (width: number) => Promise<void> = async () => {};
async function renderAt(width: number, url?: string, transcript?: unknown[]) {
  rowWidth = width;
  const proto = window.HTMLElement.prototype;
  // Element's, not HTMLElement's: the own property set here is deleted
  // afterwards, not left to hide a later stub on Element.
  const rect = Object.getOwnPropertyDescriptor(proto, "getBoundingClientRect");
  const Observer = globalThis.ResizeObserver;
  const callbacks = new Set<() => void>();
  Object.defineProperty(proto, "getBoundingClientRect", {
    configurable: true, writable: true,
    value: () => ({ x: 0, y: 0, left: 0, top: 0, width: rowWidth, height: 600, right: rowWidth, bottom: 600, toJSON: () => ({}) }) as DOMRect
  });
  globalThis.ResizeObserver = class {
    #callback: () => void;
    constructor(callback: () => void) { this.#callback = callback; }
    observe() { callbacks.add(this.#callback); }
    unobserve() { callbacks.delete(this.#callback); }
    disconnect() { callbacks.delete(this.#callback); }
  } as unknown as typeof ResizeObserver;
  onCleanup(() => {
    if (rect) Object.defineProperty(proto, "getBoundingClientRect", rect);
    else delete (proto as unknown as Record<string, unknown>).getBoundingClientRect;
    globalThis.ResizeObserver = Observer;
  });
  resizeRow = async (next) => {
    rowWidth = next;
    await act(async () => { for (const callback of callbacks) callback(); });
  };
  return render(url, transcript);
}
const chatShown = (el: HTMLElement) => !el.querySelector('[data-slot="thread-chat"]')!.className.split(/\s+/).includes("hidden");
const panelShown = (el: HTMLElement) => el.querySelector('[data-slot="worker-panel"]') !== null;
const panelClasses = (el: HTMLElement) => el.querySelector('[data-slot="worker-panel"]')!.className.split(/\s+/);
const panelHasRow = (el: HTMLElement) => panelClasses(el).includes("flex-1");

test("a narrow row shows the chat alone; the Workers toggle swaps in the panel, and back", async () => {
  const el = await renderAt(596);
  expect([chatShown(el), panelShown(el)]).toEqual([true, false]);
  // Out of sight, so the toggle offers it and counts what it lists.
  expect(workersToggle(el).getAttribute("aria-label")).toBe("Show panel");
  expect(workersToggle(el).getAttribute("aria-pressed")).toBe("false");
  expect(workersToggle(el).textContent).toBe("Panel");
  await click(workersToggle(el));
  expect([chatShown(el), panelShown(el), panelHasRow(el)]).toEqual([false, true, true]);
  expect(workersToggle(el).getAttribute("aria-label")).toBe("Hide panel");
  expect(workersToggle(el).getAttribute("aria-pressed")).toBe("true");
  // The panel already has the row: no maximize, nothing to drag, no chat to
  // draw a divider against.
  expect(el.querySelector('[data-slot="worker-panel"] [data-pane-zoom]') === null).toBe(true);
  expect(panelClasses(el)).not.toContain("border-l");
  expect(el.querySelector('[aria-label="Resize worker panel"]') === null).toBe(true);
  await click(workersToggle(el));
  expect([chatShown(el), panelShown(el)]).toEqual([true, false]);
  // Back to the chat is not hiding the panel: a wide row still has it.
  expect(useWorkerPanelStore.getState().get("thr_a").open).toBe(true);
});

test("in a narrow row, opening a worker from the chat switches to the panel on its tab", async () => {
  const el = await renderAt(596);
  await click([...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Open in panel")));
  expect([chatShown(el), panelShown(el)]).toEqual([false, true]);
  expect(el.querySelector('[data-worker-tab="w2"]')?.getAttribute("aria-selected")).toBe("true");
});

test("?worker= in a narrow row opens on the panel", async () => {
  const el = await renderAt(596, "/threads/thr_a?worker=w2");
  expect([chatShown(el), panelShown(el)]).toEqual([false, true]);
  expect(el.querySelector('[data-worker-tab="w2"]')?.getAttribute("aria-selected")).toBe("true");
});

test("a narrow row's shortcut swaps between the chat and the panel", async () => {
  const el = await renderAt(596);
  const shortcut = () => act(() => { window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, metaKey: true })); });
  shortcut();
  expect([chatShown(el), panelShown(el)]).toEqual([false, true]);
  shortcut();
  expect([chatShown(el), panelShown(el)]).toEqual([true, false]);
});

test("a narrow row's shortcut brings in a panel hidden while the row was wide, as the toggle does", async () => {
  act(() => useWorkerPanelStore.getState().setOpen("thr_a", false));
  const el = await renderAt(596);
  expect(workersToggle(el).getAttribute("aria-label")).toBe("Show panel");
  act(() => { window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, ctrlKey: true })); });
  expect([chatShown(el), panelShown(el)]).toEqual([false, true]);
  expect(useWorkerPanelStore.getState().get("thr_a").open).toBe(true);
});

test("a row that narrows keeps in sight what was: the chat, or the panel that had the row", async () => {
  const el = await renderAt(1000);
  expect([chatShown(el), panelShown(el)]).toEqual([true, true]);
  // A worker opened while the row was wide is in its panel already; narrowing
  // shows the chat, as a narrow row does by default.
  await click([...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Open in panel")));
  await resizeRow(596);
  expect([chatShown(el), panelShown(el)]).toEqual([true, false]);
  await resizeRow(1000);
  await click(el.querySelector('[aria-label="Maximize panel"]'));
  await resizeRow(596);
  expect([chatShown(el), panelShown(el)]).toEqual([false, true]);
});

for (const back of ["Esc", "the toggle"] as const) {
  test(`a panel maximized before the row narrowed, sent back to the chat with ${back}, leaves both sides for a wider row`, async () => {
    const el = await renderAt(1000);
    await click(el.querySelector('[aria-label="Maximize panel"]'));
    await resizeRow(596);
    expect([chatShown(el), panelShown(el)]).toEqual([false, true]);
    if (back === "Esc") act(() => { window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" })); });
    else await click(workersToggle(el));
    expect([chatShown(el), panelShown(el)]).toEqual([true, false]);
    await resizeRow(1000);
    expect([chatShown(el), panelShown(el), panelHasRow(el)]).toEqual([true, true, false]);
  });
}

test("a row as wide as the split's minimum still shows both sides", async () => {
  const el = await renderAt(720);
  expect([chatShown(el), panelShown(el), panelHasRow(el)]).toEqual([true, true, false]);
  expect(panelClasses(el)).toContain("border-l");
  await resizeRow(719);
  expect([chatShown(el), panelShown(el)]).toEqual([true, false]);
});

/** happy-dom lays nothing out: until the test ends, the row of worker tabs is
 *  400px wide with 8px of padding, and every tab in it 200px, 2px apart (the
 *  row's sliding mark lies over them and takes no room). */
function layOutTabRow() {
  const proto = window.HTMLElement.prototype;
  const saved = ["scrollWidth", "clientWidth", "offsetLeft", "offsetWidth"].map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const);
  const isRow = (el: Element | null) => el?.getAttribute("aria-label") === "Worker tabs";
  const tabs = (row: Element) => [...row.children].filter((child) => child.getAttribute("role") === "tab");
  const place = (el: HTMLElement) => tabs(el.parentElement!).indexOf(el);
  Object.defineProperty(proto, "clientWidth", { configurable: true, get(this: HTMLElement) { return isRow(this) ? 400 : 0; } });
  Object.defineProperty(proto, "scrollWidth", { configurable: true, get(this: HTMLElement) { return isRow(this) ? 16 + tabs(this).length * 202 - 2 : 0; } });
  Object.defineProperty(proto, "offsetLeft", { configurable: true, get(this: HTMLElement) { return isRow(this.parentElement) ? 8 + place(this) * 202 : 0; } });
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get(this: HTMLElement) { return isRow(this.parentElement) ? 200 : 0; } });
  onCleanup(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(proto, key, descriptor);
      else delete (proto as unknown as Record<string, unknown>)[key];
    }
  });
}
const tabRow = (el: HTMLElement) => el.querySelector<HTMLElement>('[role="tablist"][aria-label="Worker tabs"]')!;
const tabOf = (el: HTMLElement, id: string) => tabRow(el).querySelector<HTMLElement>(`[data-worker-tab="${id}"]`);

// The row of worker tabs scrolls once its tabs are at their narrowest and
// still outgrow the panel: with no bar, a fade on the side that has more,
// and the open tab clear of that fade (a worker opened from the chat used to
// land past the row's edge, its Close out of reach). The same row as
// the pill tabs', so only the row ever scrolls.
test("the tab that opens is scrolled clear of the row's fade, and only as far as that takes", async () => {
  layOutTabRow();
  act(() => useWorkerPanelStore.getState().openWorker("thr_a", "w1"));
  const el = await render("/threads/thr_a?worker=w2");
  const row = tabRow(el);
  expect(row.className.split(/\s+/)).toContain("scroll-x-edges");
  // Workers 8–208, w1 210–410, w2 412–612 of 620: w2 takes the row to its end.
  expect(tabOf(el, "w2")?.getAttribute("aria-selected")).toBe("true");
  expect(row.scrollLeft).toBe(220);
  expect(row.getAttribute("data-more")).toBe("left");
  // w1 is cut on the left now: it comes 24px inside that edge and no further.
  await click(tabOf(el, "w1"));
  expect(row.scrollLeft).toBe(210 - 24);
  expect(row.getAttribute("data-more")).toBe("both");
});

test("the Workers tab comes back into sight when it takes over from a closed tab, and a row that fits fades nowhere", async () => {
  layOutTabRow();
  const el = await render("/threads/thr_a?worker=w2");
  const row = tabRow(el);
  expect(row.scrollLeft).toBe(18);
  await click(el.querySelector('[aria-label="Close w2"]'));
  expect(row.querySelector('[aria-selected="true"]')?.textContent).toBe(`Workers${2}`);
  expect(row.scrollLeft).toBe(0);
  expect(row.getAttribute("data-more")).toBe(null);
});

// After a reload the tabs are drawn from what the browser remembered, before
// the projects that name them: the names then widen the row under the open tab.
test("names that arrive after the tabs keep the open one in sight", async () => {
  layOutTabRow();
  act(() => useWorkerPanelStore.getState().openWorker("thr_a", "w2"));
  const el = await render("/threads/thr_a", [report], []);
  const row = tabRow(el);
  expect(tabOf(el, "w2")!.textContent).toBe("Worker");
  // As the wider names leave it: the open tab's end past the row's edge.
  row.scrollLeft = 0;
  await act(async () => { useProjectsStore.getState().setProjectsState([project]); await new Promise((r) => setTimeout(r, 0)); });
  expect(tabOf(el, "w2")!.textContent).toBe("w2");
  expect(row.scrollLeft).toBe(18);
});

test("a tab that stays open moves nothing: the row is the reader's to scroll", async () => {
  layOutTabRow();
  const el = await render("/threads/thr_a?worker=w2");
  const row = tabRow(el);
  expect(row.scrollLeft).toBe(18);
  // The reader scrolls back to the Workers tab; then another worker's status
  // changes, the open tab and every name as they were.
  row.scrollLeft = 0;
  await act(async () => { useWorkItemsStore.getState().upsert({ ...item("w1"), failedAt: at, failedMessage: "boom", failedKind: "error" }); await new Promise((r) => setTimeout(r, 0)); });
  expect(tabOf(el, "w2")?.getAttribute("aria-selected")).toBe("true");
  expect(row.scrollLeft).toBe(0);
});

test("a tab's Close reached by keyboard brings its whole tab clear of the fade", async () => {
  layOutTabRow();
  act(() => useWorkerPanelStore.getState().openWorker("thr_a", "w1"));
  const el = await render("/threads/thr_a?worker=w2");
  const row = tabRow(el);
  expect(row.scrollLeft).toBe(220);
  const close = el.querySelector<HTMLElement>('[aria-label="Close w1"]')!;
  // happy-dom has no input modality: stand in for a keyboard focus.
  const realMatches = close.matches.bind(close);
  (close as unknown as { matches: (selector: string) => boolean }).matches = (selector) => (selector === ":focus-visible" ? true : realMatches(selector));
  await act(async () => { close.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true })); });
  // w1's tab (210–410), not Close's own place inside it.
  expect(row.scrollLeft).toBe(210 - 24);
});

test("a worker's menu in the panel compacts that worker's conversation", async () => {
  const posted: string[] = [];
  const el = await render("/threads/thr_a?worker=w2");
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/commands") && init?.method === "POST") posted.push(`${String(input)} ${String(init.body)}`);
    return realFetch(input, init);
  }) as typeof fetch;
  onCleanup(() => { globalThis.fetch = realFetch; });

  const trigger = el.querySelector<HTMLElement>('[data-slot="worker-panel"] [aria-label="Worker actions"]')!;
  await act(async () => {
    trigger.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const labels = items.map((n) => n.textContent);
  expect(labels).toContain("Compact now");
  // After Refresh panes, before what leaves the worker.
  expect(labels.indexOf("Compact now")).toBe(labels.indexOf("Refresh panes") + 1);
  await act(async () => { items[labels.indexOf("Compact now")]!.click(); await new Promise((r) => setTimeout(r, 0)); });
  await settle();
  expect(posted).toStrictEqual(['/api/agents/workers/w2/commands {"text":"/compact","attachments":0}']);
});

test("from a worker's Plan tab, Compact now says the compaction has started: nothing on that tab would", async () => {
  const shown: string[] = [];
  const original = toast.message;
  toast.message = ((message: unknown) => { shown.push(String(message)); return 0; }) as typeof toast.message;
  onCleanup(() => { toast.message = original; });
  const el = await render("/threads/thr_a?worker=w2");
  // The server takes the command and answers nothing: the compaction is on its way.
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    String(input).endsWith("/commands") && init?.method === "POST"
      ? Promise.resolve(Response.json({ taken: true, message: null }))
      : realFetch(input, init)) as typeof fetch;
  onCleanup(() => { globalThis.fetch = realFetch; });

  const panel = el.querySelector<HTMLElement>('[data-slot="worker-panel"]')!;
  await click([...panel.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent === "Plan"));
  // The worker's chat, whose working line would say it, is not on screen.
  expect(panel.querySelector("textarea") === null).toBe(true);
  const trigger = panel.querySelector<HTMLElement>('[aria-label="Worker actions"]')!;
  await act(async () => {
    trigger.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  await click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Compact now"));
  await settle();
  expect(shown).toStrictEqual(["Compacting context…"]);
});

// The panel's store alone: which workers are open in each thread.
describe("store", () => {
  beforeEach(() => useWorkerPanelStore.setState({ byThread: {}, maximized: null }));

  test("openWorker adds a tab once, makes it active, remembers its tab; per thread", () => {
    const s = useWorkerPanelStore.getState();
    s.openWorker("A", "f1", "chat");
    s.openWorker("A", "f2");
    s.openWorker("A", "f1");
    expect(useWorkerPanelStore.getState().get("A")).toMatchObject({ open: true, tabs: ["f1", "f2"], active: "f1", workerTab: { f1: "chat" } });
    expect(useWorkerPanelStore.getState().get("B")).toEqual({ open: true, tabs: [], active: "workers", workerTab: {} });
  });

  test("hiding is per thread; opening a worker shows the panel again", () => {
    const s = useWorkerPanelStore.getState();
    s.setOpen("A", false);
    expect(useWorkerPanelStore.getState().get("A").open).toBe(false);
    s.openWorker("A", "f1");
    expect(useWorkerPanelStore.getState().get("A").open).toBe(true);
  });
});

// ---- Reports and canvases as tabs beside the chat ----

const R = "cnv_RelNotes001";
const D = "cnv_DrillRep002";
const P = "cnv_PlanDoc0003";
const linkTo = (id: string, text: string, seq = 2) => ({
  id: `m-${id}`, threadId: "thr_a", seq, role: "assistant", source: "self", sourceThreadId: null, wakeId: "wk", createdAt: at,
  content: { type: "assistant", text }
});
const canvasTab = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-slot="worker-panel"] [data-canvas-tab="${id}"]`);
const chatLink = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-slot="thread-chat"] a[href="/canvas/${id}"]`);
const pointerDown = (node: Element) => node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
const menuItem = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim() === name);
const openTabMenu = async (el: HTMLElement) => {
  await act(async () => { pointerDown(el.querySelector('[data-slot="canvas-tab-bar"]:not(.hidden *) button[aria-label="Canvas menu"]')!); });
};

test("a canvas link in the chat opens the canvas as a tab beside it, once", async () => {
  canvasDocs.set(R, canvasDoc(R, "Release report"));
  const el = await render("/threads/thr_a", [report, linkTo(R, `The write-up: [the release report](/canvas/${R}).`)]);
  await click(chatLink(el, R));
  await settle();
  await click(chatLink(el, R));
  await settle();
  expect(el.querySelectorAll(`[data-canvas-tab="${R}"]`)).toHaveLength(1);
  expect(canvasTab(el, R)!.getAttribute("aria-selected")).toBe("true");
  expect(canvasTab(el, R)!.textContent).toContain("Release report");
  // The canvas view is loaded when first shown: wait for its bar, not a fixed time.
  await settleUntil(() => el.querySelector('[data-slot="canvas-tab-bar"]')?.textContent?.includes("Release report") ?? false, "the canvas tab's bar");
  expect(el.querySelector('[data-slot="canvas-tab-bar"]')!.textContent).toContain("Release report");
  expect(pathname).toBe("/threads/thr_a");
  expect(document.querySelector('[aria-label="Canvas"][role="dialog"]') === null).toBe(true);
});

// A canvas republished under a new name: its tab is named as its bar is,
// not as it was first read.
test("a canvas renamed while its tab is open: the tab takes the new name", async () => {
  canvasDocs.set(R, canvasDoc(R, "Release report"));
  const el = await render("/threads/thr_a", [report, linkTo(R, `See [it](/canvas/${R}).`)]);
  await click(chatLink(el, R));
  await settle();
  expect(canvasTab(el, R)!.textContent).toContain("Release report");
  canvasDocs.set(R, canvasDoc(R, "Release notes v2", { contentRevision: 2 }));
  act(() => { window.dispatchEvent(new CustomEvent("mandate:canvas-updated", { detail: { canvasId: R, workerId: null } })); });
  await settle();
  // The canvas view is loaded when first shown: wait for its bar, not a fixed time.
  await settleUntil(() => el.querySelector('[data-slot="canvas-tab-bar"]')?.textContent?.includes("Release notes v2") ?? false, "the canvas tab's bar");
  expect(el.querySelector('[data-slot="canvas-tab-bar"]')!.textContent).toContain("Release notes v2");
  expect(canvasTab(el, R)!.textContent).toContain("Release notes v2");
});

test("a canvas opened while the panel is hidden brings the panel back", async () => {
  canvasDocs.set(R, canvasDoc(R, "Release report"));
  const el = await render("/threads/thr_a", [report, linkTo(R, `See [it](/canvas/${R}).`)]);
  await click(hidePanel(el));
  expect(el.querySelector('[data-slot="worker-panel"]') === null).toBe(true);
  await click(chatLink(el, R));
  await settle();
  expect(canvasTab(el, R)?.getAttribute("aria-selected")).toBe("true");
});

test("in a narrow row, a canvas opened from the chat switches to the panel on its tab", async () => {
  canvasDocs.set(R, canvasDoc(R, "Release report"));
  const el = await renderAt(596, undefined, [report, linkTo(R, `See [it](/canvas/${R}).`)]);
  await click(chatLink(el, R));
  await settle();
  expect([chatShown(el), panelShown(el)]).toEqual([false, true]);
  expect(canvasTab(el, R)?.getAttribute("aria-selected")).toBe("true");
});

// A worker's own canvases list, in its tab in the panel: the canvas opens in
// the same panel, not over the window.
test("a canvas in a worker's Canvases list in the panel opens as a tab in the same panel", async () => {
  canvasDocs.set(D, canvasDoc(D, "Drill report", { scope: "worker", scopeId: "w1", workerId: "w1", workerName: "w1" }));
  const el = await render();
  act(() => { useWorkerPanelStore.getState().openWorker("thr_a", "w1", "canvases"); });
  await settle();
  const row = el.querySelector<HTMLElement>(`[data-slot="worker-panel"] [data-slot="canvas-row"] button[aria-label="Open report: Drill report"]`);
  await click(row);
  await settle();
  expect(canvasTab(el, D)?.getAttribute("aria-selected")).toBe("true");
  expect(pathname).toBe("/threads/thr_a");
});

test("closing a canvas tab from its menu opens its left neighbour", async () => {
  canvasDocs.set(R, canvasDoc(R, "Release report"));
  const el = await render();
  act(() => {
    useWorkerPanelStore.getState().openWorker("thr_a", "w1");
    useWorkerPanelStore.getState().openCanvas("thr_a", R);
  });
  await settle();
  await openTabMenu(el);
  await act(async () => { menuItem("Close tab")!.click(); });
  await settle();
  expect(canvasTab(el, R) === null).toBe(true);
  expect(el.querySelector('[data-worker-tab="w1"]')?.getAttribute("aria-selected")).toBe("true");
});

test("a canvas opened from a worker's tab closes back to it, not to the worker on its left", async () => {
  canvasDocs.set(R, canvasDoc(R, "Release report"));
  const el = await render();
  act(() => {
    useWorkerPanelStore.getState().openWorker("thr_a", "w1");
    useWorkerPanelStore.getState().openWorker("thr_a", "w2");
    useWorkerPanelStore.getState().setActive("thr_a", "w1");
    useWorkerPanelStore.getState().openCanvas("thr_a", R);
  });
  await settle();
  await act(async () => { canvasTab(el, R)!.querySelector<HTMLElement>('[aria-label^="Close"]')!.click(); });
  await settle();
  expect(canvasTab(el, R) === null).toBe(true);
  expect(el.querySelector('[data-worker-tab="w1"]')?.getAttribute("aria-selected")).toBe("true");
});

test("a canvas deleted elsewhere says so in its tab, which Close tab closes", async () => {
  canvasDocs.set(R, canvasDoc(R, "Release report"));
  const el = await render();
  act(() => { useWorkerPanelStore.getState().openCanvas("thr_a", R); });
  await settle();
  // The canvas view is loaded when first shown: wait for its bar, not a fixed time.
  await settleUntil(() => el.querySelector('[data-slot="canvas-tab-bar"]')?.textContent?.includes("Release report") ?? false, "the canvas tab's bar");
  expect(el.querySelector('[data-slot="canvas-tab-bar"]')!.textContent).toContain("Release report");
  canvasDocs.delete(R);
  act(() => { window.dispatchEvent(new CustomEvent("mandate:canvas-updated", { detail: { canvasId: R, workerId: null } })); });
  await settle();
  await settle();
  const state = el.querySelector<HTMLElement>('[data-slot="worker-panel"] [data-slot="state-message"]')!;
  expect(state.querySelector("h2")!.textContent).toBe("Canvas not found");
  await click([...state.querySelectorAll("button")].find((b) => b.textContent === "Close tab"));
  expect(canvasTab(el, R) === null).toBe(true);
});

test("only the canvas tab on screen loads its canvas; the others load when first shown", async () => {
  for (const [id, title] of [[R, "Release report"], [D, "Drill report"], [P, "Album plan"]] as const) canvasDocs.set(id, canvasDoc(id, title));
  act(() => {
    useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: [`canvas:${R}`, `canvas:${D}`, `canvas:${P}`], active: `canvas:${R}`, workerTab: {} } } });
  });
  const el = await render();
  expect(canvasReads).toEqual([R]);
  // Their tabs still say what they are.
  expect(canvasTab(el, P)!.textContent).toContain("Album plan");
  await click(canvasTab(el, D));
  await settle();
  expect(canvasReads).toEqual([R, D]);
  // Back to the first: it stayed as it was, not read again.
  await click(canvasTab(el, R));
  await settle();
  expect(canvasReads).toEqual([R, D]);
});

// The event stream back, or a canvas changed: only the canvas on screen reads
// itself again; one kept behind another tab reads once, when shown again.
test("a canvas tab behind another reads itself again only when shown", async () => {
  for (const [id, title] of [[R, "Release report"], [D, "Drill report"]] as const) canvasDocs.set(id, canvasDoc(id, title));
  act(() => {
    useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: [`canvas:${R}`, `canvas:${D}`], active: `canvas:${R}`, workerTab: {} } } });
  });
  const el = await render();
  await click(canvasTab(el, D));
  await settle();
  expect(canvasReads).toEqual([R, D]);
  canvasReads.length = 0;
  act(() => {
    window.dispatchEvent(new CustomEvent("mandate:sse-open"));
    window.dispatchEvent(new CustomEvent("mandate:canvas-updated", { detail: { canvasId: R, workerId: null } }));
  });
  await settle();
  expect(canvasReads).toEqual([D]);
  // Shown again: read once for both, as it now is.
  canvasDocs.set(R, canvasDoc(R, "Release report", { html: "<p>Release report, revised</p>", contentRevision: 2 }));
  await click(canvasTab(el, R));
  await settle();
  expect(canvasReads).toEqual([D, R]);
  // Nothing missed: shown again with nothing changed, it is not read.
  await click(canvasTab(el, D));
  await click(canvasTab(el, R));
  await settle();
  expect(canvasReads).toEqual([D, R]);
});

test("a worker tab shows its state's dot", async () => {
  const el = await render();
  act(() => { useWorkerPanelStore.getState().openWorker("thr_a", "w1"); });
  await settle();
  // w1 asks a question: amber, as Home's row says it.
  expect(el.querySelector('[data-worker-tab="w1"] [data-slot="tab-dot"]')!.className).toContain("bg-amber");
});

test("Open worker in a canvas tab opens this thread's worker as a tab", async () => {
  canvasDocs.set(D, canvasDoc(D, "Drill report", { scope: "worker", scopeId: "w1", workerId: "w1", workerName: "w1", projectId: "p1", projectName: "project-1", projectSlug: "md-p1", workerSlug: "w1" }));
  const el = await render();
  act(() => { useWorkerPanelStore.getState().openCanvas("thr_a", D); });
  await settle();
  await openTabMenu(el);
  await act(async () => { menuItem("Open worker")!.click(); });
  await settle();
  expect(el.querySelector('[data-worker-tab="w1"]')?.getAttribute("aria-selected")).toBe("true");
  expect(pathname).toBe("/threads/thr_a");
});

test("Open worker in a canvas tab of another thread's worker opens it in that thread, on its canvases", async () => {
  canvasDocs.set(D, canvasDoc(D, "Drill report", { scope: "worker", scopeId: "w3", workerId: "w3", workerName: "w3", projectId: "p1", projectName: "project-1", projectSlug: "md-p1", workerSlug: "w3" }));
  const el = await render();
  act(() => { useWorkerPanelStore.getState().openCanvas("thr_a", D); });
  await settle();
  await openTabMenu(el);
  await act(async () => { menuItem("Open worker")!.click(); });
  await settle();
  expect(pathname + search).toBe("/threads/thr_b?worker=w3&tab=canvases");
});

// A design focused in one canvas tab, then another tab chosen: Esc there is
// not the hidden design's.
test("a design focused in a canvas tab behind another keeps its focus when Esc is pressed elsewhere", async () => {
  const design = {
    index: { title: null, pages: [{ id: "p1", name: "Flows" }], boards: [{ path: "Cart.html", x: 0, y: 0, w: 390, h: 844, title: "Cart", page: "p1", expand: null, interactive: false, radius: 0 }], notes: [], launch: { view: "focused", path: "Cart.html" } },
    artboards: { "Cart.html": "<p>Cart</p>" }
  };
  canvasDocs.set(P, canvasDoc(P, "Checkout", { kind: "design", html: "", design }));
  canvasDocs.set(R, canvasDoc(R, "Release report"));
  const el = await render();
  act(() => { useWorkerPanelStore.getState().openCanvas("thr_a", P); });
  await settle();
  expect(el.querySelectorAll('[data-slot="design-focus"]')).toHaveLength(1);
  act(() => { useWorkerPanelStore.getState().openCanvas("thr_a", R); });
  await settle();
  await act(async () => { document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  await settle();
  expect(el.querySelectorAll('[data-slot="design-focus"]')).toHaveLength(1);
});

const tabNames = (root: ParentNode, slot: string) =>
  Array.from(root.querySelectorAll(`[data-slot="${slot}"] [role="tablist"][aria-label="Worker tabs"] [role="tab"]`)).map((tab) => tab.textContent?.replace(/\s+/g, " ").trim());

// The replies opened from the thread's chat are tabs after its workers and
// canvases, in the side panel and in the phone's sheet.
test("reply tabs follow worker and canvas tabs in a thread's panel", async () => {
  replyTabsServed = [replyTab("rtab_1", "m9", "**Photo import**: done in 20 minutes.")];
  act(() => { useWorkerPanelStore.getState().openWorker("thr_a", "w1"); useWorkerPanelStore.getState().setActive("thr_a", "workers"); });
  const el = await render();
  await settleUntil(() => el.querySelector('[data-reply-tab="rtab_1"]') !== null, "the reply's tab");
  expect(tabNames(el, "worker-panel-side")).toEqual(["Workers2", "w1", "Photo import: done in 20 minutes."]);
  await click(el.querySelector('[data-reply-tab="rtab_1"]'));
  const panel = el.querySelector('[data-slot="worker-panel-side"]')!;
  expect(panel.querySelector('[data-reply-tab="rtab_1"]')?.getAttribute("aria-selected")).toBe("true");
  expect(panel.querySelector('[data-slot="reply-tab-view"]')?.textContent).toContain("done in 20 minutes.");
  expect(panel.querySelector('section[aria-label="Waiting for an answer"]') === null).toBe(true);
});

test("in the phone's sheet the reply tabs follow the worker tabs", async () => {
  onCleanup(fakePhoneWidth());
  replyTabsServed = [replyTab("rtab_1", "m9", "Photo import done.")];
  act(() => { useWorkerPanelStore.getState().openWorker("thr_a", "w1"); useWorkerPanelStore.getState().setSheet("half"); });
  await render();
  await settleUntil(() => document.querySelector('[data-slot="worker-panel-sheet"] [data-reply-tab="rtab_1"]') !== null, "the reply's tab in the sheet");
  expect(tabNames(document, "worker-panel-sheet")).toEqual(["Workers2", "w1", "Photo import done."]);
});

test("a reply in the thread's own chat opens in its panel", async () => {
  const reply = {
    id: "m9", threadId: "thr_a", seq: 2, role: "assistant", source: "self", sourceThreadId: null, wakeId: "wake_9", createdAt: at,
    content: { type: "assistant", text: "**Photo import**: done in 20 minutes." }
  };
  const el = await render("/threads/thr_a", [report, reply]);
  const panel = () => el.querySelector('[data-slot="worker-panel-side"]')!;
  const button = [...el.querySelectorAll('[data-slot="open-in-panel"]')].find((b) => !panel().contains(b));
  await settleUntil(() => button?.getAttribute("aria-label") === "Open in panel", "the reply's button");
  await click(button);
  await settleUntil(() => useWorkerPanelStore.getState().get("thr_a").active === "reply:rtab_new", "its tab opens");
  expect(replyTabsServed).toEqual([replyTab("rtab_new", "m9", "**Photo import**: done in 20 minutes.")]);
  await settleUntil(() => panel().querySelector('[data-slot="reply-tab-view"]') !== null, "the reply shows in the panel");
});

test("a thread's reply tab switched away from and back to is the same view", async () => {
  replyTabsServed = [replyTab("rtab_1", "m9", "A long reply.")];
  act(() => { useWorkerPanelStore.getState().openReply("thr_a", "reply:rtab_1"); });
  const el = await render();
  await settleUntil(() => el.querySelector('[data-slot="reply-tab-view"]') !== null, "the reply shows");
  const view = el.querySelector('[data-slot="reply-tab-view"]')!;
  await click([...el.querySelectorAll('[data-slot="worker-panel-side"] [role="tab"]')].find((t) => t.textContent?.startsWith("Workers")));
  expect(view.isConnected).toBe(true);
  await click(el.querySelector('[data-reply-tab="rtab_1"][role="tab"]'));
  expect(el.querySelector('[data-slot="reply-tab-view"]:not(.hidden)') === view).toBe(true);
});

test("a thread's reply tabs come after its canvas tabs too", async () => {
  canvasDocs.set("cnv_RelNotes001", canvasDoc("cnv_RelNotes001", "Release notes"));
  replyTabsServed = [replyTab("rtab_1", "m9", "Photo import done.")];
  act(() => {
    useWorkerPanelStore.getState().openWorker("thr_a", "w1");
    useWorkerPanelStore.getState().openCanvas("thr_a", "cnv_RelNotes001");
    useWorkerPanelStore.getState().setActive("thr_a", "workers");
  });
  const el = await render();
  await settleUntil(() => tabNames(el, "worker-panel-side").includes("Release notes") && el.querySelector('[data-reply-tab="rtab_1"]') !== null, "the canvas named and the reply's tab");
  expect(tabNames(el, "worker-panel-side")).toEqual(["Workers2", "w1", "Release notes", "Photo import done."]);
});

// ---- Files as tabs beside the chat ----

const fileTab = (el: HTMLElement, path: string) => el.querySelector<HTMLElement>(`[data-slot="worker-panel"] [data-file-tab="${path}"]`);
const fileLink = (el: HTMLElement, href: string) => el.querySelector<HTMLElement>(`[data-slot="thread-chat"] a[data-file-link][href="${href}"]`);

test("a file link in the chat opens the file as a tab beside it, named by the file; the same file at another line goes to its tab", async () => {
  const report = "/tmp/project-1/docs/report.md";
  const code = "/tmp/project-1/src/expiry.ts";
  const el = await render("/threads/thr_a", [linkTo("f", `See [the write-up](${report}), [line 42](${code}#L42) and [line 50](${code}#L50).`)]);
  await settleUntil(() => el.querySelector("a[data-file-link]") !== null, "the file links in the chat");
  const links = [...el.querySelectorAll<HTMLElement>('[data-slot="thread-chat"] a[data-file-link]')];
  await click(links[0]);
  await settle();
  expect(fileTab(el, report)!.getAttribute("aria-selected")).toBe("true");
  expect(fileTab(el, report)!.textContent).toContain("report.md");
  await settleUntil(() => el.querySelector(`[data-slot="file-view"][data-path="${report}"]`) !== null, "the file's view");
  await click(links[1]);
  await settle();
  await click(links[2]);
  await settle();
  expect(el.querySelectorAll(`[data-file-tab="${code}"]`)).toHaveLength(1);
  expect(fileTab(el, code)!.getAttribute("aria-selected")).toBe("true");
  await settleUntil(() => el.querySelector(`[data-slot="file-view"][data-path="${code}"]`)?.getAttribute("data-line") === "50", "the file's view at line 50");
  // Beside the chat, not over it.
  expect(pathname).toBe("/threads/thr_a");
  expect(document.querySelector('[aria-label="File"][role="dialog"]') === null).toBe(true);
  expect(fileLink(el, links[0]!.getAttribute("href")!) !== null).toBe(true);
});

// Reopen in a thread's panel: a worker's tab closed comes back where it
// stood, shown; an archived worker's named; each thread its own list.
test("a worker's tab closed in a thread's panel comes back from Reopen where it stood; an archived one comes back named", async () => {
  useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: ["w1", "w2"], active: "workers", workerTab: {} } } });
  const el = await render();
  await click(el.querySelector('[data-slot="worker-panel"] button[aria-expanded]'));
  await click(el.querySelector('section[aria-label="Archived"] button'));
  await settleUntil(() => el.querySelector('[data-worker-tab="archived:old"]')?.textContent?.includes("old-worker") === true, "the archived worker's tab, named");
  const reopen = () => el.querySelector<HTMLElement>('[data-slot="worker-panel"] [aria-label="Reopen a closed tab"]');
  expect(reopen() === null).toBe(true);
  await click(el.querySelector('[data-worker-tab="w1"] [aria-label^="Close"]'));
  await click(el.querySelector('[data-worker-tab="archived:old"] [aria-label^="Close"]'));
  expect(useWorkerPanelStore.getState().get("thr_a").tabs).toEqual(["w2"]);
  const openList = async () => {
    await act(async () => {
      reopen()!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
      await new Promise((r) => setTimeout(r, 0));
    });
    return [...document.querySelectorAll<HTMLElement>('[data-slot="recently-closed-menu"] [role="menuitem"]')];
  };
  let rows = await openList();
  expect(rows.map((row) => row.querySelector('[data-slot="recently-closed-name"]')?.textContent)).toEqual(["old-worker", "w1"]);
  await click(rows[1]);
  expect(useWorkerPanelStore.getState().get("thr_a")).toMatchObject({ tabs: ["w1", "w2"], active: "w1" });
  rows = await openList();
  await click(rows[0]);
  expect(el.querySelector('[data-worker-tab="archived:old"]')?.textContent).toContain("old-worker");
  expect(reopen() === null).toBe(true);
  expect(Object.keys(useClosedTabsStore.getState().byPanel)).toEqual(["thread:thr_a"]);
});

// The panel's tabs in the order the person put them in: every tab
// after Workers in one group, dragged or moved by a right-click.
test("the side panel draws its tabs in the stored order, every tab after Workers in one group, and Move right moves the shown one", async () => {
  // Radix anchors the menu at the press with a DOMRect, which the test DOM
  // keeps on its window only.
  const globals = globalThis as { DOMRect?: unknown };
  if (!globals.DOMRect) {
    globals.DOMRect = (window as unknown as { DOMRect: unknown }).DOMRect;
    onCleanup(() => { delete globals.DOMRect; });
  }
  canvasDocs.set("cnv_c1", canvasDoc("cnv_c1", "Release notes"));
  act(() => {
    useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: ["w1", "canvas:cnv_c1"], active: "workers", workerTab: {}, order: ["canvas:cnv_c1", "w1"] } } });
  });
  const el = await render();
  const row = () => el.querySelector<HTMLElement>('[data-slot="worker-panel"] [role="tablist"][aria-label="Worker tabs"]')!;
  const ids = () => [...row().querySelectorAll<HTMLElement>(':scope > [role="tab"]')].map((tab) => tab.dataset.workerTab ?? tab.dataset.canvasTab ?? "first");
  await settleUntil(() => ids().length === 3, "the panel's tabs");
  expect(ids()).toEqual(["first", "cnv_c1", "w1"]);
  const tabs = [...row().querySelectorAll<HTMLElement>(':scope > [role="tab"]')];
  expect(tabs.map((tab) => tab.dataset.sortOrder ?? null)).toEqual([null, "tabs", "tabs"]);
  const canvasTab = row().querySelector<HTMLElement>('[data-canvas-tab="cnv_c1"]')!;
  await act(async () => { canvasTab.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
  const items = () => [...document.querySelectorAll<HTMLElement>('[role="menu"][data-state="open"] [role="menuitem"]')];
  await settleUntil(() => items().length === 2, "the tab's menu");
  expect(items().map((item) => item.textContent)).toEqual(["Move left", "Move right"]);
  await act(async () => { items()[1]!.click(); });
  await settleUntil(() => ids()[1] === "w1", "the canvas tab moved right");
  expect(ids()).toEqual(["first", "w1", "cnv_c1"]);
  expect(useWorkerPanelStore.getState().get("thr_a").order).toEqual(["w1", "canvas:cnv_c1"]);
  // Radix gives the focus back a timer after the menu closes.
  await settle(20);
});

/** Radix anchors a context menu at the press with a DOMRect, which the test
 *  DOM keeps on its window only. */
function radixAnchors() {
  const globals = globalThis as { DOMRect?: unknown };
  if (!globals.DOMRect) {
    globals.DOMRect = (window as unknown as { DOMRect: unknown }).DOMRect;
    onCleanup(() => { delete globals.DOMRect; });
  }
}
const rowIdsOf = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-slot="worker-panel"] [role="tablist"][aria-label="Worker tabs"] > [role="tab"]')]
  .map((tab) => tab.dataset.workerTab ?? tab.dataset.canvasTab ?? (tab.dataset.replyTab ? `reply:${tab.dataset.replyTab}` : "first"));

test("in a reordered panel the shown tab closed with nothing shown before it goes to the tab on its left as drawn, a reply's", async () => {
  replyTabsServed = [replyTab("rtab_1", "m1", "Tagged v3.21.")];
  act(() => {
    useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: ["w1", "w2"], active: "w2", workerTab: {}, order: ["w1", "reply:rtab_1", "w2"] } } });
  });
  const el = await render();
  await settleUntil(() => rowIdsOf(el).length === 4, "the panel's tabs");
  expect(rowIdsOf(el)).toEqual(["first", "w1", "reply:rtab_1", "w2"]);
  await click(el.querySelector('[data-worker-tab="w2"] [aria-label^="Close"]'));
  expect(useWorkerPanelStore.getState().get("thr_a").active).toBe("reply:rtab_1");
});

test("in a reordered panel a tab from Reopen comes back after the one before it as drawn, among tabs opened after the drag too", async () => {
  for (const id of ["cnv_a", "cnv_b", "cnv_c", "cnv_d"]) canvasDocs.set(id, canvasDoc(id, id));
  // cnv_d was opened after the drag: not in the order.
  act(() => {
    useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: ["canvas:cnv_a", "canvas:cnv_b", "canvas:cnv_c", "canvas:cnv_d"], active: "workers", workerTab: {}, order: ["canvas:cnv_c", "canvas:cnv_a", "canvas:cnv_b"] } } });
  });
  const el = await render();
  await settleUntil(() => rowIdsOf(el).length === 5, "the panel's tabs");
  expect(rowIdsOf(el)).toEqual(["first", "cnv_c", "cnv_a", "cnv_b", "cnv_d"]);
  const reopenFirst = async () => {
    await act(async () => {
      el.querySelector<HTMLElement>('[data-slot="worker-panel"] [aria-label="Reopen a closed tab"]')!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
      await new Promise((r) => setTimeout(r, 0));
    });
    await click(document.querySelector('[data-slot="recently-closed-menu"] [role="menuitem"]'));
    await settleUntil(() => rowIdsOf(el).length === 5, "the canvas is back");
  };
  await click(el.querySelector('[data-canvas-tab="cnv_a"] [aria-label^="Close"]'));
  await reopenFirst();
  expect(rowIdsOf(el)).toEqual(["first", "cnv_c", "cnv_a", "cnv_b", "cnv_d"]);
  await click(el.querySelector('[data-canvas-tab="cnv_d"] [aria-label^="Close"]'));
  await reopenFirst();
  expect(rowIdsOf(el)).toEqual(["first", "cnv_c", "cnv_a", "cnv_b", "cnv_d"]);
});

test("a drop before the panel's replies have come keeps a reply's saved place", async () => {
  radixAnchors();
  replyTabsHeld = true;
  act(() => {
    useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: ["w1", "w2"], active: "workers", workerTab: {}, order: ["reply:rtab_1", "w1", "w2"] } } });
  });
  const el = await render();
  await settleUntil(() => rowIdsOf(el).length === 3, "the panel's tabs");
  await act(async () => { el.querySelector<HTMLElement>('[data-worker-tab="w1"]')!.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
  const items = () => [...document.querySelectorAll<HTMLElement>('[role="menu"][data-state="open"] [role="menuitem"]')];
  await settleUntil(() => items().length === 2, "the tab's menu");
  await act(async () => { items()[1]!.click(); });
  expect(useWorkerPanelStore.getState().get("thr_a").order).toEqual(["reply:rtab_1", "w2", "w1"]);
  await settle(20);
});

test("after a drag, a tab opened later comes last in a thread's panel: a reply, then a canvas opened after it", async () => {
  canvasDocs.set("cnv_c1", canvasDoc("cnv_c1", "Release notes"));
  act(() => {
    useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: ["w1", "w2"], active: "workers", workerTab: {}, order: ["w2", "w1"] } } });
  });
  const el = await render();
  await settleUntil(() => rowIdsOf(el).length === 3, "the panel's tabs");
  replyTabsServed = [replyTab("rtab_1", "m1", "Tagged v3.21.")];
  await act(async () => { useReplyTabsStore.getState().changed("thr_a"); });
  await settleUntil(() => rowIdsOf(el).length === 4, "the reply's tab");
  act(() => { useWorkerPanelStore.getState().openCanvas("thr_a", "cnv_c1"); });
  await settleUntil(() => rowIdsOf(el).length === 5, "the canvas tab");
  expect(rowIdsOf(el)).toEqual(["first", "w2", "w1", "reply:rtab_1", "cnv_c1"]);
});

test("after a drag, canvases opened while the reply list has not come join the order, so Reopen puts one back after the other", async () => {
  replyTabsHeld = true;
  for (const id of ["cnv_c1", "cnv_c2"]) canvasDocs.set(id, canvasDoc(id, id));
  act(() => {
    useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: ["w1", "w2"], active: "workers", workerTab: {}, order: ["w2", "w1"] } } });
  });
  const el = await render();
  await settleUntil(() => rowIdsOf(el).length === 3, "the panel's tabs");
  act(() => { useWorkerPanelStore.getState().openCanvas("thr_a", "cnv_c1"); });
  await settleRounds(2);
  act(() => { useWorkerPanelStore.getState().openCanvas("thr_a", "cnv_c2"); });
  await settleUntil(() => rowIdsOf(el).length === 5, "the canvas tabs");
  await click(el.querySelector('[data-canvas-tab="cnv_c2"] [aria-label^="Close"]'));
  await act(async () => {
    el.querySelector<HTMLElement>('[data-slot="worker-panel"] [aria-label="Reopen a closed tab"]')!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  await click(document.querySelector('[data-slot="recently-closed-menu"] [role="menuitem"]'));
  await settleUntil(() => rowIdsOf(el).length === 5, "the canvas is back");
  expect(rowIdsOf(el)).toEqual(["first", "w2", "w1", "cnv_c1", "cnv_c2"]);
});
