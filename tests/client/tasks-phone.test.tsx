import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { TasksPage } from "@/routes/task-board/TasksPage";
import { useTaskFromAddress } from "@/routes/task-board/task-open";
import { MobileNav } from "@/shell/MobileNav";
import { useTaskBoardStore } from "@/store/task-board";
import { usePersonalAgentStore } from "@/store/personal-agent";
import type { TaskDto } from "@shared/api/task-board";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { fakePhoneWidth } from "../helpers/fake-phone-width.js";
import { jsonResponse, mockFetch, type FetchCall } from "../helpers/fetch.js";
import { mount, settleUntil } from "../helpers/mount.js";
import { taskDetailDto, taskDto } from "../helpers/client-builders.js";
import { resetTaskBoardStore } from "../helpers/task-board.js";

// The Tasks page on a phone: List and Due, a task full screen, its status and
// due date in bottom sheets.

afterEach(() => {
  runCleanups();
  resetTaskBoardStore();
  act(() => { usePersonalAgentStore.setState({ agent: null }); });
});

let at = "";
function Where() {
  at = useLocation().pathname;
  return null;
}

/** happy-dom lays nothing out: every element is told the page's width. */
function measuredAs(width: number) {
  const proto = window.HTMLElement.prototype;
  const rect = Object.getOwnPropertyDescriptor(proto, "getBoundingClientRect");
  Object.defineProperty(proto, "getBoundingClientRect", {
    configurable: true, writable: true,
    value: () => ({ x: 0, y: 0, left: 0, top: 0, width, height: 600, right: width, bottom: 600, toJSON: () => ({}) }) as DOMRect
  });
  onCleanup(() => {
    if (rect) Object.defineProperty(proto, "getBoundingClientRect", rect); else delete (proto as unknown as Record<string, unknown>).getBoundingClientRect;
  });
}

/** `measured`: the page's width as laid out, for a test of what depends on
 *  its room; left out, nothing is measured. */
function render(tasks: TaskDto[], path = "/tasks", measured?: number): { host: HTMLElement; calls: FetchCall[] } {
  onCleanup(fakePhoneWidth(measured ?? 390));
  if (measured) measuredAs(measured);
  const calls = mockFetch((call) => {
    if (call.url.includes("deleted=1")) return jsonResponse({ tasks: [] });
    const body = JSON.parse(String(call.init?.body ?? "{}")) as Record<string, unknown>;
    if (call.method === "PATCH") return jsonResponse({ task: taskDto("tsk_a", { title: "Prices from one source", ...body }) });
    return jsonResponse({ task: taskDetailDto("tsk_a", { title: "Prices from one source" }) });
  });
  act(() => {
    useTaskBoardStore.getState().replaceAll(tasks);
    usePersonalAgentStore.setState({ agent: { threadId: "thr_g", name: "Juno", named: true, unread: false, voiceConfigured: false, lastVisibleSeq: 0, questions: [] } as never });
  });
  const host = mount(
    <MemoryRouter initialEntries={["/tasks", path].filter((p, i, all) => all.indexOf(p) === i)} initialIndex={path === "/tasks" ? 0 : 1}>
      <Where />
      <Routes>
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/tasks/:taskId" element={<TasksPage />} />
      </Routes>
    </MemoryRouter>
  ).host;
  return { host, calls };
}

const has = (host: ParentNode, selector: string) => host.querySelector(selector) !== null;
const button = (el: ParentNode, name: string) => [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name);
const views = (host: HTMLElement) => [...host.querySelectorAll('nav[aria-label="Tasks view"] button')].map((b) => b.textContent);
const two = () => [taskDto("tsk_a", { title: "Prices from one source", status: "progress" }), taskDto("tsk_b", { title: "Docs overhaul" })];

test("no Board on a phone; List is shown", () => {
  const { host } = render(two());
  expect(views(host)).toEqual(["List", "Due"]);
  expect(has(host, '[data-slot="task-column"]')).toBe(false);
  expect(has(host, '[data-slot="task-group"][data-group="progress"]')).toBe(true);
});

