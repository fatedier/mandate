import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { AgentPagePane } from "@/routes/personal/page/AgentPagePane";
import { useOpenTask, useTaskFromAddress } from "@/routes/task-board/task-open";
import { resetAgentPageStore } from "@/store/agent-page";
import { useAgentPageUi } from "@/store/agent-page-ui";
import { useTaskBoardStore } from "@/store/task-board";
import { useThreadTabsStore } from "@/store/thread-tabs";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useClosedTabsStore } from "@/store/closed-tabs";
import { TASKS_TAB } from "@/lib/panel-tabs";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { fakePhoneWidth } from "../helpers/fake-phone-width.js";
import { mount, mountAsync, settleUntil, typeInto } from "../helpers/mount.js";
import { managerThreadDto, taskDetailDto, taskDto } from "../helpers/client-builders.js";
import { resetTaskBoardStore } from "../helpers/task-board.js";

// Tasks in the personal agent's panel: the Tasks tab (the board), opened
// from +; and each task in a tab of its own, opened from the board or by any
// task link outside the Tasks page. All closed like a thread tab and kept
// with the others.

const UI = { open: true, maximized: false, ratio: 0.5, narrow: false, narrowView: "chat" as const, tabs: [], active: "page", fileLines: {}, history: false, recent: [], tasksView: { query: "", showCancelled: false } };
afterEach(() => {
  runCleanups();
  resetAgentPageStore();
  resetTaskBoardStore();
  useThreadTabsStore.setState({ tabs: null, latest: 0, applied: 0 });
  useManagerThreadsStore.setState({ threads: new Map(), archived: [] });
  threadTabsServed = [];
  useAgentPageUi.setState(UI);
  useClosedTabsStore.setState({ byPanel: {} });
});

/** The threads open beside the agent, as the server lists them. */
let threadTabsServed: Array<{ threadId: string; createdAt: string }> = [];

function serve() {
  mockFetch((call) => {
    const path = new URL(call.url, "http://x").pathname;
    if (path === "/api/agent-page") return jsonResponse({ latest: null, write: null });
    if (path === "/api/agents/personal/thread-tabs") return jsonResponse({ tabs: threadTabsServed });
    if (path === "/api/agents/threads/thr_g/reply-tabs") return jsonResponse({ tabs: [] });
    if (path === "/api/agent-page/sources") return jsonResponse({ sources: [] });
    const task = path.match(/^\/api\/task-board\/tasks\/(tsk_[^/]+)$/);
    if (task) return jsonResponse({ task: taskDetailDto(task[1]!, { title: "Prices from one source" }) });
    if (path === "/api/task-board/tasks") return jsonResponse({ tasks: [] });
    return jsonResponse({}, 404);
  });
  act(() => { useTaskBoardStore.getState().replaceAll([taskDto("tsk_a", { title: "Prices from one source", status: "progress" }), taskDto("tsk_b", { title: "Docs overhaul" })]); });
}

const tasksTab = (host: ParentNode) => host.querySelector<HTMLElement>('[data-tasks-tab][role="tab"]');
const taskTab = (host: ParentNode, id: string) => host.querySelector<HTMLElement>(`[data-task-tab="${id}"][role="tab"]`);
const taskTabs = (host: ParentNode) => [...host.querySelectorAll<HTMLElement>('[data-task-tab][role="tab"]')].map((tab) => `${tab.getAttribute("data-task-tab")}:${tab.getAttribute("aria-selected")}`);
const shownTask = (host: ParentNode) => host.querySelector('[data-slot="task-detail"]')?.getAttribute("data-task-id") ?? null;
/** The Tasks tab's board drawn: gone while another tab shows, with whatever it had open. */
const boardShown = (host: ParentNode) => host.querySelector('[data-slot="tasks-panel"] [data-slot="task-column"]') !== null;
const has = (host: ParentNode, selector: string) => host.querySelector(selector) !== null;
const button = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label);

