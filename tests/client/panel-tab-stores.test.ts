import { afterEach, expect, test } from "bun:test";
import { canvasIdOfTab, canvasTabId, filePathOfTab, fileTabId, orderedIds, replyIdOfTab, replyTabId } from "@/lib/panel-tabs";
import { useWorkerPanelStore } from "@/store/worker-panel";
import { useAgentPageUi } from "@/store/agent-page-ui";
import { useReplyTabsStore } from "@/store/reply-tabs";
import { useThreadTabsStore } from "@/store/thread-tabs";
import type { ReplyTabDto } from "@shared/api-contracts";

// The right panel's tabs: a thread's (Workers first, then workers and
// canvases) and the personal agent's (Page first, then canvases). A canvas is a tab
// as a worker is, remembered with it.

afterEach(() => {
  localStorage.removeItem("mandate.worker-panel.v3");
  localStorage.removeItem("mandate.agent-page.v1");
  useWorkerPanelStore.setState({ byThread: {}, maximized: null, narrow: false, narrowView: "chat" });
  useAgentPageUi.setState({ open: true, maximized: false, ratio: 0.5, narrow: false, narrowView: "chat", tabs: [], active: "page", fileLines: {}, history: false, recent: [], order: undefined, orderAt: undefined, threadSeen: undefined });
  useReplyTabsStore.setState({ byThread: new Map(), latest: new Map(), applied: new Map() });
  useThreadTabsStore.setState({ tabs: null, latest: 0, applied: 0 });
});

const replyTab = (id: string, threadId: string): ReplyTabDto => ({
  id, threadId, messageId: `msg_${id}`, text: "Done.", repliedAt: "2026-10-20T10:05:00.000Z", createdAt: "2026-10-20T10:06:00.000Z"
});

test("canvasIdOfTab reads only canvas tabs", () => {
  expect(canvasTabId("cnv_x")).toBe("canvas:cnv_x");
  expect([canvasIdOfTab("canvas:cnv_x"), canvasIdOfTab("w1"), canvasIdOfTab("archived:w1")]).toEqual(["cnv_x", null, null]);
});

test("a canvas opens as a tab once, at the end, and becomes the open one", () => {
  const panel = useWorkerPanelStore.getState();
  panel.openWorker("thr_a", "w1");
  panel.setOpen("thr_a", false);
  panel.openCanvas("thr_a", "cnv_r");
  panel.setActive("thr_a", "w1");
  panel.openCanvas("thr_a", "cnv_r");
  expect(useWorkerPanelStore.getState().get("thr_a")).toMatchObject({ open: true, tabs: ["w1", "canvas:cnv_r"], active: "canvas:cnv_r" });
  expect(useWorkerPanelStore.getState().narrowView).toBe("panel");

  const agent = useAgentPageUi.getState();
  agent.setOpen(false);
  agent.setNarrow(true);
  agent.openCanvas("cnv_r");
  agent.setActive("page");
  agent.openCanvas("cnv_r");
  expect(useAgentPageUi.getState()).toMatchObject({ open: true, tabs: ["canvas:cnv_r"], active: "canvas:cnv_r", narrowView: "side" });
});