test("the board view chosen on a desktop is kept", () => {
  act(() => { useTaskBoardStore.getState().setView("board"); });
  const { host } = render(two());
  expect(has(host, '[data-slot="task-row"]')).toBe(true);
  act(() => { button(host, "Due")!.click(); });
  expect(useTaskBoardStore.getState().view).toBe("due");
  act(() => { useTaskBoardStore.getState().setView("board"); });
  // Shown as List here; still Board for the desktop.
  expect(views(host)).toEqual(["List", "Due"]);
  expect(host.querySelector('nav[aria-label="Tasks view"] [aria-current="page"]')?.textContent).toBe("List");
  expect(useTaskBoardStore.getState().view).toBe("board");
});

test("a task opens full screen; Back returns to the list", async () => {
  const { host } = render(two());
  act(() => { host.querySelector<HTMLElement>('[data-slot="task-row"][data-task-id="tsk_a"]')!.click(); });
  expect(at).toBe("/tasks/tsk_a");
  await settleUntil(() => has(host, '[data-slot="task-stream"]'), "the task's stream");
  // The task alone: no list, no header of views.
  expect(has(host, '[data-slot="task-row"]')).toBe(false);
  expect(has(host, 'nav[aria-label="Tasks view"]')).toBe(false);
  act(() => { button(host.querySelector('[data-slot="task-detail"]')!, "Tasks")!.click(); });
  expect(at).toBe("/tasks");
  expect(has(host, '[data-slot="task-row"]')).toBe(true);
});

test("a task reached by its address goes back to the list", async () => {
  const { host } = render(two(), "/tasks/tsk_a");
  await settleUntil(() => has(host, '[data-slot="task-stream"]'), "the task's stream");
  act(() => { button(host.querySelector('[data-slot="task-detail"]')!, "Tasks")!.click(); });
  expect(at).toBe("/tasks");
});

test("status and due date change in bottom sheets", async () => {
  const { host, calls } = render(two(), "/tasks/tsk_a");
  await settleUntil(() => has(host, '[data-slot="task-stream"]'), "the task's stream");
  act(() => { host.querySelector<HTMLElement>('[data-slot="task-status"]')!.click(); });
  await settleUntil(() => has(document, '[data-slot="task-status-sheet"]'), "the status sheet");
  const sheet = document.querySelector<HTMLElement>('[data-slot="task-status-sheet"]')!;
  expect(sheet.getAttribute("data-state")).toBe("open");
  expect(["Todo", "In progress", "In review", "Done", "Cancelled"].every((name) => button(sheet, name) !== undefined)).toBe(true);
  await act(async () => { button(sheet, "In review")!.click(); });
  await settleUntil(() => calls.some((c) => c.method === "PATCH"), "the status change");
  expect(JSON.parse(String(calls.find((c) => c.method === "PATCH")!.init!.body))).toEqual({ status: "review" });
  // Closed (it may stay drawn while it slides away).
  await settleUntil(() => document.querySelector('[data-slot="task-status-sheet"]')?.getAttribute("data-state") !== "open", "the sheet closing");
  act(() => { host.querySelector<HTMLElement>('[data-slot="task-due-field"]')!.click(); });
  await settleUntil(() => has(document, '[data-slot="task-due-sheet"]'), "the due sheet");
  await act(async () => { button(document.querySelector('[data-slot="task-due-sheet"]')!, "Tomorrow")!.click(); });
  await settleUntil(() => calls.filter((c) => c.method === "PATCH").length === 2, "the due change");
  const due = JSON.parse(String(calls.filter((c) => c.method === "PATCH")[1]!.init!.body)) as { dueDate: string };
  const tomorrow = new Date(Date.now() + 86_400_000);
  expect(due.dueDate).toBe(`${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`);
});

test("the drawer reaches Tasks", () => {
  onCleanup(fakePhoneWidth(390));
  const host = mount(<MobileNav />, { path: "/agent" }).host;
  act(() => { host.querySelector<HTMLElement>('[aria-label="Open navigation"]')!.click(); });
  const link = [...document.querySelectorAll<HTMLAnchorElement>("a")].find((a) => a.textContent?.trim().startsWith("Tasks"));
  expect(link?.getAttribute("href")).toBe("/tasks");
});

