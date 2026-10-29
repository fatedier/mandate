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
import { useFeaturePlansStore } from "@/store/feature-plans";
import { useWorkerPanelStore } from "@/store/worker-panel";
import { useCommandsStore } from "@/store/commands";
import type { WorkItemDto } from "@shared/api/work-items";
import { emptyPlan, type FeaturePlanDto } from "@shared/api/plans";
import { workerReportMetadata } from "@shared/worker-report";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mockFetch, withFetch } from "../helpers/fetch.js";
import { mountAsync, settle, settleUntil, type Mounted } from "../helpers/mount.js";
import { clientFeature, clientProject, managerThreadDto } from "../helpers/client-builders.js";
import { reducedMotion } from "../helpers/motion.js";
import { resetCanvasTitles } from "@/store/canvas-titles";

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
    useFeaturePlansStore.setState({ plans: new Map() });
    useWorkerPanelStore.setState({ byThread: {}, maximized: null, narrow: false, narrowView: "chat" });
    useCommandsStore.setState({ byScope: new Map(), noticeByScope: new Map() });
  });
});

const thread = managerThreadDto("thr_a", { title: "project-1 3.21 release", lastVisibleSeq: 1, seenSeq: 1 });

const project = clientProject("p1", {
  // w3 reported here once, and has since moved to another thread.
  features: [clientFeature("w1"), clientFeature("w2"), { ...clientFeature("w3"), ownerThreadId: "thr_b" }]
});
const item = (featureId: string): WorkItemDto => ({
  id: `wi-${featureId}`, featureId, projectId: "p1", title: featureId,
  lastActivityAt: at, createdAt: at, updatedAt: at, failedAt: null, failedMessage: null, failedKind: null
});
const donePlan: FeaturePlanDto = {
  ...emptyPlan("w2"),
  steps: [{ id: 1, title: "Tag v3.21", status: "done", note: "pushed", createdAt: at, startedAt: at, blockedAt: null, completedAt: at, updatedAt: at }],
  updatedAt: at
};
/** w1 asks: a question in its plan, and no flag. */
const askingPlan: FeaturePlanDto = { ...emptyPlan("w1"), openQuestions: ["Keep the old flag as an alias?"], updatedAt: at };
const report = {
  id: "m1", threadId: "thr_a", seq: 1, role: "user", source: "worker-report", sourceThreadId: null, wakeId: null, createdAt: at,
  content: {
    type: "text", text: "[Worker report] w2 (w2, project project-1): done — Tagged.",
    metadata: workerReportMetadata({ featureId: "w2", featureName: "w2", projectId: "p1", projectName: "project-1", key: "done", line: "Tagged." })
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
  featureId: null, featureName: null, featureSlug: null, threadId: "thr_a",
  createdAt: at, updatedAt: "2026-09-27T09:16:00.000Z", ...extra
});
afterEach(() => { canvasDocs.clear(); canvasReads.length = 0; resetCanvasTitles(); });