test("with no tab shown before it left, closing the open tab opens its left neighbour (the next one for the first), the first tab when none is left", () => {
  const panel = useWorkerPanelStore.getState();
  const thread = (tabs: string[], active: string) => useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs, active, workerTab: {} } } });
  // The last of four: its left neighbour, not the first tab.
  thread(["w1", "canvas:cnv_r", "canvas:cnv_d", "canvas:cnv_e"], "canvas:cnv_e");
  panel.closeTab("thr_a", "canvas:cnv_e");
  expect(useWorkerPanelStore.getState().get("thr_a")).toMatchObject({ tabs: ["w1", "canvas:cnv_r", "canvas:cnv_d"], active: "canvas:cnv_d" });
  thread(["w1", "canvas:cnv_r", "canvas:cnv_d"], "canvas:cnv_r");
  panel.closeTab("thr_a", "canvas:cnv_r");
  expect(useWorkerPanelStore.getState().get("thr_a")).toMatchObject({ tabs: ["w1", "canvas:cnv_d"], active: "w1" });
  thread(["w1", "canvas:cnv_d"], "w1");
  panel.closeTab("thr_a", "w1");
  expect(useWorkerPanelStore.getState().get("thr_a")).toMatchObject({ tabs: ["canvas:cnv_d"], active: "canvas:cnv_d" });
  thread(["canvas:cnv_d"], "canvas:cnv_d");
  panel.closeTab("thr_a", "canvas:cnv_d");
  expect(useWorkerPanelStore.getState().get("thr_a")).toMatchObject({ tabs: [], active: "workers" });

  const agent = useAgentPageUi.getState();
  const page = (tabs: string[], active: string) => useAgentPageUi.setState({ tabs, active, recent: [] });
  page(["canvas:cnv_r", "canvas:cnv_d", "canvas:cnv_e"], "canvas:cnv_e");
  agent.closeTab("canvas:cnv_e");
  expect(useAgentPageUi.getState()).toMatchObject({ tabs: ["canvas:cnv_r", "canvas:cnv_d"], active: "canvas:cnv_d" });
  page(["canvas:cnv_r", "canvas:cnv_d"], "canvas:cnv_r");
  agent.closeTab("canvas:cnv_r");
  expect(useAgentPageUi.getState()).toMatchObject({ tabs: ["canvas:cnv_d"], active: "canvas:cnv_d" });
  page(["canvas:cnv_d"], "canvas:cnv_d");
  agent.closeTab("canvas:cnv_d");
  expect(useAgentPageUi.getState()).toMatchObject({ tabs: [], active: "page" });
  // The tab before it in a row with more than canvases, as the panel tells it.
  page(["canvas:cnv_d"], "canvas:cnv_d");
  agent.closeTab("canvas:cnv_d", "side");
  expect(useAgentPageUi.getState().active).toBe("side");
});

// Closing the tab in sight goes back to where the reader was before it: the
// tab shown before it, while the row still has it. The tab on its left is
// only for when none of those is left.
test("closing the shown tab goes back to the tab shown before it, past the tabs between", () => {
  const agent = useAgentPageUi.getState();
  const active = () => useAgentPageUi.getState().active;
  agent.openCanvas("cnv_a");
  agent.openHistory();
  // A report opened from History closes back to it, not to the canvas on its left.
  agent.openCanvas("cnv_r");
  agent.closeTab("canvas:cnv_r");
  expect(active()).toBe("history");
  // Two opened from it one after the other: each closes back to it.
  agent.openCanvas("cnv_r");
  agent.setActive("history");
  agent.openCanvas("cnv_d");
  agent.closeTab("canvas:cnv_d");
  expect(active()).toBe("history");
  agent.setActive("canvas:cnv_r");
  agent.closeTab("canvas:cnv_r");
  expect(active()).toBe("history");
  // History closed while in sight: the canvas shown before it, not Page.
  agent.closeHistory();
  expect(active()).toBe("canvas:cnv_a");
  // One shown before it has closed since: the one shown before that.
  agent.openCanvas("cnv_f");
  agent.openCanvas("cnv_e");
  agent.closeTab("canvas:cnv_f");
  agent.closeTab("canvas:cnv_e");
  expect(active()).toBe("canvas:cnv_a");
  // Nothing shown before it left: Page.
  agent.closeTab("canvas:cnv_a");
  expect(active()).toBe("page");

  const panel = useWorkerPanelStore.getState();
  const shown = () => useWorkerPanelStore.getState().get("thr_a").active;
  panel.openWorker("thr_a", "w1");
  panel.openWorker("thr_a", "w2");
  panel.setActive("thr_a", "w1");
  // Opened from the first worker's tab: back to it, not to the second on its left.
  panel.openCanvas("thr_a", "cnv_r");
  panel.closeTab("thr_a", "canvas:cnv_r");
  expect(shown()).toBe("w1");
  panel.setActive("thr_a", "w2");
  panel.closeTab("thr_a", "w2");
  expect(shown()).toBe("w1");
});

