import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { TasksPage } from "@/routes/task-board/TasksPage";
import { TASK_BOARD_STORAGE_KEY, useTaskBoardStore } from "@/store/task-board";
import { usePersonalAgentStore } from "@/store/personal-agent";
import type { TaskDetailDto, TaskDto } from "@shared/api/task-board";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch, type FetchCall } from "../helpers/fetch.js";
import { mount, settleUntil, typeInto } from "../helpers/mount.js";
import { taskDetailDto, taskDto } from "../helpers/client-builders.js";
import { resetTaskBoardStore } from "../helpers/task-board.js";
import { fakePhoneWidth } from "../helpers/fake-phone-width.js";

// Labels on the task board: the user's, the agent's (marked) and the automatic
// ones (where the task's threads' workers ran, first, not removable); and
// one filter bar, Label and Due, kept in this browser until cleared.

afterEach(() => {
  runCleanups();
  resetTaskBoardStore();
  act(() => { usePersonalAgentStore.setState({ agent: null }); });
});

function day(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const BOARD: TaskDto[] = [
  taskDto("tsk_a", { title: "Weekly bread order", labels: [{ name: "acme-bakery", by: "auto" }, { name: "billing", by: "owner" }, { name: "3.21", by: "agent" }, { name: "ops", by: "owner" }], dueDate: day(-1) }),
  taskDto("tsk_b", { title: "Prices from one source", status: "progress", labels: [{ name: "billing", by: "owner" }], dueDate: day(3) }),
  taskDto("tsk_c", { title: "Docs overhaul", status: "review" })
];

function render(tasks: TaskDto[], path = "/tasks", answer?: (call: FetchCall) => Response | undefined) {
  const calls = mockFetch((call) => answer?.(call) ?? jsonResponse({ tasks: [] }));
  act(() => {
    useTaskBoardStore.getState().replaceAll(tasks);
    usePersonalAgentStore.setState({ agent: { threadId: "thr_g", name: "Juno", named: true, unread: false, voiceConfigured: false, lastVisibleSeq: 0, questions: [] } as never });
  });
  const host = mount(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/tasks/:taskId" element={<TasksPage />} />
      </Routes>
    </MemoryRouter>
  ).host;
  return { host, calls };
}

const button = (el: ParentNode, name: string) => [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name);
const click = (el: HTMLElement) => act(() => { el.click(); });
const press = async (el: HTMLElement) => {
  await act(async () => {
    el.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
};
const chips = (el: ParentNode | null) => [...(el?.querySelectorAll<HTMLElement>('[data-slot="task-label"], [data-slot="task-label-more"]') ?? [])].map((c) => (c.dataset.slot === "task-label-more" ? c.textContent?.trim() : `${c.textContent?.trim()}:${c.dataset.by}`));
const rowIds = (host: HTMLElement) => [...host.querySelectorAll('[data-slot="task-row"]')].map((r) => r.getAttribute("data-task-id"));
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')];
const item = (name: string) => menuItems().find((m) => m.textContent?.trim() === name)!;
const choose = async (name: string) => { await act(async () => { item(name).click(); await Promise.resolve(); }); };
const ticks = () => menuItems().map((m) => `${m.textContent?.trim()}:${m.getAttribute("aria-checked")}`);
// A menu stays open while ticking: Escape closes it.
const closeMenu = async () => {
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
};

test("a row and a card show the labels, automatic first, up to three then how many more; each says what it is on hover", () => {
  const { host } = render(BOARD);
  const card = host.querySelector('[data-slot="task-card"][data-task-id="tsk_a"]');
  expect(chips(card)).toEqual(["acme-bakery:auto", "billing:owner", "3.21:agent", "+1"]);
  const titles = [...card!.querySelectorAll<HTMLElement>('[data-slot="task-label"]')].map((c) => c.getAttribute("title"));
  expect(titles).toEqual(["Automatic: its threads' workers ran in acme-bakery", null, "Added by Juno"]);
  click(button(host, "List")!);
  expect(chips(host.querySelector('[data-slot="task-row"][data-task-id="tsk_a"]'))).toEqual(["acme-bakery:auto", "billing:owner", "3.21:agent", "+1"]);
  expect(chips(host.querySelector('[data-slot="task-row"][data-task-id="tsk_c"]'))).toEqual([]);
});

test("the Label filter lists Select all, the board's labels, automatic first, then No label; ticking narrows every view; the count and Clear filters follow", async () => {
  const { host } = render(BOARD);
  click(button(host, "List")!);
  const label = () => host.querySelector<HTMLElement>('[data-slot="task-filter-label"]')!;
  expect(label().textContent?.trim()).toBe("Label");
  expect(button(host, "Clear filters") === undefined).toBe(true);
  await press(label());
  expect(menuItems().map((m) => m.textContent?.trim())).toEqual(["Select all", "acme-bakery", "3.21", "billing", "ops", "No label"]);
  await choose("billing");
  expect(rowIds(host)).toEqual(["tsk_a", "tsk_b"]);
  expect(label().textContent?.trim()).toBe("Label · 1");
  // The menu stays open for the next tick.
  expect(ticks()).toEqual(["Select all:mixed", "acme-bakery:false", "3.21:false", "billing:true", "ops:false", "No label:false"]);
  // The board's own counts are never filtered.
  expect(host.textContent).toContain("3 open");
  await closeMenu();
  click(button(host, "Clear filters")!);
  expect(rowIds(host)).toEqual(["tsk_a", "tsk_b", "tsk_c"]);
  expect(label().textContent?.trim()).toBe("Label");
});

test("the Due filter: Overdue, This week, No due date, without Select all; any ticked matches, and Label and Due must both match", async () => {
  const { host } = render(BOARD);
  click(button(host, "List")!);
  await press(host.querySelector<HTMLElement>('[data-slot="task-filter-due"]')!);
  expect(menuItems().map((m) => m.textContent?.trim())).toEqual(["Overdue", "This week", "No due date"]);
  await choose("Overdue");
  expect(rowIds(host)).toEqual(["tsk_a"]);
  await choose("No due date");
  expect(rowIds(host)).toEqual(["tsk_a", "tsk_c"]);
  await closeMenu();
  await press(host.querySelector<HTMLElement>('[data-slot="task-filter-label"]')!);
  await choose("ops");
  expect(rowIds(host)).toEqual(["tsk_a"]);
});

test("Label's Select all ticks every label and No label, so every task shows; with all ticked it unticks them; a dash while some are", async () => {
  const { host } = render(BOARD);
  click(button(host, "List")!);
  const label = () => host.querySelector<HTMLElement>('[data-slot="task-filter-label"]')!;
  await press(label());
  await choose("Select all");
  expect(ticks()).toEqual(["Select all:true", "acme-bakery:true", "3.21:true", "billing:true", "ops:true", "No label:true"]);
  expect([rowIds(host), label().textContent?.trim()]).toEqual([["tsk_a", "tsk_b", "tsk_c"], "Label · 5"]);
  // Everything but the tasks without a label.
  await choose("No label");
  expect([item("Select all").getAttribute("aria-checked"), rowIds(host)]).toEqual(["mixed", ["tsk_a", "tsk_b"]]);
  expect(item("Select all").querySelector("svg.lucide-minus") !== null).toBe(true);
  // Some ticked: it ticks the rest.
  await choose("Select all");
  expect(item("Select all").getAttribute("aria-checked")).toBe("true");
  await choose("Select all");
  expect(ticks()).toEqual(["Select all:false", "acme-bakery:false", "3.21:false", "billing:false", "ops:false", "No label:false"]);
  expect([rowIds(host), label().textContent?.trim()]).toEqual([["tsk_a", "tsk_b", "tsk_c"], "Label"]);
});

test("No label alone shows the tasks without one", async () => {
  const { host } = render(BOARD);
  click(button(host, "List")!);
  await press(host.querySelector<HTMLElement>('[data-slot="task-filter-label"]')!);
  await choose("No label");
  expect(rowIds(host)).toEqual(["tsk_c"]);
});

test("filters that leave nothing say so, with Clear filters; what is ticked is kept in this browser", async () => {
  const { host } = render(BOARD);
  click(button(host, "List")!);
  await press(host.querySelector<HTMLElement>('[data-slot="task-filter-label"]')!);
  await choose("ops");
  await closeMenu();
  await press(host.querySelector<HTMLElement>('[data-slot="task-filter-due"]')!);
  await choose("No due date");
  await closeMenu();
  expect(host.querySelector('[data-slot="tasks-filtered-empty"]')?.textContent).toContain("No tasks match these filters.");
  const kept = JSON.parse(localStorage.getItem(TASK_BOARD_STORAGE_KEY) ?? "{}") as { state?: { filters?: unknown } };
  expect(kept.state?.filters).toEqual({ labels: ["ops"], due: ["none"] });
  click(button(host.querySelector('[data-slot="tasks-filtered-empty"]')!, "Clear filters")!);
  expect(rowIds(host)).toEqual(["tsk_a", "tsk_b", "tsk_c"]);
});

test("on a phone one Filter button opens Filter tasks, with the count of what is ticked", async () => {
  onCleanup(fakePhoneWidth());
  const { host } = render(BOARD);
  const filter = () => host.querySelector<HTMLElement>('[data-slot="task-filter-phone"]')!;
  expect(filter().textContent?.trim()).toBe("Filter");
  expect(host.querySelector('[data-slot="task-filter-label"]') === null).toBe(true);
  await act(async () => { filter().click(); await new Promise((r) => setTimeout(r, 0)); });
  const sheet = () => document.querySelector<HTMLElement>('[data-slot="task-filter-sheet"]')!;
  expect(sheet().textContent).toContain("Filter tasks");
  const options = () => [...sheet().querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')];
  const option = (name: string) => options().find((o) => o.textContent?.trim() === name)!;
  // Select all heads Label, not Due.
  expect(options().map((o) => o.textContent?.trim())).toEqual(["Select all", "acme-bakery", "3.21", "billing", "ops", "No label", "Overdue", "This week", "No due date"]);
  await act(async () => { option("billing").click(); await Promise.resolve(); });
  await act(async () => { option("Overdue").click(); await Promise.resolve(); });
  expect(filter().textContent?.trim()).toBe("Filter · 2");
  expect(rowIds(host)).toEqual(["tsk_a"]);
  expect(option("Select all").getAttribute("aria-checked")).toBe("mixed");
  await act(async () => { option("Select all").click(); await Promise.resolve(); });
  expect(options().map((o) => o.getAttribute("aria-checked"))).toEqual(["true", "true", "true", "true", "true", "true", "true", "false", "false"]);
  expect(filter().textContent?.trim()).toBe("Filter · 6");
});

// The task's own Labels field.
function renderDetail(task: TaskDetailDto, board: TaskDto[], answer?: (call: FetchCall) => Response | undefined) {
  return render(board, `/tasks/${task.id}`, (call) => answer?.(call) ?? (call.url.includes("deleted=1") ? jsonResponse({ tasks: [] }) : jsonResponse({ task })));
}
const field = () => document.querySelector<HTMLElement>('[data-slot="task-labels-field"]')!;
const input = () => field().querySelector<HTMLInputElement>('input[aria-label="Add a label"]')!;

test("the detail's Labels: automatic ones without ×, the others with Remove label; a name typed is added, a board label suggested", async () => {
  const task = taskDetailDto("tsk_a", { labels: [{ name: "acme-bakery", by: "auto" }, { name: "3.21", by: "agent" }] });
  const { calls } = renderDetail(task, [task, taskDto("tsk_b", { labels: [{ name: "billing", by: "owner" }] })], (call) => (call.method === "POST" && call.url.endsWith("/labels")
    ? jsonResponse({ task: { ...task, labels: [...task.labels, { name: "billing", by: "owner" }] } })
    : call.method === "DELETE" ? jsonResponse({ task: { ...task, labels: [{ name: "acme-bakery", by: "auto" }] } }) : undefined));
  await settleUntil(() => document.querySelector('[data-slot="task-labels-field"]') !== null, "the Labels field");
  expect(chips(field())).toEqual(["acme-bakery:auto", "3.21:agent"]);
  expect(field().querySelector('[aria-label="Remove label acme-bakery"]') === null).toBe(true);
  expect(field().querySelector('[aria-label="Remove label 3.21"]') !== null).toBe(true);
  expect(input().placeholder).toBe("Add a label");
  await typeInto(input(), "bil");
  const suggestions = () => [...document.querySelectorAll<HTMLElement>('[data-slot="task-label-suggestion"]')].map((s) => s.textContent?.trim());
  expect(suggestions()).toEqual(["billing", 'Create "bil"']);
  await act(async () => { document.querySelector<HTMLElement>('[data-slot="task-label-suggestion"]')!.click(); await Promise.resolve(); });
  await settleUntil(() => calls.some((c) => c.method === "POST" && c.url.endsWith("/labels")), "the label sent");
  expect(JSON.parse(String(calls.find((c) => c.method === "POST" && c.url.endsWith("/labels"))!.init!.body))).toEqual({ name: "billing" });
  await act(async () => { field().querySelector<HTMLElement>('[aria-label="Remove label 3.21"]')!.click(); await Promise.resolve(); });
  await settleUntil(() => calls.some((c) => c.method === "DELETE"), "the label removed");
  expect(calls.find((c) => c.method === "DELETE")!.url).toContain("/labels/3.21");
});

test("a name over 40 characters says so and is not sent; Enter adds a new one", async () => {
  const task = taskDetailDto("tsk_a");
  const { calls } = renderDetail(task, [task], (call) => (call.method === "POST" && call.url.endsWith("/labels") ? jsonResponse({ task: { ...task, labels: [{ name: "ops", by: "owner" }] } }) : undefined));
  await settleUntil(() => document.querySelector('[data-slot="task-labels-field"]') !== null, "the Labels field");
  await typeInto(input(), "x".repeat(41));
  act(() => { input().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  expect(field().querySelector('[data-slot="task-label-error"]')?.textContent).toBe("A label is at most 40 characters.");
  expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/labels"))).toBe(false);
  await typeInto(input(), "ops");
  await act(async () => { input().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await Promise.resolve(); });
  await settleUntil(() => calls.some((c) => c.method === "POST" && c.url.endsWith("/labels")), "the label sent");
  expect(input().value).toBe("");
});

test("This week takes today too; Overdue takes only open tasks", async () => {
  const { host } = render([
    taskDto("tsk_t", { title: "Today", dueDate: day(0) }),
    taskDto("tsk_w", { title: "Soon", dueDate: day(3) }),
    taskDto("tsk_l", { title: "Later", dueDate: day(20) }),
    taskDto("tsk_o", { title: "Late", dueDate: day(-2) }),
    taskDto("tsk_x", { title: "Late but done", status: "done", dueDate: day(-2) })
  ]);
  click(button(host, "List")!);
  // Done starts folded: open it to see what the filter leaves there.
  act(() => { useTaskBoardStore.setState({ folded: {} }); });
  await press(host.querySelector<HTMLElement>('[data-slot="task-filter-due"]')!);
  await choose("This week");
  expect(rowIds(host)).toEqual(["tsk_t", "tsk_w"]);
  await choose("This week");
  await choose("Overdue");
  expect(rowIds(host)).toEqual(["tsk_o"]);
});

test("a label filter unticks whatever its case", () => {
  act(() => { useTaskBoardStore.setState({ filters: { labels: ["Mandate"], due: [] } }); });
  act(() => { useTaskBoardStore.getState().toggleLabelFilter("mandate"); });
  expect(useTaskBoardStore.getState().filters.labels).toEqual([]);
});

test("a row's labels have a line of their own, so a long one wraps rather than pushing the thread and comment out", () => {
  const { host } = render([taskDto("tsk_a", {
    title: "Bread order",
    labels: [{ name: "acme-bakery-orders", by: "auto" }, { name: "billing and invoices", by: "owner" }, { name: "release 3.21 candidates", by: "agent" }, { name: "ops", by: "owner" }],
    lastComment: { by: "owner", text: "Start with dairy.", at: new Date().toISOString() }
  })]);
  click(button(host, "List")!);
  const row = host.querySelector<HTMLElement>('[data-slot="task-row"][data-task-id="tsk_a"]')!;
  const line = row.querySelector<HTMLElement>('[data-slot="task-row-labels"]')!;
  expect(chips(line)).toEqual(["acme-bakery-orders:auto", "billing and invoices:owner", "release 3.21 candidates:agent", "+1"]);
  expect(line.className.split(/\s+/)).toContain("flex-wrap");
  // The note keeps its own line.
  expect(row.querySelector('[data-slot="task-note"]')?.closest('[data-slot="task-row-labels"]') == null).toBe(true);
});

test("in Due, filters that leave only closed tasks say nothing matches", async () => {
  const { host } = render([
    taskDto("tsk_a", { title: "Open", labels: [{ name: "ops", by: "owner" }] }),
    taskDto("tsk_d", { title: "Finished", status: "done", labels: [{ name: "billing", by: "owner" }] })
  ]);
  click(button(host, "Due")!);
  await press(host.querySelector<HTMLElement>('[data-slot="task-filter-label"]')!);
  await choose("billing");
  await closeMenu();
  expect(host.querySelector('[data-slot="tasks-filtered-empty"]')?.textContent).toContain("No tasks match these filters.");
});