async function openAddMenu(host: HTMLElement) {
  await act(async () => {
    host.querySelector<HTMLElement>('[aria-label="Open a thread beside Juno"]')!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

/** A link to a task, as a chip or a tag opens it from here. */
function Opener({ id }: { id: string }) {
  const open = useOpenTask();
  return <button type="button" onClick={() => open(id)}>open {id}</button>;
}

test("+ opens the Tasks tab; it closes like a thread tab", async () => {
  serve();
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  expect(tasksTab(host) === null).toBe(true);
  const items = await openAddMenu(host);
  // Tasks first, then the threads.
  expect(items[0]!.textContent?.trim()).toBe("Tasks");
  await act(async () => { items[0]!.click(); });
  expect(tasksTab(host)?.getAttribute("aria-selected")).toBe("true");
  expect(useAgentPageUi.getState().active).toBe(TASKS_TAB);
  expect(has(host, '[data-slot="task-board-home"]')).toBe(true);
  expect(has(host, '[data-slot="agent-page-body"].hidden')).toBe(true);
  await act(async () => { tasksTab(host)!.querySelector<HTMLElement>('[aria-label="Close Tasks"]')!.click(); });
  expect(tasksTab(host) === null).toBe(true);
  expect(useAgentPageUi.getState().active).toBe("page");
  expect(has(host, '[data-slot="task-board-home"]')).toBe(false);
});

test("a task link opens that task in a tab of its own; asked for again, the same tab", async () => {
  serve();
  const host = (await mountAsync(<><AgentPagePane name="Juno" threadId="thr_g" /><Opener id="tsk_a" /><Opener id="tsk_b" /></>, { path: "/agent" })).host;
  await act(async () => { button(host, "open tsk_a")!.click(); });
  // Its own tab, named by the task with its status; the Tasks tab is not opened for it.
  expect(taskTabs(host)).toEqual(["tsk_a:true"]);
  expect(taskTab(host, "tsk_a")!.textContent).toContain("Prices from one source");
  expect(taskTab(host, "tsk_a")!.querySelector('[data-slot="task-status-icon"]')?.getAttribute("data-status")).toBe("progress");
  expect(tasksTab(host) === null).toBe(true);
  await settleUntil(() => shownTask(host) === "tsk_a", "the task shown in its tab");
  // Another task: a second tab beside the first.
  await act(async () => { button(host, "open tsk_b")!.click(); });
  expect(taskTabs(host)).toEqual(["tsk_a:false", "tsk_b:true"]);
  await settleUntil(() => shownTask(host) === "tsk_b", "the other task shown");
  // The first again: its tab, not a third.
  await act(async () => { button(host, "open tsk_a")!.click(); });
  expect(taskTabs(host)).toEqual(["tsk_a:true", "tsk_b:false"]);
});

test("in the Tasks tab a task opens its own tab; the tab is the task alone, the board stays the board", async () => {
  serve();
  act(() => { useAgentPageUi.setState({ tabs: [TASKS_TAB], active: TASKS_TAB }); });
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  const card = [...host.querySelectorAll<HTMLElement>('[data-slot="task-card"]')].find((c) => c.textContent?.includes("Docs overhaul"))!;
  await act(async () => { card.click(); });
  expect(useAgentPageUi.getState()).toMatchObject({ tabs: [TASKS_TAB, "task:tsk_b"], active: "task:tsk_b" });
  await settleUntil(() => shownTask(host) === "tsk_b", "the task in its tab");
  // The task alone: no board in sight, and neither Back nor Close in it (its tab closes it).
  const detail = host.querySelector<HTMLElement>('[data-slot="task-detail"]')!;
  expect(boardShown(host)).toBe(false);
  expect([button(detail, "Tasks") === undefined, button(detail, "Close") === undefined, button(detail, "Task actions") !== undefined]).toEqual([true, true, true]);
  // Back on the Tasks tab: the board, with no task open in it, maximized or not.
  act(() => { useAgentPageUi.getState().setActive(TASKS_TAB); });
  expect([boardShown(host), has(host, '[data-slot="task-detail"]')]).toEqual([true, false]);
  act(() => { useAgentPageUi.setState({ maximized: true }); });
  expect([boardShown(host), has(host, '[data-slot="task-detail"]')]).toEqual([true, false]);
});

test("the board keeps its search while a task opened from it is read in its own tab", async () => {
  serve();
  act(() => { useAgentPageUi.setState({ tabs: [TASKS_TAB], active: TASKS_TAB }); });
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  const search = () => host.querySelector<HTMLInputElement>('input[aria-label="Search tasks"]')!;
  const cards = () => [...host.querySelectorAll<HTMLElement>('[data-slot="tasks-panel"] [data-slot="task-card"]')].map((c) => c.querySelector('[data-slot="task-title"]')?.textContent ?? c.textContent);
  await typeInto(search() as unknown as HTMLTextAreaElement, "Docs");
  expect(cards().length).toBe(1);
  await act(async () => { host.querySelector<HTMLElement>('[data-slot="tasks-panel"] [data-slot="task-card"]')!.click(); });
  expect(useAgentPageUi.getState().active).toBe("task:tsk_b");
  expect(boardShown(host)).toBe(false);
  // Back on Tasks, by its tab or by closing the task's: the search as it was left.
  await act(async () => { taskTab(host, "tsk_b")!.querySelector<HTMLElement>('[aria-label^="Close"]')!.click(); });
  expect(useAgentPageUi.getState().active).toBe(TASKS_TAB);
  expect([boardShown(host), search().value, cards().length]).toEqual([true, "Docs", 1]);
  // The Tasks tab closed and opened again starts over.
  await act(async () => { tasksTab(host)!.querySelector<HTMLElement>('[aria-label="Close Tasks"]')!.click(); });
  act(() => { useAgentPageUi.getState().openTasks(); });
  expect([search().value, cards().length]).toEqual(["", 2]);
});

test("the board's New task dialog goes with the board when another tab takes the row", async () => {
  serve();
  act(() => { useAgentPageUi.setState({ tabs: [TASKS_TAB], active: TASKS_TAB }); });
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  await act(async () => { button(host, "New task")!.click(); });
  const dialogs = () => document.querySelectorAll('[role="dialog"]').length;
  expect(dialogs()).toBe(1);
  // Another tab shown from outside the dialog (a closed tab reopened by the desktop's shortcut, a task link followed).
  act(() => { useAgentPageUi.getState().openTask("tsk_a"); });
  await settleUntil(() => shownTask(host) === "tsk_a", "the task's tab in sight");
  expect([boardShown(host), dialogs()]).toEqual([false, 0]);
});

// The row is drawn by kind: the tasks' tabs follow the Tasks tab, before the
// threads', the files' and the canvases'.
test("a task's tab sits right after the Tasks tab, in the order opened, and closes back to the tab on its left", async () => {
  threadTabsServed = [{ threadId: "thr_docs", createdAt: "2026-10-20T10:05:00.000Z" }];
  serve();
  act(() => {
    useManagerThreadsStore.setState({ threads: new Map([["thr_docs", managerThreadDto("thr_docs", { title: "Docs layout" })]]) });
    useAgentPageUi.setState({ tabs: [TASKS_TAB, "file:/work/notes.md", "task:tsk_b", "task:tsk_a"], active: "task:tsk_b" });
  });
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  await settleUntil(() => host.querySelector('[data-thread-tab="thr_docs"][role="tab"]') !== null, "the thread's tab");
  const row = () => [...host.querySelectorAll<HTMLElement>('[role="tablist"][aria-label="Page tabs"] [role="tab"]')].map((tab) =>
    (tab.hasAttribute("data-tasks-tab") ? "tasks" : tab.getAttribute("data-task-tab") ?? tab.getAttribute("data-thread-tab") ?? tab.getAttribute("data-file-tab") ?? tab.textContent));
  expect(row()).toEqual(["Page", "tasks", "tsk_b", "tsk_a", "thr_docs", "/work/notes.md"]);
  // Closed while in sight with nothing shown before it: the tab on its left
  // in the row, not the one beside it among the kept tabs (the file's).
  act(() => { useAgentPageUi.setState({ recent: [] }); });
  await act(async () => { taskTab(host, "tsk_b")!.querySelector<HTMLElement>('[aria-label^="Close"]')!.click(); });
  expect(useAgentPageUi.getState().active).toBe(TASKS_TAB);
  expect(row()).toEqual(["Page", "tasks", "tsk_a", "thr_docs", "/work/notes.md"]);
});

test("a task deleted takes its tab with it", async () => {
  serve();
  act(() => { useAgentPageUi.setState({ tabs: ["task:tsk_a", "task:tsk_b"], active: "task:tsk_a" }); });
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  expect(taskTabs(host)).toEqual(["tsk_a:true", "tsk_b:false"]);
  act(() => { useTaskBoardStore.getState().replaceAll([taskDto("tsk_b", { title: "Docs overhaul" })]); });
  await settleUntil(() => !useAgentPageUi.getState().tabs.includes("task:tsk_a"), "the deleted task's tab closed");
  expect(taskTabs(host).map((t) => t.split(":")[0])).toEqual(["tsk_b"]);
  expect(has(host, '[data-slot="task-detail"][data-task-id="tsk_a"]')).toBe(false);
});

// Several tasks deleted at once (all the Done ones, or while the page was
// shut): their tabs close in one pass, and the one in sight goes back to a
// tab that is still there.
test("two tasks deleted together take both tabs, back to the tab before them", async () => {
  serve();
  act(() => { useAgentPageUi.setState({ tabs: [TASKS_TAB, "task:tsk_gone1", "task:tsk_gone2"], active: "task:tsk_gone2", recent: [] }); });
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  await settleUntil(() => useAgentPageUi.getState().tabs.length === 1, "both tabs closed");
  expect(useAgentPageUi.getState()).toMatchObject({ tabs: [TASKS_TAB], active: TASKS_TAB });
  expect(tasksTab(host)?.getAttribute("aria-selected")).toBe("true");
});

test("a task's tab closed comes back from Recently closed, where it stood", async () => {
  serve();
  act(() => { useAgentPageUi.setState({ tabs: ["task:tsk_a", "task:tsk_b"], active: "task:tsk_b" }); });
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  await act(async () => { taskTab(host, "tsk_a")!.querySelector<HTMLElement>('[aria-label^="Close"]')!.click(); });
  expect(taskTabs(host)).toEqual(["tsk_b:true"]);
  await act(async () => {
    host.querySelector<HTMLElement>('[aria-label="Reopen a closed tab"]')!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  const rows = [...document.querySelectorAll<HTMLElement>('[data-slot="recently-closed-menu"] [role="menuitem"]')];
  expect(rows.map((row) => row.querySelector('[data-slot="recently-closed-name"]')?.textContent)).toEqual(["Prices from one source"]);
  await act(async () => { rows[0]!.click(); });
  expect(taskTabs(host)).toEqual(["tsk_a:true", "tsk_b:false"]);
  // One whose task is gone since is not offered.
  await act(async () => { taskTab(host, "tsk_b")!.querySelector<HTMLElement>('[aria-label^="Close"]')!.click(); });
  act(() => { useTaskBoardStore.getState().replaceAll([taskDto("tsk_a", { title: "Prices from one source", status: "progress" })]); });
  expect(host.querySelector('[aria-label="Reopen a closed tab"]') === null).toBe(true);
});

test("/agent?task=<id> opens it and leaves the address clean", async () => {
  let at = "";
  function Where() {
    const location = useLocation();
    at = `${location.pathname}${location.search}`;
    return null;
  }
  function AgentRoute() {
    useTaskFromAddress();
    return <Where />;
  }
  mount(
    <MemoryRouter initialEntries={["/agent?task=tsk_a&from=mail"]}>
      <Routes><Route path="/agent" element={<AgentRoute />} /></Routes>
    </MemoryRouter>
  );
  await settleUntil(() => at === "/agent?from=mail", "the address let go of the task");
  expect(useAgentPageUi.getState()).toMatchObject({ active: "task:tsk_a", tabs: ["task:tsk_a"], open: true });
});

test("elsewhere a task link goes to the agent's page with the task named", async () => {
  let at = "";
  function Where() {
    const location = useLocation();
    at = `${location.pathname}${location.search}`;
    return null;
  }
  const host = mount(
    <MemoryRouter initialEntries={["/threads/thr_1"]}>
      <Routes><Route path="*" element={<><Opener id="tsk_a" /><Where /></>} /></Routes>
    </MemoryRouter>
  ).host;
  await act(async () => { button(host, "open tsk_a")!.click(); });
  expect(at).toBe("/agent?task=tsk_a");
  // On the Tasks page it opens there.
  const page = mount(
    <MemoryRouter initialEntries={["/tasks"]}>
      <Routes><Route path="*" element={<><Opener id="tsk_b" /><Where /></>} /></Routes>
    </MemoryRouter>
  ).host;
  await act(async () => { button(page, "open tsk_b")!.click(); });
  expect(at).toBe("/tasks/tsk_b");
});

test("the Tasks tab and the tasks' tabs persist across reloads with the other tabs", async () => {
  localStorage.setItem("mandate.agent-page.v1", JSON.stringify({ state: { open: true, maximized: false, ratio: 0.5, tabs: [TASKS_TAB, "task:tsk_a", "canvas:cnv_aaaaaaaaaaa", "bogus", "task:"], active: "task:tsk_a", fileLines: {} }, version: 0 }));
  await act(async () => { await useAgentPageUi.persist.rehydrate(); });
  expect(useAgentPageUi.getState().tabs).toEqual([TASKS_TAB, "task:tsk_a", "canvas:cnv_aaaaaaaaaaa"]);
  expect(useAgentPageUi.getState().active).toBe("task:tsk_a");
  localStorage.removeItem("mandate.agent-page.v1");
});

// A task opened before the row is measured (a narrow window, a cold load)
// shows the panel, as a thread opened there does.
test("opening a task turns a narrow row to the panel, measured yet or not", () => {
  act(() => { useAgentPageUi.setState({ narrow: false, narrowView: "chat" }); });
  act(() => { useAgentPageUi.getState().openTask("tsk_a"); });
  expect(useAgentPageUi.getState().narrowView).toBe("side");
});

// An unsent comment and a description being edited survive the tab going
// and coming back.
test("a comment being written and a description being edited outlive switching tabs", async () => {
  serve();
  act(() => { useAgentPageUi.setState({ tabs: ["task:tsk_a"], active: "task:tsk_a" }); });
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  await settleUntil(() => has(host, '[data-slot="task-stream"]'), "the task's stream");
  await typeInto(host.querySelector<HTMLTextAreaElement>('[data-slot="task-comments"] textarea')!, "Half a thought");
  await act(async () => { button(host, "Add a description…")!.click(); });
  await typeInto(host.querySelector<HTMLTextAreaElement>('[data-slot="task-description-input"]')!, "Draft brief");
  act(() => { useAgentPageUi.getState().setActive("page"); });
  expect(has(host, '[data-slot="task-detail"]')).toBe(false);
  act(() => { useAgentPageUi.getState().setActive("task:tsk_a"); });
  await settleUntil(() => has(host, '[data-slot="task-comments"] textarea'), "the task back");
  expect(host.querySelector<HTMLTextAreaElement>('[data-slot="task-comments"] textarea')!.value).toBe("Half a thought");
  expect(host.querySelector<HTMLTextAreaElement>('[data-slot="task-description-input"]')?.value).toBe("Draft brief");
  // Kept for the page's life, so a later test would find them: let go of both.
  await typeInto(host.querySelector<HTMLTextAreaElement>('[data-slot="task-comments"] textarea')!, "");
  await act(async () => { button(host, "Cancel")!.click(); });
});

// A task's tab is closed by its tab, as a canvas's is: Esc leaves it.
test("Esc does not close a task's tab", async () => {
  serve();
  act(() => { useAgentPageUi.setState({ tabs: ["task:tsk_a"], active: "task:tsk_a" }); });
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  await settleUntil(() => shownTask(host) === "tsk_a", "the task in its tab");
  act(() => { document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(useAgentPageUi.getState()).toMatchObject({ tabs: ["task:tsk_a"], active: "task:tsk_a" });
  expect(shownTask(host)).toBe("tsk_a");
});

// ── A phone ──────────────────────────────────────────────────────────────
// The Tasks tab is a phone's too: its List and Due, in the agent's panel. A
// task chosen there opens as every task does on a phone, full screen.

const views = (host: ParentNode) => [...host.querySelectorAll<HTMLElement>('[aria-label="Tasks view"] button')].map((b) => b.textContent?.trim());
const listRow = (host: ParentNode, title: string) => [...host.querySelectorAll<HTMLElement>('[data-slot="tasks-panel"] [data-slot="task-row"]')].find((row) => row.textContent?.includes(title));

test("on a phone + lists Tasks first and opens the Tasks tab, with List and Due; closed, it comes back from Recently closed", async () => {
  onCleanup(fakePhoneWidth());
  serve();
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  const items = await openAddMenu(host);
  expect(items[0]!.textContent?.trim()).toBe("Tasks");
  await act(async () => { items[0]!.click(); });
  expect(tasksTab(host)?.getAttribute("aria-selected")).toBe("true");
  // A phone's width has no room for the board: the list, and Due beside it.
  expect(views(host)).toEqual(["List", "Due"]);
  expect([listRow(host, "Docs overhaul") !== undefined, boardShown(host)]).toEqual([true, false]);
  await act(async () => { tasksTab(host)!.querySelector<HTMLElement>('[aria-label="Close Tasks"]')!.click(); });
  expect(tasksTab(host) === null).toBe(true);
  await act(async () => {
    host.querySelector<HTMLElement>('[aria-label="Reopen a closed tab"]')!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  const rows = [...document.querySelectorAll<HTMLElement>('[data-slot="recently-closed-menu"] [role="menuitem"]')];
  expect(rows.map((row) => row.querySelector('[data-slot="recently-closed-name"]')?.textContent)).toEqual(["Tasks"]);
  await act(async () => { rows[0]!.click(); });
  expect(tasksTab(host)?.getAttribute("aria-selected")).toBe("true");
});

test("on a phone a task chosen in the Tasks tab opens full screen, not in a tab; Back finds the Tasks tab as it was", async () => {
  onCleanup(fakePhoneWidth());
  serve();
  act(() => { useAgentPageUi.setState({ tabs: [TASKS_TAB], active: TASKS_TAB }); });
  let at = "";
  let inApp = false;
  let back: () => void = () => {};
  function Where() {
    const location = useLocation();
    const navigate = useNavigate();
    at = location.pathname;
    inApp = (location.state as { openedInApp?: boolean } | null)?.openedInApp === true;
    back = () => { void navigate(-1); };
    return null;
  }
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={["/agent"]}>
      <Where />
      <Routes>
        <Route path="/agent" element={<AgentPagePane name="Juno" threadId="thr_g" />} />
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>
  );
  await act(async () => { listRow(host, "Docs overhaul")!.click(); });
  // The task's own address, marked as opened from inside the app (its Back
  // comes back here); no tab of its own in the panel.
  expect([at, inApp]).toEqual(["/tasks/tsk_b", true]);
  expect(useAgentPageUi.getState()).toMatchObject({ tabs: [TASKS_TAB], active: TASKS_TAB });
  await act(async () => { back(); });
  await settleUntil(() => at === "/agent", "back on the agent's page");
  expect([tasksTab(host)?.getAttribute("aria-selected"), listRow(host, "Docs overhaul") !== undefined]).toEqual(["true", true]);
});