test("a reply or thread tab shown before counts while the server's list has it", () => {
  const agent = useAgentPageUi.getState();
  const active = () => useAgentPageUi.getState().active;
  useReplyTabsStore.setState({ byThread: new Map([["thr_g", [replyTab("rtab_1", "thr_g")]]]) });
  useThreadTabsStore.setState({ tabs: [{ threadId: "thr_ci", createdAt: "2026-10-20T10:05:00.000Z" }] });
  agent.openReply("reply:rtab_1");
  agent.openCanvas("cnv_r");
  agent.closeTab("canvas:cnv_r");
  expect(active()).toBe("reply:rtab_1");
  agent.openThread("thr_ci");
  agent.openCanvas("cnv_r");
  agent.closeTab("canvas:cnv_r");
  expect(active()).toBe("thread:thr_ci");
  // Both closed since (here or on another device): Page.
  agent.openCanvas("cnv_r");
  useReplyTabsStore.setState({ byThread: new Map([["thr_g", []]]) });
  useThreadTabsStore.setState({ tabs: [] });
  agent.closeTab("canvas:cnv_r");
  expect(active()).toBe("page");

  const panel = useWorkerPanelStore.getState();
  const shown = () => useWorkerPanelStore.getState().get("thr_a").active;
  useReplyTabsStore.setState({ byThread: new Map([["thr_a", [replyTab("rtab_2", "thr_a")]]]) });
  panel.openWorker("thr_a", "w1");
  panel.openReply("thr_a", "reply:rtab_2");
  panel.openCanvas("thr_a", "cnv_d");
  panel.closeTab("thr_a", "canvas:cnv_d");
  expect(shown()).toBe("reply:rtab_2");
  // Another thread's reply tab of the same id is not this panel's.
  panel.openCanvas("thr_a", "cnv_d");
  useReplyTabsStore.setState({ byThread: new Map([["thr_b", [replyTab("rtab_2", "thr_b")]]]) });
  panel.closeTab("thr_a", "canvas:cnv_d");
  expect(shown()).toBe("w1");
});

// A server's tab in sight that goes (closed here, or on another device) is
// told to the panel with the tab before it in the row; the panel goes back
// to the tab shown before it instead, while it can.
test("a shown server tab that goes opens the tab shown before it, else the tab before it in the row", () => {
  const agent = useAgentPageUi.getState();
  const active = () => useAgentPageUi.getState().active;
  agent.openCanvas("cnv_a");
  agent.openHistory();
  agent.openReply("reply:rtab_1");
  agent.tabGone("reply:rtab_1", "canvas:cnv_a");
  expect(active()).toBe("history");
  // Nothing shown before it is left: the tab before it in the row.
  useAgentPageUi.setState({ history: false, tabs: [], active: "reply:rtab_2", recent: [] });
  agent.tabGone("reply:rtab_2", "thread:thr_ci");
  expect(active()).toBe("thread:thr_ci");
  // Told late, after another tab was chosen: nothing changes.
  agent.tabGone("reply:rtab_2", "page");
  expect(active()).toBe("thread:thr_ci");

  const panel = useWorkerPanelStore.getState();
  const shown = () => useWorkerPanelStore.getState().get("thr_a").active;
  panel.openWorker("thr_a", "w1");
  panel.openWorker("thr_a", "w2");
  panel.setActive("thr_a", "w1");
  panel.openReply("thr_a", "reply:rtab_3");
  panel.tabGone("thr_a", "reply:rtab_3", "w2");
  expect(shown()).toBe("w1");
  panel.tabGone("thr_a", "reply:rtab_3", "w2");
  expect(shown()).toBe("w1");
});

// A row that shows only some of the tabs (a phone's has no canvas or file
// tabs) goes back only to a tab it shows.
test("The personal agent's row that shows no canvas tabs goes back past them", () => {
  const agent = useAgentPageUi.getState();
  const active = () => useAgentPageUi.getState().active;
  const noCanvases = (tabId: string) => canvasIdOfTab(tabId) === null;
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a"], history: true, active: "reply:rtab_2", recent: ["page", "history", "canvas:cnv_a", "reply:rtab_2"] });
  agent.tabGone("reply:rtab_2", "page", noCanvases);
  expect(active()).toBe("history");
  useAgentPageUi.setState({ recent: ["page", "canvas:cnv_a", "history"] });
  agent.closeHistory(noCanvases);
  expect(active()).toBe("page");
});

test("state saved before canvas tabs loads as it was", async () => {
  localStorage.setItem("mandate.worker-panel.v3", JSON.stringify({
    state: { byThread: { thr_a: { open: true, tabs: ["w1", "archived:old"], active: "archived:old", workerTab: { w1: "plan" } } } },
    version: 0
  }));
  await useWorkerPanelStore.persist.rehydrate();
  expect(useWorkerPanelStore.getState().get("thr_a")).toMatchObject({ open: true, tabs: ["w1", "archived:old"], active: "archived:old", workerTab: { w1: "plan" } });

  localStorage.setItem("mandate.agent-page.v1", JSON.stringify({ state: { open: false, maximized: false, ratio: 0.4 }, version: 0 }));
  await useAgentPageUi.persist.rehydrate();
  expect(useAgentPageUi.getState()).toMatchObject({ open: false, ratio: 0.4, tabs: [], active: "page" });
});

