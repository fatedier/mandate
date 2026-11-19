import { afterEach, expect, test } from "bun:test";
import { CLOSED_TABS_KEPT, CLOSED_TABS_LISTED, useClosedTabsStore, type ClosedTab } from "@/store/closed-tabs";
import { useAgentPageUi } from "@/store/agent-page-ui";
import { useWorkerPanelStore } from "@/store/worker-panel";
import { TASKS_TAB } from "@/lib/panel-tabs";
import { onReopenClosedTab, reopenClosedTab } from "@/lib/reopen-closed-tab";
import { installDesktopReopenTabIfDesktop } from "@/shell/desktop-reopen-tab-wiring";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";

// A right panel's recently closed tabs: newest first, in memory only, more
// kept than the five listed; and the panel stores putting one back where it
// stood.

afterEach(() => {
  runCleanups();
  useClosedTabsStore.setState({ byPanel: {} });
  localStorage.removeItem("mandate.worker-panel.v3");
  localStorage.removeItem("mandate.agent-page.v1");
  useWorkerPanelStore.setState({ byThread: {}, maximized: null, narrow: false, narrowView: "chat" });
  useAgentPageUi.setState({ open: true, maximized: false, ratio: 0.5, narrow: false, narrowView: "chat", tabs: [], active: "page", fileLines: {}, history: false, recent: [] });
});

const closed = (id: string, at = 1): ClosedTab => ({ id, label: id, icon: null, closedAt: at, after: null });
const ids = (panel: string) => (useClosedTabsStore.getState().byPanel[panel] ?? []).map((t) => t.id);

test("a panel keeps its last twenty closed tabs, newest first, and lists five; one closed again moves to the front", () => {
  const store = useClosedTabsStore.getState();
  for (let n = 0; n < 21; n += 1) store.record("personal", closed(`t${n}`));
  expect([CLOSED_TABS_KEPT, CLOSED_TABS_LISTED]).toEqual([20, 5]);
  expect(ids("personal").length).toBe(20);
  expect(ids("personal").slice(0, 2)).toEqual(["t20", "t19"]);
  expect(ids("personal")).not.toContain("t0");
  useClosedTabsStore.setState({ byPanel: {} });
  for (const id of ["a", "b", "c", "d", "e", "f"]) store.record("personal", closed(id));
  store.record("personal", closed("d", 2));
  expect(ids("personal")).toEqual(["d", "f", "e", "c", "b", "a"]);
  // Each panel its own.
  store.record("thread:thr_a", closed("w1"));
  expect([ids("thread:thr_a"), ids("personal").length]).toEqual([["w1"], 6]);
  store.forget("personal", "f");
  expect(ids("personal")).toEqual(["d", "e", "c", "b", "a"]);
});

test("a reply closed again under a new tab replaces its earlier record: one reply, one row", () => {
  const store = useClosedTabsStore.getState();
  const reply = (id: string, messageId: string): ClosedTab => ({ ...closed(id), reply: { threadId: "thr_g", messageId, text: "Done." } });
  store.record("personal", reply("reply:rtab_1", "msg_1"));
  store.record("personal", closed("canvas:cnv_a"));
  // Opened again from its chat (a new tab), then closed again.
  store.record("personal", reply("reply:rtab_2", "msg_1"));
  store.record("personal", reply("reply:rtab_3", "msg_2"));
  expect(ids("personal")).toEqual(["reply:rtab_3", "reply:rtab_2", "canvas:cnv_a"]);
});

test("nothing is written to the browser's storage", () => {
  const before = Object.keys(localStorage).sort();
  useClosedTabsStore.getState().record("personal", closed("canvas:cnv_a"));
  expect(Object.keys(localStorage).sort()).toEqual(before);
});