// A task reached through the agent's address (a notification, a link from
// elsewhere) has no step of the app's own to go back to: Back is the list, not
// the history.
test("a task opened from the agent's address goes back to the list", async () => {
  onCleanup(fakePhoneWidth(390));
  mockFetch((call) => (call.url.includes("deleted=1") ? jsonResponse({ tasks: [] }) : jsonResponse({ task: taskDetailDto("tsk_a", { title: "Prices from one source" }) })));
  act(() => { useTaskBoardStore.getState().replaceAll(two()); });
  function AgentRoute() {
    useTaskFromAddress();
    return null;
  }
  const host = mount(
    <MemoryRouter initialEntries={["/agent?task=tsk_a"]}>
      <Where />
      <Routes>
        <Route path="/agent" element={<AgentRoute />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/tasks/:taskId" element={<TasksPage />} />
      </Routes>
    </MemoryRouter>
  ).host;
  await settleUntil(() => has(host, '[data-slot="task-stream"]'), "the task's stream");
  expect(at).toBe("/tasks/tsk_a");
  act(() => { button(host.querySelector('[data-slot="task-detail"]')!, "Tasks")!.click(); });
  expect(at).toBe("/tasks");
  expect(has(host, '[data-slot="task-row"]')).toBe(true);
});

// A task reached inside the app by a plain link (a notification, the agent's
// page) goes back where the user was.
test("a task reached inside the app by a plain link goes back where the user was", async () => {
  onCleanup(fakePhoneWidth(390));
  mockFetch((call) => (call.url.includes("deleted=1") ? jsonResponse({ tasks: [] }) : jsonResponse({ task: taskDetailDto("tsk_a", { title: "Prices from one source" }) })));
  act(() => { useTaskBoardStore.getState().replaceAll(two()); });
  function AgentRoute() {
    useTaskFromAddress();
    return null;
  }
  let go: (to: string) => void = () => {};
  function Nav() {
    const navigate = useNavigate();
    go = (to) => { void navigate(to); };
    return null;
  }
  const host = mount(
    <MemoryRouter initialEntries={["/threads/thr_1"]}>
      <Where />
      <Nav />
      <Routes>
        <Route path="/threads/:id" element={null} />
        <Route path="/agent" element={<AgentRoute />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/tasks/:taskId" element={<TasksPage />} />
      </Routes>
    </MemoryRouter>
  ).host;
  for (const link of ["/agent?task=tsk_a", "/tasks/tsk_a"]) {
    act(() => { go(link); });
    await settleUntil(() => has(host, '[data-slot="task-stream"]'), `the task's stream from ${link}`);
    expect(at).toBe("/tasks/tsk_a");
    act(() => { button(host.querySelector('[data-slot="task-detail"]')!, "Tasks")!.click(); });
    expect([link, at]).toEqual([link, "/threads/thr_1"]);
  }
});

// ── A small screen with room ─────────────────────────────────────────────
// Phone mode is every screen under 768 px: a foldable opened and a small
// tablet are in it, with room for a board.

test("a small screen with room for three columns is offered the Board and shows the one kept; a task still opens full screen", async () => {
  const { host } = render(two(), "/tasks", 700);
  expect(views(host)).toEqual(["Board", "List", "Due"]);
  // The view kept is the board, from the start.
  expect([has(host, '[data-slot="task-column"]'), has(host, '[data-slot="task-row"]')]).toEqual([true, false]);
  act(() => { button(host, "List")!.click(); });
  expect([has(host, '[data-slot="task-column"]'), has(host, '[data-slot="task-row"]')]).toEqual([false, true]);
  act(() => { button(host, "Board")!.click(); });
  expect(useTaskBoardStore.getState().view).toBe("board");
  act(() => { host.querySelector<HTMLElement>('[data-slot="task-card"][data-task-id="tsk_a"]')!.click(); });
  expect(at).toBe("/tasks/tsk_a");
  await settleUntil(() => has(host, '[data-slot="task-detail"]'), "the task");
  // The task alone: Back to the board, nothing of the board beside it.
  expect([has(host, '[data-slot="task-column"]'), button(host, "Tasks") !== undefined]).toEqual([false, true]);
});

test("measured at a phone's width the page has List and Due, the board kept shown as List", () => {
  const { host } = render(two(), "/tasks", 390);
  expect(views(host)).toEqual(["List", "Due"]);
  expect([has(host, '[data-slot="task-column"]'), has(host, '[data-slot="task-row"]')]).toEqual([false, true]);
  expect(useTaskBoardStore.getState().view).toBe("board");
});