// A worker's tab remembered under a name the panel no longer has (the
// Canvases tab was "reports") opens on the worker's default instead.
test("a remembered worker tab the panel no longer has is left behind on load", async () => {
  localStorage.setItem("mandate.worker-panel.v3", JSON.stringify({
    state: { byThread: { thr_a: { open: true, tabs: ["w1", "w2"], active: "w1", workerTab: { w1: "reports", w2: "canvases", w3: 7 } } } },
    version: 0
  }));
  await useWorkerPanelStore.persist.rehydrate();
  expect(useWorkerPanelStore.getState().get("thr_a").workerTab).toStrictEqual({ w2: "canvases" });
});

test("The personal agent's tabs are remembered, and saved ones that are not tab ids are dropped", async () => {
  useAgentPageUi.getState().openCanvas("cnv_r");
  const saved = JSON.parse(localStorage.getItem("mandate.agent-page.v1") ?? "{}") as { state: Record<string, unknown> };
  expect(saved.state).toMatchObject({ tabs: ["canvas:cnv_r"], active: "canvas:cnv_r" });

  localStorage.setItem("mandate.agent-page.v1", JSON.stringify({ state: { open: true, ratio: 0.5, tabs: ["canvas:cnv_a", 3, null], active: "canvas:cnv_gone" }, version: 0 }));
  await useAgentPageUi.persist.rehydrate();
  expect(useAgentPageUi.getState()).toMatchObject({ tabs: ["canvas:cnv_a"], active: "page" });
});

// A row that shows only some of the tabs (the phone's sheet shows no canvas
// tabs) closes its open tab onto a neighbour it shows; the rule reads the
// tabs as they are when the close happens, so a close that lands late (a
// delete answered after another tab was chosen) leaves the open tab alone.
test("closing among the tabs a row shows opens a neighbour it shows; a late close of a tab not open changes nothing", () => {
  const panel = useWorkerPanelStore.getState();
  useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: ["w1", "canvas:cnv_x", "w2"], active: "w2", workerTab: {} } } });
  panel.closeTab("thr_a", "w2", (id) => canvasIdOfTab(id) === null);
  expect(useWorkerPanelStore.getState().get("thr_a")).toMatchObject({ tabs: ["w1", "canvas:cnv_x"], active: "w1" });
  panel.openCanvas("thr_a", "cnv_y");
  panel.closeTab("thr_a", "canvas:cnv_x");
  expect(useWorkerPanelStore.getState().get("thr_a")).toMatchObject({ tabs: ["w1", "canvas:cnv_y"], active: "canvas:cnv_y" });
});

// A reply tab is the server's: opening one shows it without adding it to the
// remembered tabs, and a saved one stays the open tab until the server's list
// says otherwise.
test("openReply opens the panel on the tab, and the side in a narrow row", () => {
  const panel = useWorkerPanelStore.getState();
  panel.openWorker("thr_a", "w1");
  panel.setOpen("thr_a", false);
  panel.openReply("thr_a", replyTabId("rtab_1"));
  expect(useWorkerPanelStore.getState().get("thr_a")).toMatchObject({ open: true, tabs: ["w1"], active: "reply:rtab_1" });
  expect(useWorkerPanelStore.getState().narrowView).toBe("panel");

  const page = useAgentPageUi.getState();
  page.setOpen(false);
  page.openReply(replyTabId("rtab_2"));
  expect(useAgentPageUi.getState()).toMatchObject({ open: true, tabs: [], active: "reply:rtab_2", narrowView: "chat" });
  page.setNarrow(true);
  page.openReply(replyTabId("rtab_3"));
  expect(useAgentPageUi.getState()).toMatchObject({ active: "reply:rtab_3", narrowView: "side" });
});