test("a canvas reopened in the personal agent's panel comes back after the tab it followed, else first after Tasks, else last", () => {
  const ui = useAgentPageUi.getState();
  useAgentPageUi.setState({ tabs: [TASKS_TAB, "canvas:cnv_a", "file:/src/a.ts"], active: "page" });
  ui.reopenTab("canvas:cnv_b", "canvas:cnv_a");
  expect(useAgentPageUi.getState()).toMatchObject({ tabs: [TASKS_TAB, "canvas:cnv_a", "canvas:cnv_b", "file:/src/a.ts"], active: "canvas:cnv_b", open: true });
  // It led the panel's own tabs: first, but Tasks keeps the front.
  ui.reopenTab("canvas:cnv_c", null);
  expect(useAgentPageUi.getState().tabs).toEqual([TASKS_TAB, "canvas:cnv_c", "canvas:cnv_a", "canvas:cnv_b", "file:/src/a.ts"]);
  // The tab it followed has gone since: the end.
  ui.reopenTab("canvas:cnv_d", "canvas:cnv_gone");
  expect(useAgentPageUi.getState().tabs.at(-1)).toBe("canvas:cnv_d");
  // Open already: it stays where it is, shown.
  ui.reopenTab("canvas:cnv_a", null);
  expect(useAgentPageUi.getState().tabs.indexOf("canvas:cnv_a")).toBe(2);
  expect(useAgentPageUi.getState().active).toBe("canvas:cnv_a");
});

test("a file reopened beside the personal agent points at its lines again; a narrow row turns to the side", () => {
  useAgentPageUi.setState({ narrow: true, narrowView: "chat" });
  useAgentPageUi.getState().reopenTab("file:/src/a.ts", null, { line: 12, end: 20 });
  expect(useAgentPageUi.getState()).toMatchObject({ tabs: ["file:/src/a.ts"], active: "file:/src/a.ts", narrowView: "side" });
  expect(useAgentPageUi.getState().fileLines["file:/src/a.ts"]).toMatchObject({ line: 12, end: 20 });
});

test("a thread's panel puts a reopened tab back after the one it followed, a file at its lines, and turns to the panel", () => {
  const panel = useWorkerPanelStore.getState();
  useWorkerPanelStore.setState({ byThread: { thr_a: { open: false, tabs: ["w1", "canvas:cnv_r"], active: "workers", workerTab: {} } } });
  panel.reopenTab("thr_a", "w2", "w1");
  expect(useWorkerPanelStore.getState().get("thr_a")).toMatchObject({ open: true, tabs: ["w1", "w2", "canvas:cnv_r"], active: "w2" });
  expect(useWorkerPanelStore.getState().narrowView).toBe("panel");
  panel.reopenTab("thr_a", "w0", null);
  expect(useWorkerPanelStore.getState().get("thr_a").tabs).toEqual(["w0", "w1", "w2", "canvas:cnv_r"]);
  panel.reopenTab("thr_a", "file:/src/b.ts", "canvas:cnv_gone", { line: 3 });
  expect(useWorkerPanelStore.getState().get("thr_a").tabs.at(-1)).toBe("file:/src/b.ts");
  expect(useWorkerPanelStore.getState().get("thr_a").fileLines?.["file:/src/b.ts"]).toMatchObject({ line: 3 });
});

test("the desktop's Reopen Closed Tab goes to the panel registered last, then back to the one before when that one goes", () => {
  const calls: string[] = [];
  const first = onReopenClosedTab(() => calls.push("first"));
  const second = onReopenClosedTab(() => calls.push("second"));
  reopenClosedTab();
  second();
  reopenClosedTab();
  first();
  reopenClosedTab();
  expect(calls).toEqual(["second", "first"]);
});

// The menu's event into the page: the desktop app listens, a browser does not.
type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };
function fakeListen() {
  const heard = new Map<string, () => void>();
  return { heard, listen: (event: string, handler: () => void) => { heard.set(event, handler); return Promise.resolve(() => {}); } };
}

test("desktop: File › Reopen Closed Tab reopens through the panel in sight", () => {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
  onCleanup(() => { delete (window as TauriWindow).__TAURI_INTERNALS__; });
  const { heard, listen } = fakeListen();
  installDesktopReopenTabIfDesktop(listen);
  let reopened = 0;
  onCleanup(onReopenClosedTab(() => { reopened += 1; }));
  heard.get("mandate:reopen-closed-tab")?.();
  expect(reopened).toBe(1);
});

test("browser: nothing listens; the browser keeps the key", () => {
  const { heard, listen } = fakeListen();
  installDesktopReopenTabIfDesktop(listen);
  expect(heard.size).toBe(0);
});