async function render(url = "/threads/thr_a", transcript: unknown[] = [report], projects: Project[] = [project]) {
  mockFetch(({ url, method }) => {
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
    if (url.includes("/workers?archived=1")) return Response.json({ workers: [{ featureId: "old", name: "old-worker", projectId: "p1", projectName: "project-1", workerThreadId: "thr-old", archivedAt: at }] });
    // The thread's background tasks: none.
    if (url.endsWith("/tasks")) return Response.json({ tasks: [] });
    if (url.includes("/api/agents/threads/thr-old")) return Response.json({ thread: { id: "thr-old" }, messages: [], hasMore: false });
    if (url.includes("/api/agents/threads/thr_a")) return Response.json({ thread: { id: "thr_a" }, messages: transcript, hasMore: false });
    if (url.includes("/thread")) return Response.json({ thread: null, messages: [], hasMore: false });
    const featureCanvases = /\/api\/features\/([^/]+)\/canvases$/.exec(url);
    if (featureCanvases) return Response.json({ canvases: [...canvasDocs.values()].filter((doc) => doc.featureId === featureCanvases[1]) });
    if (url.includes("/canvases")) return Response.json({ canvases: [] });
    if (url.includes("/plan")) return Response.json({ plan: url.includes("w2") ? donePlan : askingPlan });
    return Response.json({});
  });
  act(() => {
    useManagerThreadsStore.getState().replaceAll([thread]);
    useProjectsStore.getState().setProjectsState(projects);
    useWorkItemsStore.getState().upsert(item("w1"));
    useFeaturePlansStore.getState().upsert(askingPlan, "fetch");
    useFeaturePlansStore.getState().upsert(donePlan, "fetch");
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
    content: { ...report.content, metadata: workerReportMetadata({ featureId: "w3", featureName: "w3", projectId: "p1", projectName: "project-1", key: "done", line: "Moved." }) }
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
  await click(workersToggle(el));
  expect(el.querySelector('[data-slot="worker-panel"]') === null).toBe(true);
  await click([...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Open in panel")));
  expect(el.querySelector('[data-worker-tab="w2"]')?.getAttribute("aria-selected")).toBe("true");
});

test("a maximized panel is this thread's only: leaving the thread restores the split", async () => {
  const el = await render();
  await click(el.querySelector('[aria-label="Hide chat"]'));
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

test("the header's Workers button hides the panel, remembered for the thread", async () => {
  const el = await render();
  await click(workersToggle(el));
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
  await click(workersToggle(el));
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
  await click(workersToggle(el));
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
  expect(items.map((i) => i.textContent)).toContain("Open worker page");
  await act(async () => { items.find((i) => i.textContent === "Archive worker")!.click(); await new Promise((r) => setTimeout(r, 0)); });
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === "Archive")!;
  await act(async () => { confirm.click(); await new Promise((r) => setTimeout(r, 0)); });
  expect(calls.some((c) => c.startsWith("DELETE /api/features/w1"))).toBe(true);
  expect(pathname).toBe("/threads/thr_a");
  expect(el.querySelector('[data-worker-tab="w1"]') === null).toBe(true);
});

const workersToggle = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-slot="panel-toggle"]')!;

// The panel holds reports and canvases beside the workers: the header says
// Panel, and the panel's own Workers tab carries the count.
test("the header's Panel button hides and shows the panel and counts nothing", async () => {
  const el = await render();
  expect([workersToggle(el).textContent, workersToggle(el).getAttribute("aria-label"), workersToggle(el).getAttribute("title")]).toEqual(["Panel", "Hide panel", "Hide panel"]);
  await click(workersToggle(el));
  expect(el.querySelector('[data-slot="worker-panel"]') === null).toBe(true);
  expect([workersToggle(el).textContent, workersToggle(el).getAttribute("aria-label")]).toEqual(["Panel", "Show panel"]);
  await click(workersToggle(el));
  expect(el.querySelector('[data-slot="worker-panel"]') === null).toBe(false);
});

// Nothing floats over the transcript: the header's Workers
// toggle gives the chat the whole row, and the panel keeps its own maximize.
test("the chat column carries no control of its own; hiding the workers gives it the row", async () => {
  const el = await render();
  expect(el.querySelector('[data-slot="thread-chat"] [data-pane-zoom]') === null).toBe(true);
  expect(el.querySelector('[aria-label="Maximize chat"]') === null).toBe(true);
  await click(workersToggle(el));
  expect(el.querySelector('[data-slot="worker-panel"]') === null).toBe(true);
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
    threadsByScope.set("manager:thr_a", { ...entry, contextUsage: { inputTokens: 34_000, budgetTokens: 100_000, updatedAt: at, source: "compression_budget" } });
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
  const rect = proto.getBoundingClientRect;
  const Observer = globalThis.ResizeObserver;
  const callbacks = new Set<() => void>();
  proto.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: rowWidth, height: 600, right: rowWidth, bottom: 600, toJSON: () => ({}) }) as DOMRect;
  globalThis.ResizeObserver = class {
    #callback: () => void;
    constructor(callback: () => void) { this.#callback = callback; }
    observe() { callbacks.add(this.#callback); }
    unobserve() { callbacks.delete(this.#callback); }
    disconnect() { callbacks.delete(this.#callback); }
  } as unknown as typeof ResizeObserver;
  onCleanup(() => { proto.getBoundingClientRect = rect; globalThis.ResizeObserver = Observer; });
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
  await click(el.querySelector('[aria-label="Hide chat"]'));
  await resizeRow(596);
  expect([chatShown(el), panelShown(el)]).toEqual([false, true]);
});

for (const back of ["Esc", "the toggle", "Hide"] as const) {
  test(`a panel maximized before the row narrowed, sent back to the chat with ${back}, leaves both sides for a wider row`, async () => {
    const el = await renderAt(1000);
    await click(el.querySelector('[aria-label="Hide chat"]'));
    await resizeRow(596);
    expect([chatShown(el), panelShown(el)]).toEqual([false, true]);
    if (back === "Esc") act(() => { window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" })); });
    else await click(back === "Hide" ? el.querySelector('[aria-label="Hide panel"]') : workersToggle(el));
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

  test("closeTab falls back to the neighbour, then to Workers", () => {
    const s = useWorkerPanelStore.getState();
    s.openWorker("A", "f1");
    s.openWorker("A", "f2");
    s.closeTab("A", "f2");
    expect(useWorkerPanelStore.getState().get("A")).toMatchObject({ tabs: ["f1"], active: "f1" });
    s.closeTab("A", "f1");
    expect(useWorkerPanelStore.getState().get("A")).toMatchObject({ tabs: [], active: "workers" });
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
  act(() => { window.dispatchEvent(new CustomEvent("mandate:canvas-updated", { detail: { canvasId: R, featureId: null } })); });
  await settle();
  // The canvas view is loaded when first shown: wait for its bar, not a fixed time.
  await settleUntil(() => el.querySelector('[data-slot="canvas-tab-bar"]')?.textContent?.includes("Release notes v2") ?? false, "the canvas tab's bar");
  expect(el.querySelector('[data-slot="canvas-tab-bar"]')!.textContent).toContain("Release notes v2");
  expect(canvasTab(el, R)!.textContent).toContain("Release notes v2");
});

test("a canvas opened while the panel is hidden brings the panel back", async () => {
  canvasDocs.set(R, canvasDoc(R, "Release report"));
  const el = await render("/threads/thr_a", [report, linkTo(R, `See [it](/canvas/${R}).`)]);
  await click(workersToggle(el));
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
  canvasDocs.set(D, canvasDoc(D, "Drill report", { scope: "worker", scopeId: "w1", featureId: "w1", featureName: "w1" }));
  const el = await render();
  act(() => { useWorkerPanelStore.getState().openWorker("thr_a", "w1", "reports"); });
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
  expect(canvasTab(el, R)).toBeNull();
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
  act(() => { window.dispatchEvent(new CustomEvent("mandate:canvas-updated", { detail: { canvasId: R, featureId: null } })); });
  await settle();
  await settle();
  const state = el.querySelector<HTMLElement>('[data-slot="worker-panel"] [data-slot="state-message"]')!;
  expect(state.querySelector("h2")!.textContent).toBe("Canvas not found");
  await click([...state.querySelectorAll("button")].find((b) => b.textContent === "Close tab"));
  expect(canvasTab(el, R)).toBeNull();
});

test("only the canvas tab on screen loads its canvas; the others load when first shown", async () => {
  for (const [id, title] of [[R, "Release report"], [D, "Drill report"], [P, "Rollout plan"]] as const) canvasDocs.set(id, canvasDoc(id, title));
  act(() => {
    useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: [`canvas:${R}`, `canvas:${D}`, `canvas:${P}`], active: `canvas:${R}`, workerTab: {} } } });
  });
  const el = await render();
  expect(canvasReads).toEqual([R]);
  // Their tabs still say what they are.
  expect(canvasTab(el, P)!.textContent).toContain("Rollout plan");
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
    window.dispatchEvent(new CustomEvent("mandate:canvas-updated", { detail: { canvasId: R, featureId: null } }));
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
  canvasDocs.set(D, canvasDoc(D, "Drill report", { scope: "worker", scopeId: "w1", featureId: "w1", featureName: "w1", projectId: "p1", projectName: "project-1", projectSlug: "md-p1", featureSlug: "w1" }));
  const el = await render();
  act(() => { useWorkerPanelStore.getState().openCanvas("thr_a", D); });
  await settle();
  await openTabMenu(el);
  await act(async () => { menuItem("Open worker")!.click(); });
  await settle();
  expect(el.querySelector('[data-worker-tab="w1"]')?.getAttribute("aria-selected")).toBe("true");
  expect(pathname).toBe("/threads/thr_a");
});

test("Open worker in a canvas tab of another thread's worker goes to that worker's page", async () => {
  canvasDocs.set(D, canvasDoc(D, "Drill report", { scope: "worker", scopeId: "w3", featureId: "w3", featureName: "w3", projectId: "p1", projectName: "project-1", projectSlug: "md-p1", featureSlug: "w3" }));
  const el = await render();
  act(() => { useWorkerPanelStore.getState().openCanvas("thr_a", D); });
  await settle();
  await openTabMenu(el);
  await act(async () => { menuItem("Open worker")!.click(); });
  await settle();
  expect(pathname).toBe("/projects/md-p1/features/w3");
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