test("a saved reply tab stays active across a reload", async () => {
  expect([replyIdOfTab("reply:rtab_1"), replyIdOfTab("canvas:cnv_x"), replyIdOfTab("reply:")]).toEqual(["rtab_1", null, null]);
  localStorage.setItem("mandate.agent-page.v1", JSON.stringify({ state: { open: true, ratio: 0.5, tabs: ["canvas:cnv_a"], active: "reply:rtab_1" }, version: 0 }));
  await useAgentPageUi.persist.rehydrate();
  expect(useAgentPageUi.getState()).toMatchObject({ tabs: ["canvas:cnv_a"], active: "reply:rtab_1" });
});

test("a file opens as a tab once, by its path; opened again it moves to the new lines; closing it forgets them", () => {
  expect([fileTabId("/tmp/a.md"), filePathOfTab("file:/tmp/a.md"), filePathOfTab("canvas:cnv_x"), filePathOfTab("file:")]).toEqual(["file:/tmp/a.md", "/tmp/a.md", null, null]);
  const panel = useWorkerPanelStore.getState();
  panel.openWorker("thr_a", "w1");
  panel.openFile("thr_a", { path: "/tmp/expiry.ts", line: 42 });
  panel.setActive("thr_a", "w1");
  panel.openFile("thr_a", { path: "/tmp/expiry.ts", line: 50, end: 60 });
  expect(useWorkerPanelStore.getState().get("thr_a")).toMatchObject({
    tabs: ["w1", "file:/tmp/expiry.ts"], active: "file:/tmp/expiry.ts", fileLines: { "file:/tmp/expiry.ts": { line: 50, end: 60, opened: 2 } }
  });
  panel.openFile("thr_a", { path: "/tmp/expiry.ts" });
  expect(useWorkerPanelStore.getState().get("thr_a").fileLines).toEqual({ "file:/tmp/expiry.ts": { opened: 3 } });
  panel.closeTab("thr_a", "file:/tmp/expiry.ts");
  expect(useWorkerPanelStore.getState().get("thr_a")).toMatchObject({ tabs: ["w1"], fileLines: {} });

  const agent = useAgentPageUi.getState();
  agent.setNarrow(true);
  agent.openFile({ path: "/tmp/report.md", line: 3 });
  agent.openFile({ path: "/tmp/report.md", line: 9 });
  expect(useAgentPageUi.getState()).toMatchObject({ tabs: ["file:/tmp/report.md"], active: "file:/tmp/report.md", narrowView: "side", fileLines: { "file:/tmp/report.md": { line: 9, opened: 2 } } });
  agent.closeTab("file:/tmp/report.md");
  expect(useAgentPageUi.getState()).toMatchObject({ tabs: [], active: "page", fileLines: {} });
});

test("The personal agent's file tabs and their lines are remembered across a reload", async () => {
  useAgentPageUi.getState().openFile({ path: "/tmp/report.md", line: 3 });
  const saved = localStorage.getItem("mandate.agent-page.v1");
  useAgentPageUi.setState({ tabs: [], active: "page", fileLines: {} });
  localStorage.setItem("mandate.agent-page.v1", saved!);
  await useAgentPageUi.persist.rehydrate();
  expect(useAgentPageUi.getState()).toMatchObject({ tabs: ["file:/tmp/report.md"], active: "file:/tmp/report.md", fileLines: { "file:/tmp/report.md": { line: 3, opened: 1 } } });
});

// A thread's panel in the order the person dragged its tabs into:
// kept per thread in this browser, read by the close and Reopen rules too.
test("a thread panel's tab order is kept per thread and survives a reload of the store", async () => {
  const panel = useWorkerPanelStore.getState();
  panel.openWorker("thr_a", "w1");
  panel.openCanvas("thr_a", "cnv_c");
  panel.setTabOrder("thr_a", ["canvas:cnv_c", "w1"]);
  expect(useWorkerPanelStore.getState().get("thr_a").order).toEqual(["canvas:cnv_c", "w1"]);
  expect(useWorkerPanelStore.getState().get("thr_b").order).toBeUndefined();
  const raw = localStorage.getItem("mandate.worker-panel.v3") ?? "{}";
  const saved = JSON.parse(raw) as { state: { byThread: Record<string, { order?: string[] }> } };
  expect(saved.state.byThread.thr_a!.order).toEqual(["canvas:cnv_c", "w1"]);
  // Another load of the page: the store empty, what was saved read back.
  useWorkerPanelStore.setState({ byThread: {} });
  localStorage.setItem("mandate.worker-panel.v3", raw);
  await useWorkerPanelStore.persist.rehydrate();
  expect(useWorkerPanelStore.getState().get("thr_a").order).toEqual(["canvas:cnv_c", "w1"]);
});

