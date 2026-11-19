import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { TasksPage } from "@/routes/task-board/TasksPage";
import { TasksNavRow } from "@/shell/TasksNavRow";
import { useTaskBoardStore } from "@/store/task-board";
import { resetTaskBoardStore } from "../helpers/task-board.js";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { useConfirmStore } from "@/components/confirm-action";
import type { TaskDto } from "@shared/api/task-board";
import { runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch, type FetchCall } from "../helpers/fetch.js";
import { mount, settle, settleUntil, typeInto } from "../helpers/mount.js";
import { taskDto } from "../helpers/client-builders.js";

// The Tasks page: the board (the default), List and Due, search, New task,
// Delete all Done and Recently deleted.

afterEach(() => {
  runCleanups();
  resetTaskBoardStore();
  act(() => {
    usePersonalAgentStore.setState({ agent: null });
    useConfirmStore.setState({ pending: null, resolver: null, returnFocus: null });
  });
});

/** A day `offset` days from today, as the board writes it (local time). */
function day(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** A due date as a card writes it: the year only when it is not this one. */
const monthDay = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return y === new Date().getFullYear() ? date : `${date}, ${y}`;
};
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

let locationSearch = "";
function Where() {
  locationSearch = useLocation().search;
  return null;
}

function render(tasks: TaskDto[], answer: (call: FetchCall) => Response = () => jsonResponse({ tasks: [] }), at = "/tasks"): { host: HTMLElement; calls: FetchCall[] } {
  const calls = mockFetch((call) => answer(call));
  act(() => {
    useTaskBoardStore.getState().replaceAll(tasks);
    usePersonalAgentStore.setState({ agent: { threadId: "thr_g", name: "Juno", named: true, unread: false, voiceConfigured: false, lastVisibleSeq: 0, questions: [] } as never });
  });
  const host = mount(
    <MemoryRouter initialEntries={[at]}>
      <Where />
      <Routes>
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/tasks/:taskId" element={<TasksPage />} />
      </Routes>
    </MemoryRouter>
  ).host;
  return { host, calls };
}