test("a tab closed with nothing shown before it opens its left neighbour as the order draws it", () => {
  useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: ["w1", "w2", "w3"], active: "w1", workerTab: {}, order: ["w3", "w1", "w2"] } } });
  useWorkerPanelStore.getState().closeTab("thr_a", "w1");
  expect(useWorkerPanelStore.getState().get("thr_a")).toMatchObject({ tabs: ["w2", "w3"], active: "w3" });
});

test("a close told the row as drawn opens its left neighbour there, a reply's; a reopen leaves the order to the panel", () => {
  useReplyTabsStore.setState({ byThread: new Map([["thr_a", [replyTab("r1", "thr_a")]]]), latest: new Map(), applied: new Map() });
  useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: ["w1", "w2"], active: "w2", workerTab: {}, order: ["w1", "reply:r1", "w2"] } } });
  useWorkerPanelStore.getState().closeTab("thr_a", "w2", undefined, ["w1", "reply:r1", "w2"]);
  expect(useWorkerPanelStore.getState().get("thr_a")).toMatchObject({ tabs: ["w1"], active: "reply:r1", order: ["w1", "reply:r1"] });
  useWorkerPanelStore.getState().reopenTab("thr_a", "w2", "reply:r1");
  expect(useWorkerPanelStore.getState().get("thr_a")).toMatchObject({ tabs: ["w1", "w2"], active: "w2", order: ["w1", "reply:r1"] });
});

test("saved panels without an order, or with one that is not a list of strings, load with none", async () => {
  localStorage.setItem("mandate.worker-panel.v3", JSON.stringify({
    state: { byThread: {
      thr_a: { open: true, tabs: ["w1"], active: "w1", workerTab: {} },
      thr_b: { open: true, tabs: ["w1"], active: "w1", workerTab: {}, order: "w1" },
      thr_c: { open: true, tabs: ["w1"], active: "w1", workerTab: {}, order: ["w1", 3] }
    } },
    version: 0
  }));
  await useWorkerPanelStore.persist.rehydrate();
  for (const thread of ["thr_a", "thr_b", "thr_c"]) expect(useWorkerPanelStore.getState().get(thread).order).toBeUndefined();
});

// The personal agent's panel in the order the person dragged its tabs into.
test("the personal agent's tab order is kept and survives a reload", async () => {
  useAgentPageUi.getState().openTasks();
  useAgentPageUi.getState().openCanvas("cnv_c");
  useAgentPageUi.getState().setTabOrder(["canvas:cnv_c", "tasks"]);
  expect(useAgentPageUi.getState().order).toEqual(["canvas:cnv_c", "tasks"]);
  const raw = localStorage.getItem("mandate.agent-page.v1") ?? "{}";
  expect((JSON.parse(raw) as { state: { order?: string[] } }).state.order).toEqual(["canvas:cnv_c", "tasks"]);
  // Another load of the page: the store empty, what was saved read back.
  useAgentPageUi.setState({ order: undefined });
  localStorage.setItem("mandate.agent-page.v1", raw);
  await useAgentPageUi.persist.rehydrate();
  expect(useAgentPageUi.getState().order).toEqual(["canvas:cnv_c", "tasks"]);
});

test("a personal agent's order saved as anything but a list of tab ids loads as none", async () => {
  for (const order of ["tasks", ["tasks", 3], null]) {
    localStorage.setItem("mandate.agent-page.v1", JSON.stringify({ state: { open: true, ratio: 0.5, tabs: ["tasks"], active: "page", order }, version: 0 }));
    await useAgentPageUi.persist.rehydrate();
    expect(useAgentPageUi.getState().order).toBeUndefined();
  }
});

test("a tab closed and opened again later, not by Reopen, comes last in an ordered row", () => {
  useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: ["w1", "canvas:cnv_c"], active: "w1", workerTab: {}, order: ["canvas:cnv_c", "w1"] } } });
  useWorkerPanelStore.getState().closeTab("thr_a", "canvas:cnv_c");
  useWorkerPanelStore.getState().openCanvas("thr_a", "cnv_c");
  const thread = useWorkerPanelStore.getState().get("thr_a");
  expect(orderedIds(thread.tabs, thread.order)).toEqual(["w1", "canvas:cnv_c"]);

  useAgentPageUi.setState({ tabs: ["tasks", "canvas:cnv_c"], active: "page", history: true, order: ["history", "canvas:cnv_c", "tasks"] });
  useAgentPageUi.getState().closeTab("canvas:cnv_c");
  useAgentPageUi.getState().closeHistory();
  useAgentPageUi.getState().openCanvas("cnv_c");
  useAgentPageUi.getState().openHistory();
  // Drawn: History, Tasks, then the canvas, before the order; the order puts Tasks first.
  expect(orderedIds(["history", "tasks", "canvas:cnv_c"], useAgentPageUi.getState().order)).toEqual(["tasks", "history", "canvas:cnv_c"]);
});

// A close that does not come through the panel's row (a canvas deleted, a
// task deleted) reads the order too: it lists every tab once there is one.
test("in an ordered panel a close from elsewhere opens its left neighbour by the order, a server tab's", () => {
  useReplyTabsStore.setState({ byThread: new Map([["thr_a", [replyTab("r1", "thr_a")]]]), latest: new Map(), applied: new Map() });
  useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: ["w1", "w2"], active: "w2", workerTab: {}, order: ["w1", "reply:r1", "w2"] } } });
  useWorkerPanelStore.getState().closeTab("thr_a", "w2");
  expect(useWorkerPanelStore.getState().get("thr_a").active).toBe("reply:r1");

  useThreadTabsStore.setState({ tabs: [{ threadId: "thr_x", createdAt: "2026-10-20T10:06:00.000Z" }], latest: 1, applied: 1 });
  useAgentPageUi.setState({ tabs: ["tasks", "canvas:cnv_a"], active: "canvas:cnv_a", recent: [], order: ["tasks", "thread:thr_x", "canvas:cnv_a"] });
  useAgentPageUi.getState().closeTab("canvas:cnv_a");
  expect(useAgentPageUi.getState().active).toBe("thread:thr_x");
});

// The panel may be hidden (not drawn) when the server's list says a thread
// tab is gone: the order hears it from the list, so the tab comes last if it
// is opened again before the panel shows.
test("a thread tab gone from the server's list leaves the personal agent's order, the panel drawn or not", () => {
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a"], order: ["thread:thr_x", "canvas:cnv_a", "thread:thr_y"] });
  useThreadTabsStore.setState({ tabs: [{ threadId: "thr_y", createdAt: "2026-10-20T10:06:00.000Z" }], latest: 1, applied: 1 });
  expect(useAgentPageUi.getState().order).toEqual(["canvas:cnv_a", "thread:thr_y"]);
});

test("a thread tab the server made again (closed and opened elsewhere while this browser was away) leaves the order, to come last", () => {
  useThreadTabsStore.setState({ tabs: [{ threadId: "thr_x", createdAt: "2026-10-20T10:06:00.000Z" }], latest: 1, applied: 1 });
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a"], order: ["thread:thr_x", "canvas:cnv_a"] });
  useThreadTabsStore.setState({ tabs: [{ threadId: "thr_x", createdAt: "2026-10-21T08:00:00.000Z" }], latest: 2, applied: 2 });
  expect(useAgentPageUi.getState().order).toEqual(["canvas:cnv_a"]);
});

test("in an ordered personal agent's panel a close from elsewhere of the first tab after Page opens Page", () => {
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a", "tasks"], active: "canvas:cnv_a", recent: [], order: ["canvas:cnv_a", "tasks"] });
  useAgentPageUi.getState().closeTab("canvas:cnv_a");
  expect(useAgentPageUi.getState().active).toBe("page");
});

test("History is not restored after a reload, so its place in a saved order is not either", async () => {
  localStorage.setItem("mandate.agent-page.v1", JSON.stringify({ state: { open: true, ratio: 0.5, tabs: ["tasks"], active: "page", order: ["history", "tasks", "thread:thr_x"] }, version: 0 }));
  await useAgentPageUi.persist.rehydrate();
  expect(useAgentPageUi.getState().order).toEqual(["tasks", "thread:thr_x"]);
});