const columns = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[data-slot="task-column"]')].map((c) => c.dataset.status);
const card = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-slot="task-card"][data-task-id="${id}"]`);
const has = (host: ParentNode, selector: string) => host.querySelector(selector) !== null;
const button = (el: ParentNode, name: string) => [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name);
const click = (el: HTMLElement) => act(() => { el.click(); });
const press = async (el: HTMLElement) => {
  await act(async () => {
    el.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
};
const menuItem = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) => m.textContent?.trim() === name);
const bodyOf = (call: FetchCall) => JSON.parse(String(call.init?.body ?? "null")) as unknown;

const five = () => [
  taskDto("tsk_a", { title: "Bill bakery orders weekly", status: "todo" }),
  taskDto("tsk_b", { title: "Prices from one source", status: "progress" }),
  taskDto("tsk_c", { title: "Docs overhaul", status: "review", result: "Rewrote the guide." }),
  taskDto("tsk_d", { title: "Ship 3.21", status: "done" }),
  taskDto("tsk_e", { title: "Old idea", status: "cancelled" })
];

test("an address naming a label opens the board filtered to it and leaves the address", () => {
  act(() => useTaskBoardStore.setState({ filters: { labels: [], due: ["week"] } }));
  const { host } = render([
    taskDto("tsk_a", { title: "Bill bakery orders weekly", status: "todo", labels: [{ name: "Atlas-API", by: "auto" }] }),
    taskDto("tsk_b", { title: "Prices from one source", status: "progress", labels: [{ name: "atlas-api", by: "owner" }] }),
    taskDto("tsk_c", { title: "Docs overhaul", status: "review", labels: [{ name: "search-server", by: "auto" }] })
  ], undefined, "/tasks?label=atlas-api");
  expect([card(host, "tsk_a"), card(host, "tsk_b"), card(host, "tsk_c")].map((c) => c !== null)).toEqual([true, true, false]);
  expect(useTaskBoardStore.getState().filters).toEqual({ labels: ["atlas-api"], due: [] });
  expect(locationSearch).toBe("");
});

test("opens on the board with four columns, Backlog folded above them, cancelled behind a count", () => {
  const { host } = render([...five(), taskDto("tsk_g", { title: "Second price source", status: "backlog" })]);
  // Backlog: its heading alone above the board, until opened by hand.
  const shelf = host.querySelector<HTMLElement>('[data-slot="task-board-folded"]')!;
  expect(shelf.querySelector('[data-slot="task-column"][data-status="backlog"]')?.textContent).toBe("Backlog1");
  expect(card(host, "tsk_g") === null).toBe(true);
  expect(columns(host)).toEqual(["backlog", "todo", "progress", "review", "done"]);
  expect(card(host, "tsk_c") !== null).toBe(true);
  expect(card(host, "tsk_e") === null).toBe(true);
  const foot = host.querySelector<HTMLElement>('[data-slot="tasks-foot"]')!;
  expect(foot.textContent).toContain("1 cancelled");
  click(button(foot, "Show cancelled")!);
  expect(columns(host)).toEqual(["backlog", "todo", "progress", "review", "done", "cancelled"]);
  expect(card(host, "tsk_e") !== null).toBe(true);
  click(button(foot, "Hide cancelled")!);
  expect(card(host, "tsk_e") === null).toBe(true);
  // The page says how many are open: Backlog is not.
  expect(host.textContent).toContain("3 open");
  // Opened, Backlog is the first column, and stays open.
  click(shelf.querySelector<HTMLButtonElement>('[data-slot="task-column-fold"]')!);
  expect([has(host, '[data-slot="task-board-folded"]'), columns(host), card(host, "tsk_g") !== null]).toEqual([false, ["backlog", "todo", "progress", "review", "done"], true]);
  expect(useTaskBoardStore.getState().boardFolded).toEqual({ backlog: false });
});

test("a card shows Needs you, its due label and the latest comment, or the Result in In review and Done", () => {
  const { host } = render([
    taskDto("tsk_a", {
      title: "Prices from one source", status: "progress", dueDate: day(-1),
      marks: { needsYou: true, failed: false, quiet: false },
      lastComment: { by: "agent", text: "Opened a **thread** for it.\nMore below.", at: hoursAgo(2.5) },
      threads: [
        { threadId: "thr_1", title: "Pantry page", dot: "needs_you", archived: false, lastReply: "Which one?", lastReplyAt: hoursAgo(1) },
        { threadId: "thr_2", title: "Price data", dot: "working", archived: false, lastReply: null, lastReplyAt: null },
        { threadId: "thr_3", title: "Third", dot: "idle", archived: false, lastReply: null, lastReplyAt: null }
      ]
    }),
    taskDto("tsk_r", { title: "Docs overhaul", status: "review", dueDate: day(0), result: "## Rewrote the guide\nAnd more.", lastComment: { by: "owner", text: "Looks right?", at: hoursAgo(1) } }),
    taskDto("tsk_d", { title: "Ship 3.21", status: "done", dueDate: day(-3), result: "**Shipped**: the release notes, see `release.log`.\n\nMore.", marks: { needsYou: true, failed: false, quiet: false } })
  ]);
  const a = card(host, "tsk_a")!;
  expect(a.querySelector('[data-slot="task-needs-you"]')?.textContent).toBe("Needs you");
  expect(a.querySelector('[data-slot="task-due"]')?.textContent).toBe(`Overdue · ${monthDay(day(-1))}`);
  // A calendar beside it, as the task's Due field has: it reads as a date.
  expect(a.querySelector('[data-slot="task-due"] svg') === null).toBe(false);
  expect(a.querySelector('[data-slot="task-note"]')?.textContent).toBe("Juno · Opened a thread for it.");
  // Two threads, then how many more.
  expect([...a.querySelectorAll('[data-slot="task-thread"]')].map((t) => t.textContent)).toEqual(["Pantry page", "Price data"]);
  expect(a.textContent).toContain("+1");
  const r = card(host, "tsk_r")!;
  expect(r.querySelector('[data-slot="task-due"]')?.textContent).toBe("Today");
  expect(r.querySelector('[data-slot="task-note"]')?.textContent).toBe("Result · Rewrote the guide");
  // Done: the Result; no due label, no Needs you.
  const d = card(host, "tsk_d")!;
  // In its words: the Markdown's marks are not drawn.
  expect(d.querySelector('[data-slot="task-note"]')?.textContent).toBe("Result · Shipped: the release notes, see release.log.");
  expect(has(d, '[data-slot="task-due"]')).toBe(false);
  expect(has(d, '[data-slot="task-needs-you"]')).toBe(false);
});

test("dragging a card to In review patches its status", async () => {
  const { host, calls } = render(five(), (call) => (call.method === "PATCH" ? jsonResponse({ task: taskDto("tsk_a", { status: "review" }) }) : jsonResponse({ tasks: [] })));
  const review = host.querySelector<HTMLElement>('[data-slot="task-column"][data-status="review"]')!;
  await act(async () => {
    card(host, "tsk_a")!.dispatchEvent(new CustomEvent("dragstart", { bubbles: true }));
    review.dispatchEvent(new CustomEvent("dragover", { bubbles: true, cancelable: true }));
    review.dispatchEvent(new CustomEvent("drop", { bubbles: true, cancelable: true }));
  });
  await settleUntil(() => calls.some((c) => c.method === "PATCH"), "the status patch");
  const patch = calls.find((c) => c.method === "PATCH")!;
  expect(patch.url).toEndWith("/api/task-board/tasks/tsk_a");
  expect(bodyOf(patch)).toEqual({ status: "review" });
  // Dropped on its own column: nothing is asked.
  await act(async () => {
    card(host, "tsk_b")!.dispatchEvent(new CustomEvent("dragstart", { bubbles: true }));
    host.querySelector('[data-slot="task-column"][data-status="progress"]')!.dispatchEvent(new CustomEvent("drop", { bubbles: true, cancelable: true }));
  });
  await settle(5);
  expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
});

test("a column folds away to its heading above the board, from its heading, and opens again; folded, it still takes a card dropped on it", async () => {
  const { host, calls } = render(
    [...five(), taskDto("tsk_f", { title: "Sharpen the bread knives", status: "done" })],
    (call) => (call.method === "PATCH" ? jsonResponse({ task: taskDto("tsk_a", { status: "done" }) }) : jsonResponse({ tasks: [] }))
  );
  const column = (status: string) => host.querySelector<HTMLElement>(`[data-slot="task-column"][data-status="${status}"]`)!;
  const heading = (status: string) => column(status).querySelector<HTMLButtonElement>('[data-slot="task-column-fold"]')!;
  const seen = (status: string) => [column(status).dataset.folded, heading(status).getAttribute("aria-expanded"), column(status).querySelectorAll('[data-slot="task-card"]').length];
  // The heading is the control: its words, with the column open.
  expect([heading("done").textContent, ...seen("done")]).toEqual(["Done2", undefined, "true", 2]);
  click(heading("done"));
  // Its heading alone, in the row above the columns: no card, and no menu of what to do with them.
  expect(seen("done")).toEqual(["true", "false", 0]);
  expect([heading("done").textContent, button(column("done"), "Done actions")]).toEqual(["Done2", undefined]);
  const shelf = host.querySelector<HTMLElement>('[data-slot="task-board-folded"]')!;
  expect([shelf.contains(column("done")), host.querySelector('[data-slot="task-board"]')!.contains(column("done")), columns(host)]).toEqual([true, false, ["backlog", "done", "todo", "progress", "review"]]);
  // The others are as they were, and the fold is the board's own: the list's are not touched.
  expect([seen("todo"), useTaskBoardStore.getState().boardFolded, useTaskBoardStore.getState().folded]).toEqual([[undefined, "true", 1], { done: true }, { done: true }]);
  await act(async () => {
    card(host, "tsk_a")!.dispatchEvent(new CustomEvent("dragstart", { bubbles: true }));
    column("done").dispatchEvent(new CustomEvent("dragover", { bubbles: true, cancelable: true }));
    column("done").dispatchEvent(new CustomEvent("drop", { bubbles: true, cancelable: true }));
  });
  await settleUntil(() => calls.some((c) => c.method === "PATCH"), "the status patch");
  expect(bodyOf(calls.find((c) => c.method === "PATCH")!)).toEqual({ status: "done" });
  // Opened again by hand: back in its place; above the board only Backlog, folded until opened.
  click(heading("done"));
  expect([seen("done")[0], seen("done")[1], button(column("done"), "Done actions") !== undefined]).toEqual([undefined, "true", true]);
  expect([columns(host), shelf.textContent, useTaskBoardStore.getState().boardFolded]).toEqual([["backlog", "todo", "progress", "review", "done"], "Backlog0", { done: false }]);
});

// The latest finished first in Done (and Cancelled); the open columns by
// due date, the soonest first, those with none after, the oldest first.
test("a column's order: Done the latest finished first, the others by due date, then the oldest", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 10, 1, h)).toISOString();
  const { host } = render([
    taskDto("tsk_d1", { status: "done", createdAt: at(1), statusAt: at(5) }),
    taskDto("tsk_d2", { status: "done", createdAt: at(2), statusAt: at(9) }),
    taskDto("tsk_d3", { status: "done", createdAt: at(3), statusAt: at(7) }),
    taskDto("tsk_t1", { status: "todo", createdAt: at(1) }),
    taskDto("tsk_t2", { status: "todo", createdAt: at(2), dueDate: day(5) }),
    taskDto("tsk_t3", { status: "todo", createdAt: at(3), dueDate: day(1), dueTime: "15:00" }),
    taskDto("tsk_t4", { status: "todo", createdAt: at(4), dueDate: day(1), dueTime: "09:00" }),
    taskDto("tsk_t5", { status: "todo", createdAt: at(0) })
  ]);
  const order = (status: string) => [...host.querySelectorAll(`[data-slot="task-column"][data-status="${status}"] [data-slot="task-card"]`)].map((c) => c.getAttribute("data-task-id"));
  expect([order("done"), order("todo")]).toEqual([["tsk_d2", "tsk_d3", "tsk_d1"], ["tsk_t4", "tsk_t3", "tsk_t2", "tsk_t5", "tsk_t1"]]);
  // The list orders its groups the same way.
  click(button(host, "List")!);
  const rows = (group: string) => [...host.querySelectorAll(`[data-slot="task-group"][data-group="${group}"] [data-slot="task-row"]`)].map((r) => r.getAttribute("data-task-id"));
  expect(rows("todo")).toEqual(["tsk_t4", "tsk_t3", "tsk_t2", "tsk_t5", "tsk_t1"]);
  click(host.querySelector<HTMLButtonElement>('[data-slot="task-group"][data-group="done"] [data-slot="task-group-toggle"]')!);
  expect(rows("done")).toEqual(["tsk_d2", "tsk_d3", "tsk_d1"]);
});

// A card's "⋯" holds the task's actions, as its own page's does: its status
// and its due date (each a submenu) change there and then, with no drag and
// without opening it; Rename and Ask open it ready for them; Delete asks.
const actionsOf = (el: Element) => el.querySelector<HTMLElement>('[data-slot="task-actions"]')!;
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((m) => m.textContent?.trim());
const patchAnswer = (call: FetchCall) => (call.method === "PATCH" ? jsonResponse({ task: taskDto("tsk_a", { status: "review" }) }) : jsonResponse({ tasks: [] }));

test("a card's ⋯ holds the task's actions: Status and Due change it there and then, the task not opened", async () => {
  const { host, calls } = render(five(), patchAnswer);
  const actions = actionsOf(card(host, "tsk_a")!);
  expect(actions.getAttribute("aria-label")).toBe("Task actions");
  await press(actions);
  expect(items()).toEqual(["Status", "Due", "Rename", "Ask Juno", "Delete task"]);
  await act(async () => { menuItem("Status")!.click(); });
  expect(items().slice(5)).toEqual(["Backlog", "Todo", "In progress", "In review", "Done", "Cancelled"]);
  await act(async () => { menuItem("In review")!.click(); });
  await settleUntil(() => calls.some((c) => c.method === "PATCH"), "the status patch");
  expect(bodyOf(calls.find((c) => c.method === "PATCH")!)).toEqual({ status: "review" });
  expect([has(host, '[data-slot="task-detail"]'), has(document, '[role="menu"]')]).toEqual([false, false]);
  await press(actionsOf(card(host, "tsk_b")!));
  await act(async () => { menuItem("Due")!.click(); });
  expect(items().slice(5)).toEqual(["Today", "Tomorrow", "Next week"]);
  await act(async () => { menuItem("Tomorrow")!.click(); });
  await settleUntil(() => calls.filter((c) => c.method === "PATCH").length === 2, "the due patch");
  expect(bodyOf(calls.filter((c) => c.method === "PATCH")[1]!)).toEqual({ dueDate: day(1), dueTime: null });
  expect(has(host, '[data-slot="task-detail"]')).toBe(false);
});

test("a right-click on a card opens the same actions", async () => {
  const { host } = render(five());
  await act(async () => { card(host, "tsk_a")!.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  await settleUntil(() => menuItem("Status") !== undefined, "the actions");
  expect(items()).toEqual(["Status", "Due", "Rename", "Ask Juno", "Delete task"]);
});

test("Rename and Ask from a card's ⋯ open the task ready for them; Delete task asks first", async () => {
  const { host, calls } = render(five(), (call) => (call.method === "DELETE" ? jsonResponse({ ok: true }) : jsonResponse({ tasks: [] })));
  await press(actionsOf(card(host, "tsk_a")!));
  await act(async () => { menuItem("Rename")!.click(); });
  await settleUntil(() => has(host, '[data-slot="task-title-input"]'), "the title field");
  expect(host.querySelector('[data-slot="task-detail"]')!.getAttribute("data-task-id")).toBe("tsk_a");
  await press(actionsOf(card(host, "tsk_b")!));
  await act(async () => { menuItem("Ask Juno")!.click(); });
  await settleUntil(() => host.querySelector<HTMLTextAreaElement>('[data-slot="task-detail"][data-task-id="tsk_b"] [data-slot="task-comments"] textarea')?.value === "@Juno ", "the box started with @Juno");
  await press(actionsOf(card(host, "tsk_c")!));
  await act(async () => { menuItem("Delete task")!.click(); });
  expect(useConfirmStore.getState().pending).toMatchObject({ title: "Delete this task?", description: "“Docs overhaul” moves to Recently deleted. Its threads stay as they are." });
  await act(async () => { useConfirmStore.getState().resolve(true); });
  await settleUntil(() => calls.some((c) => c.method === "DELETE"), "the delete");
  expect(calls.find((c) => c.method === "DELETE")!.url).toEndWith("/api/task-board/tasks/tsk_c");
});

// One request after another on a task already open, each taken.
test("Rename, then Ask, from the card of the task already open: each is taken", async () => {
  const { host } = render(five());
  await press(actionsOf(card(host, "tsk_a")!));
  await act(async () => { menuItem("Rename")!.click(); });
  await settleUntil(() => has(host, '[data-slot="task-title-input"]'), "the title field");
  const input = host.querySelector<HTMLInputElement>('[data-slot="task-title-input"]')!;
  act(() => { input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  await settleUntil(() => !has(host, '[data-slot="task-title-input"]'), "the rename closed");
  await press(actionsOf(card(host, "tsk_a")!));
  await act(async () => { menuItem("Ask Juno")!.click(); });
  await settleUntil(() => host.querySelector<HTMLTextAreaElement>('[data-slot="task-detail"][data-task-id="tsk_a"] [data-slot="task-comments"] textarea')?.value === "@Juno ", "the box started with @Juno");
  await press(actionsOf(card(host, "tsk_a")!));
  await act(async () => { menuItem("Rename")!.click(); });
  await settleUntil(() => has(host, '[data-slot="task-title-input"]'), "the title field again");
});

test("a list row has the same actions", async () => {
  const { host, calls } = render(five(), patchAnswer);
  click(button(host, "List")!);
  const row = host.querySelector<HTMLElement>('[data-slot="task-row"][data-task-id="tsk_a"]')!;
  await press(actionsOf(row));
  await act(async () => { menuItem("Status")!.click(); });
  await act(async () => { menuItem("In review")!.click(); });
  await settleUntil(() => calls.some((c) => c.method === "PATCH"), "the status patch");
  expect(bodyOf(calls.find((c) => c.method === "PATCH")!)).toEqual({ status: "review" });
  expect(has(host, '[data-slot="task-detail"]')).toBe(false);
});

test("List groups by status; Due groups Overdue, Today, This week, Later, No due date", () => {
  const { host } = render([
    taskDto("tsk_1", { title: "Late", status: "progress", dueDate: day(-2) }),
    taskDto("tsk_2", { title: "Now", status: "todo", dueDate: day(0) }),
    taskDto("tsk_3", { title: "Soon", status: "review", dueDate: day(3) }),
    taskDto("tsk_4", { title: "Far", status: "todo", dueDate: day(20) }),
    taskDto("tsk_5", { title: "Whenever", status: "todo" }),
    taskDto("tsk_6", { title: "Finished", status: "done", dueDate: day(-5) }),
    taskDto("tsk_7", { title: "Kept for later", status: "backlog", dueDate: day(0) })
  ]);
  click(button(host, "List")!);
  const groups = () => [...host.querySelectorAll<HTMLElement>('[data-slot="task-group"]')].map((g) => [g.dataset.group, [...g.querySelectorAll('[data-slot="task-row"]')].map((r) => r.getAttribute("data-task-id"))]);
  // Backlog and Done start folded: their heading and count, no rows.
  expect(groups()).toEqual([
    ["backlog", []],
    ["todo", ["tsk_2", "tsk_4", "tsk_5"]],
    ["progress", ["tsk_1"]],
    ["review", ["tsk_3"]],
    ["done", []]
  ]);
  click(button(host, "Due")!);
  // Open tasks only (not Backlog's); a group with none is left out.
  expect(groups()).toEqual([
    ["overdue", ["tsk_1"]],
    ["today", ["tsk_2"]],
    ["week", ["tsk_3"]],
    ["later", ["tsk_4"]],
    ["none", ["tsk_5"]]
  ]);
  expect([...host.querySelectorAll('[data-slot="task-group"] h2')].map((h) => h.textContent?.replace(/\d+$/, "").trim())).toEqual(["Overdue", "Today", "This week", "Later", "No due date"]);
  // The view chosen last is kept.
  expect(useTaskBoardStore.getState().view).toBe("due");
});

test("an empty status group says so", () => {
  const { host } = render([taskDto("tsk_1", { status: "progress" })]);
  click(button(host, "List")!);
  const text = (group: string) => host.querySelector(`[data-slot="task-group"][data-group="${group}"]`)?.textContent ?? "";
  expect(text("todo")).toContain("Nothing waiting to start.");
  expect(text("review")).toContain("None.");
});

test("search narrows by title and description", async () => {
  const { host } = render([
    taskDto("tsk_a", { title: "Bill bakery orders weekly" }),
    taskDto("tsk_b", { title: "Prices", description: "Use one SOURCE for the pantry page." }),
    taskDto("tsk_c", { title: "Docs overhaul" })
  ]);
  const search = host.querySelector<HTMLInputElement>('input[aria-label="Search tasks"]')!;
  await typeInto(search, "source");
  expect([...host.querySelectorAll<HTMLElement>('[data-slot="task-card"]')].map((c) => c.dataset.taskId)).toEqual(["tsk_b"]);
  await typeInto(search, "bill");
  expect([...host.querySelectorAll<HTMLElement>('[data-slot="task-card"]')].map((c) => c.dataset.taskId)).toEqual(["tsk_a"]);
});

test("Delete all Done asks, then deletes", async () => {
  const { host, calls } = render([...five(), taskDto("tsk_f", { status: "done" })], (call) => (call.method === "DELETE" ? jsonResponse({ deleted: 2 }) : jsonResponse({ tasks: [] })));
  const done = host.querySelector<HTMLElement>('[data-slot="task-column"][data-status="done"]')!;
  await press(button(done, "Done actions")!);
  await act(async () => { menuItem("Delete all Done")!.click(); });
  expect(useConfirmStore.getState().pending).toEqual({
    title: "Delete 2 done tasks?",
    description: "They move to Recently deleted. Their threads stay as they are.",
    confirmLabel: "Delete"
  });
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  await act(async () => { useConfirmStore.getState().resolve(true); });
  await settleUntil(() => calls.some((c) => c.method === "DELETE"), "the delete");
  expect(calls.find((c) => c.method === "DELETE")!.url).toEndWith("/api/task-board/done");
});

test("Recently deleted restores", async () => {
  const gone = taskDto("tsk_x", { title: "Gone task", deletedAt: hoursAgo(3) });
  const { host, calls } = render(five(), (call) => {
    if (call.method === "POST") return jsonResponse({ task: { ...gone, deletedAt: null } });
    return jsonResponse({ tasks: call.url.includes("deleted=1") ? [gone] : [] });
  });
  await settleUntil(() => button(host, "Recently deleted (1)") !== undefined, "the deleted count");
  click(button(host, "Recently deleted (1)")!);
  const list = host.querySelector<HTMLElement>('[data-slot="tasks-deleted"]')!;
  expect(list.textContent).toContain("Gone task");
  // Kept until deleted forever: no time limit to name.
  expect(list.textContent).not.toContain("30 days");
  click(button(list, "Restore")!);
  await settleUntil(() => calls.some((c) => c.method === "POST"), "the restore");
  expect(calls.find((c) => c.method === "POST")!.url).toEndWith("/api/task-board/tasks/tsk_x/restore");
  await settleUntil(() => (host.querySelector('[data-slot="tasks-deleted"]')?.textContent ?? "").includes("Nothing deleted."), "the empty list");
});

test("Recently deleted: the search narrows it; Delete forever asks, then deletes for good", async () => {
  const gone = [
    taskDto("tsk_x", { title: "Gone task", deletedAt: hoursAgo(3) }),
    taskDto("tsk_y", { title: "Old plan", description: "About the SOURCE of prices.", deletedAt: hoursAgo(5) })
  ];
  const { host, calls } = render(five(), (call) => (call.method === "DELETE" ? jsonResponse({ ok: true }) : jsonResponse({ tasks: call.url.includes("deleted=1") ? gone : [] })));
  await settleUntil(() => button(host, "Recently deleted (2)") !== undefined, "the deleted count");
  click(button(host, "Recently deleted (2)")!);
  const list = () => host.querySelector<HTMLElement>('[data-slot="tasks-deleted"]')!;
  const rows = () => [...list().querySelectorAll<HTMLElement>('[data-slot="task-deleted-row"]')];
  const titles = () => rows().map((row) => row.querySelector("span.truncate")?.textContent);
  expect(titles()).toEqual(["Gone task", "Old plan"]);
  // The board's search box narrows the list, by title and by description.
  const search = host.querySelector<HTMLInputElement>('input[aria-label="Search tasks"]')!;
  await typeInto(search, "source");
  expect(titles()).toEqual(["Old plan"]);
  expect(list().querySelector("h2")!.textContent).toContain("1");
  await typeInto(search, "gone");
  expect(titles()).toEqual(["Gone task"]);
  // Nothing found is not "nothing deleted".
  await typeInto(search, "no such words");
  expect(titles()).toEqual([]);
  expect(list().textContent).not.toContain("Nothing deleted.");
  await typeInto(search, "");
  expect(titles()).toEqual(["Gone task", "Old plan"]);
  // Delete forever asks first; a No does nothing.
  click(button(rows()[0]!, "Delete forever")!);
  expect(useConfirmStore.getState().pending).toEqual({ title: "Delete “Gone task” forever?", description: "This can't be undone.", confirmLabel: "Delete forever" });
  await act(async () => { useConfirmStore.getState().resolve(false); });
  await settle();
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  expect(titles()).toEqual(["Gone task", "Old plan"]);
  click(button(rows()[0]!, "Delete forever")!);
  await act(async () => { useConfirmStore.getState().resolve(true); });
  await settleUntil(() => calls.some((c) => c.method === "DELETE"), "the delete");
  expect(calls.find((c) => c.method === "DELETE")!.url).toEndWith("/api/task-board/tasks/tsk_x/forever");
  await settleUntil(() => titles().length === 1, "the row gone");
  expect(titles()).toEqual(["Old plan"]);
});

test("New task creates with a description and a due date", async () => {
  const { host, calls } = render([], (call) => (call.method === "POST" ? jsonResponse({ task: taskDto("tsk_n", { title: "Bill bakery orders" }) }, 201) : jsonResponse({ tasks: [] })));
  expect(host.textContent).toContain("No tasks yet. Create one with New task, or ask Juno to note one down.");
  click(button(host, "New task")!);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const create = button(dialog, "Create task")!;
  expect(create.disabled).toBe(true);
  await typeInto(dialog.querySelector<HTMLInputElement>('input[placeholder="What needs to happen?"]')!, "Bill bakery orders");
  await typeInto(dialog.querySelector<HTMLTextAreaElement>("textarea")!, "Weekly, not daily.");
  click(button(dialog, "Tomorrow")!);
  expect(dialog.textContent).toContain("Nobody is told. When it should start, mention @Juno in a comment.");
  click(button(dialog, "Create task")!);
  await settleUntil(() => calls.some((c) => c.method === "POST"), "the create");
  const post = calls.find((c) => c.method === "POST")!;
  expect(post.url).toEndWith("/api/task-board/tasks");
  expect(bodyOf(post)).toEqual({ title: "Bill bakery orders", description: "Weekly, not daily.", dueDate: day(1), dueTime: null });
  await settleUntil(() => document.querySelector('[role="dialog"]') === null, "the dialog closing");
});

test("the sidebar's Tasks row counts open tasks that need you, and nothing when none does", () => {
  const needs = { needsYou: true, failed: false, quiet: false };
  act(() => {
    useTaskBoardStore.getState().replaceAll([
      taskDto("tsk_1", { status: "progress", marks: needs }),
      taskDto("tsk_2", { status: "review", marks: needs }),
      taskDto("tsk_3", { status: "todo" }),
      taskDto("tsk_4", { status: "done", marks: needs })
    ]);
  });
  const host = mount(<TasksNavRow current={false} />, { path: "/home" }).host;
  const row = host.querySelector<HTMLAnchorElement>('[data-slot="tasks-nav"]')!;
  expect(row.getAttribute("href")).toBe("/tasks");
  expect(row.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("2 items need you");
  expect(row.querySelector('[title="Tasks that need you"]') !== null).toBe(true);
  act(() => { useTaskBoardStore.getState().replaceAll([taskDto("tsk_3"), taskDto("tsk_5")]); });
  // Open tasks that wait on nobody: no total either.
  expect(row.textContent).toBe("Tasks");
});

// What was deleted or purged while the stream was down is read again when it
// comes back.
test("Recently deleted is read again when the stream reconnects", async () => {
  let served = [taskDto("tsk_x", { title: "Gone task", deletedAt: hoursAgo(3) })];
  const { host, calls } = render(five(), () => jsonResponse({ tasks: served }));
  await settleUntil(() => button(host, "Recently deleted (1)") !== undefined, "the deleted count");
  served = [...served, taskDto("tsk_y", { title: "Deleted elsewhere", deletedAt: hoursAgo(1) })];
  await act(async () => { window.dispatchEvent(new CustomEvent("mandate:sse-open")); });
  await settleUntil(() => button(host, "Recently deleted (2)") !== undefined, "the count read again");
  expect(calls.filter((c) => c.url.includes("deleted=1")).length).toBe(2);
});

// Each status folds from its heading, to see what is under a long one; Done
// starts folded. What is folded is kept in this browser.
test("a status in the list folds and opens from its heading; Done starts folded; what is folded is kept", () => {
  const { host } = render(five());
  click(button(host, "List")!);
  const head = (group: string) => host.querySelector<HTMLButtonElement>(`[data-slot="task-group"][data-group="${group}"] [data-slot="task-group-toggle"]`)!;
  const rows = (group: string) => host.querySelectorAll(`[data-slot="task-group"][data-group="${group}"] [data-slot="task-row"]`).length;
  expect([head("todo").getAttribute("aria-expanded"), head("done").getAttribute("aria-expanded")]).toEqual(["true", "false"]);
  expect(head("done").textContent).toContain("Done");
  expect(head("done").textContent).toContain("1");
  click(head("todo"));
  expect([head("todo").getAttribute("aria-expanded"), rows("todo")]).toEqual(["false", 0]);
  click(head("done"));
  expect([head("done").getAttribute("aria-expanded"), rows("done")]).toEqual(["true", 1]);
  // Backlog starts folded too, and one press opens it.
  expect(head("backlog").getAttribute("aria-expanded")).toBe("false");
  click(head("backlog"));
  expect(head("backlog").getAttribute("aria-expanded")).toBe("true");
  const kept = JSON.parse(localStorage.getItem("mandate.task-board.v1") ?? "{}") as { state?: { folded?: Record<string, boolean> } };
  expect(kept.state?.folded).toEqual({ todo: true, done: false, backlog: false });
});

test("a browser that kept the board before folding existed starts with Done folded", async () => {
  localStorage.setItem("mandate.task-board.v1", JSON.stringify({ state: { view: "list", detailWidth: 700 }, version: 0 }));
  await act(async () => { await useTaskBoardStore.persist.rehydrate(); });
  expect(useTaskBoardStore.getState().folded).toEqual({ done: true });
  expect(useTaskBoardStore.getState().view).toBe("list");
});