// Two windows of one browser share the saved panels: a save in one about
// something else keeps the drag the other made since.
test("a drag in another window of this browser is kept when this one saves something else; a drag here then wins", () => {
  const key = "mandate.worker-panel.v3";
  useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: ["w1", "w2"], active: "w1", workerTab: {}, order: ["w1", "w2"], orderAt: 1000 } } });
  const other = JSON.parse(localStorage.getItem(key)!) as { state: { byThread: Record<string, { order?: string[]; orderAt?: number }> } };
  other.state.byThread.thr_a!.order = ["w2", "w1"];
  other.state.byThread.thr_a!.orderAt = 2000;
  localStorage.setItem(key, JSON.stringify(other));
  useWorkerPanelStore.getState().setActive("thr_a", "w2");
  const saved = () => JSON.parse(localStorage.getItem(key)!) as { state: { byThread: Record<string, { order?: string[]; active?: string }> } };
  expect([saved().state.byThread.thr_a!.order, saved().state.byThread.thr_a!.active]).toEqual([["w2", "w1"], "w2"]);
  useWorkerPanelStore.getState().setTabOrder("thr_a", ["w1", "w2"]);
  expect(saved().state.byThread.thr_a!.order).toEqual(["w1", "w2"]);

  const agentKey = "mandate.agent-page.v1";
  useAgentPageUi.setState({ tabs: ["tasks", "notes"], order: ["tasks", "notes"], orderAt: 1000 });
  const agentOther = JSON.parse(localStorage.getItem(agentKey)!) as { state: { order?: string[]; orderAt?: number } };
  agentOther.state.order = ["notes", "tasks"];
  agentOther.state.orderAt = 2000;
  localStorage.setItem(agentKey, JSON.stringify(agentOther));
  useAgentPageUi.getState().setActive("tasks");
  expect((JSON.parse(localStorage.getItem(agentKey)!) as { state: { order?: string[] } }).state.order).toEqual(["notes", "tasks"]);
});

test("a thread tab made again while this browser was shut is told by the first list after it opens", async () => {
  localStorage.setItem("mandate.agent-page.v1", JSON.stringify({ state: {
    open: true, ratio: 0.5, tabs: ["notes"], active: "page", order: ["thread:thr_x", "notes"], threadSeen: { "thread:thr_x": "2026-10-20T10:06:00.000Z" }
  }, version: 0 }));
  await useAgentPageUi.persist.rehydrate();
  // The first list since the browser opened (none before it).
  useThreadTabsStore.setState({ tabs: [{ threadId: "thr_x", createdAt: "2026-10-22T09:00:00.000Z" }], latest: 1, applied: 1 });
  expect(useAgentPageUi.getState().order).toEqual(["notes"]);
});

test("a save keeps another window's panels this one never loaded, and the thread times its kept order goes with", () => {
  const key = "mandate.worker-panel.v3";
  useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: ["w1"], active: "w1", workerTab: {} } } });
  const other = JSON.parse(localStorage.getItem(key)!) as { state: { byThread: Record<string, unknown> } };
  other.state.byThread.thr_b = { open: true, tabs: ["w2", "w3"], active: "w2", workerTab: {}, order: ["w3", "w2"], orderAt: 2000 };
  localStorage.setItem(key, JSON.stringify(other));
  useWorkerPanelStore.getState().setActive("thr_a", "w1");
  expect((JSON.parse(localStorage.getItem(key)!) as { state: { byThread: Record<string, { order?: string[] }> } }).state.byThread.thr_b?.order).toEqual(["w3", "w2"]);

  const agentKey = "mandate.agent-page.v1";
  useAgentPageUi.setState({ tabs: ["notes"], order: ["thread:thr_x", "notes"], orderAt: 1000, threadSeen: { "thread:thr_x": "2026-10-20T10:06:00.000Z" } });
  const agentOther = JSON.parse(localStorage.getItem(agentKey)!) as { state: Record<string, unknown> };
  Object.assign(agentOther.state, { order: ["notes", "thread:thr_x"], orderAt: 2000, threadSeen: { "thread:thr_x": "2026-10-22T09:00:00.000Z" } });
  localStorage.setItem(agentKey, JSON.stringify(agentOther));
  useAgentPageUi.getState().setActive("notes");
  const saved = (JSON.parse(localStorage.getItem(agentKey)!) as { state: { order?: string[]; threadSeen?: Record<string, string> } }).state;
  expect([saved.order, saved.threadSeen]).toEqual([["notes", "thread:thr_x"], { "thread:thr_x": "2026-10-22T09:00:00.000Z" }]);
});
