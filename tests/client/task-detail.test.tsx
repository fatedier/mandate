import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { toast } from "sonner";
import { TasksPage } from "@/routes/task-board/TasksPage";
import { TASK_BOARD_STORAGE_KEY, useTaskBoardStore } from "@/store/task-board";
import { resetTaskBoardStore } from "../helpers/task-board.js";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { useConfirmStore } from "@/components/confirm-action";
import { BOARD_STATUSES } from "@shared/task-board";
import type { TaskDetailDto, TaskEntryDto } from "@shared/api/task-board";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch, type FetchCall } from "../helpers/fetch.js";
import { mount, settle, settleUntil, typeInto } from "../helpers/mount.js";
import { taskDetailDto } from "../helpers/client-builders.js";

// A task opened on the Tasks page: the side panel, everything in it the
// user can change, and its stream.

afterEach(() => {
  runCleanups();
  resetTaskBoardStore();
  act(() => {
    usePersonalAgentStore.setState({ agent: null });
    useConfirmStore.setState({ pending: null, resolver: null, returnFocus: null });
  });
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const entry = (seq: number, over: Partial<TaskEntryDto>): TaskEntryDto => ({
  id: `tke_${seq}`, seq, kind: "comment", by: "owner", text: "", status: null, threadId: null, threadTitle: null, newThread: false, createdAt: hoursAgo(5 - seq * 0.1), ...over
});

let where = "";
function Where() {
  where = useLocation().pathname;
  return null;
}

/** The page at /tasks/<id>, the task on the board and its detail answered by
 *  `answer` (the GET of the task by default). */
function render(task: TaskDetailDto, answer?: (call: FetchCall) => Response | undefined): { host: HTMLElement; calls: FetchCall[] } {
  const calls = mockFetch((call) => answer?.(call) ?? (call.url.includes("deleted=1") ? jsonResponse({ tasks: [] }) : jsonResponse({ task })));
  const { entries: _entries, ...dto } = task;
  act(() => {
    useTaskBoardStore.getState().replaceAll([dto]);
    usePersonalAgentStore.setState({ agent: { threadId: "thr_g", name: "Juno", named: true, unread: false, voiceConfigured: false, lastVisibleSeq: 0, questions: [] } as never });
  });
  const host = mount(
    <MemoryRouter initialEntries={[`/tasks/${task.id}`]}>
      <Where />
      <Routes>
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/tasks/:taskId" element={<TasksPage />} />
      </Routes>
    </MemoryRouter>
  ).host;
  return { host, calls };
}

const detail = () => document.querySelector<HTMLElement>('[data-slot="task-detail"]');
const has = (el: ParentNode, selector: string) => el.querySelector(selector) !== null;
const button = (el: ParentNode, name: string) => [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name);
const click = (el: HTMLElement) => act(() => { el.click(); });
const press = async (el: HTMLElement) => {
  await act(async () => {
    el.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
};
const menuItem = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')].find((m) => m.textContent?.trim() === name);
/** A POST the test is about: not the page's "opened". */
const isPost = (c: FetchCall) => c.method === "POST" && !c.url.endsWith("/opened");
const bodyOf = (call: FetchCall) => JSON.parse(String(call.init?.body ?? "null")) as unknown;
const key = (el: EventTarget, k: string) => act(() => { el.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
const loaded = (host: HTMLElement) => settleUntil(() => has(host, '[data-slot="task-stream"]'), "the task's stream");

test("Esc closes the detail", async () => {
  const { host } = render(taskDetailDto("tsk_a", { title: "Bake rye loaves" }));
  await loaded(host);
  expect(detail() !== null).toBe(true);
  key(document.body, "Escape");
  expect(where).toBe("/tasks");
  expect(detail() === null).toBe(true);
});

test("an entry of a kind the client does not know shows as a grey line", async () => {
  const { host } = render(taskDetailDto("tsk_a", {
    entries: [
      entry(1, { kind: "comment", by: "owner", text: "Start with dairy." }),
      entry(2, { kind: "split" as never, by: "agent", text: "split it into two" }),
      entry(3, { kind: "link", by: "agent", threadId: "thr_1", threadTitle: "Pantry page", newThread: true }),
      entry(4, { kind: "status", by: "owner", status: "done" }),
      entry(5, { kind: "status", by: "owner", status: "cancelled" }),
      entry(6, { kind: "result", by: "agent", text: "updated" }),
      entry(7, { kind: "comment", by: "agent", text: "Sent it on.", status: "review" })
    ]
  }));
  await loaded(host);
  const lines = [...host.querySelectorAll('[data-slot="task-line"]')].map((l) => l.textContent?.replace(/\s*\d+[mhd] ago$|just now$/, "").trim());
  // Newest first.
  expect(lines).toEqual(["Juno updated the result", "You cancelled it", "You moved it to Done", "Juno linked Pantry page (a new thread)", "split it into two"]);
  const comments = [...host.querySelectorAll<HTMLElement>('[data-slot="task-comment"]')];
  expect(comments.map((c) => c.querySelector('[data-slot="task-comment-head"]')?.textContent?.replace(/\d+[mhd] ago$/, "").trim())).toEqual(["Junomoved it to In review", "You"]);
});

// A task opens on its latest, so a long stream never leaves it at the bottom,
// below every older line.
test("the stream is newest first, under the comment box", async () => {
  const { host } = render(taskDetailDto("tsk_a", {
    entries: [
      entry(1, { kind: "comment", by: "owner", text: "First note." }),
      entry(2, { kind: "link", by: "agent", threadId: "thr_1", threadTitle: "Pantry page" }),
      entry(3, { kind: "comment", by: "agent", text: "Latest reply." })
    ]
  }));
  await loaded(host);
  const comments = host.querySelector<HTMLElement>('[data-slot="task-comments"]')!;
  // The box comes first, then the stream.
  expect([...comments.querySelectorAll('textarea, [data-slot="task-stream"]')].map((el) => el.tagName.toLowerCase())).toEqual(["textarea", "div"]);
  const rows = [...comments.querySelector('[data-slot="task-stream"]')!.children] as HTMLElement[];
  expect(rows.map((row) => row.dataset.slot)).toEqual(["task-comment", "task-line", "task-comment"]);
  expect(rows[0]!.textContent).toContain("Latest reply.");
  expect(rows[2]!.textContent).toContain("First note.");
});

test("columns come from BOARD_STATUSES", async () => {
  const { host } = render(taskDetailDto("tsk_a"));
  await loaded(host);
  expect([...host.querySelectorAll<HTMLElement>('[data-slot="task-column"]')].map((c) => c.dataset.status)).toEqual([...BOARD_STATUSES]);
});

test("rename in place", async () => {
  const { host, calls } = render(taskDetailDto("tsk_a", { title: "Bake rye loaves" }), (call) => (call.method === "PATCH" ? jsonResponse({ task: taskDetailDto("tsk_a", { title: "Bake fresh rye loaves" }) }) : undefined));
  await loaded(host);
  click(host.querySelector<HTMLElement>('[data-slot="task-title"]')!);
  const input = host.querySelector<HTMLInputElement>('[data-slot="task-title-input"]')!;
  expect(input.value).toBe("Bake rye loaves");
  await typeInto(input, "Bake fresh rye loaves");
  key(input, "Enter");
  await settleUntil(() => calls.some((c) => c.method === "PATCH"), "the rename");
  expect(bodyOf(calls.find((c) => c.method === "PATCH")!)).toEqual({ title: "Bake fresh rye loaves" });
  expect(has(host, '[data-slot="task-title-input"]')).toBe(false);
  // Leaving the field saves too; Esc drops the edit.
  click(host.querySelector<HTMLElement>('[data-slot="task-title"]')!);
  const again = host.querySelector<HTMLInputElement>('[data-slot="task-title-input"]')!;
  await typeInto(again, "Bake rye loaves by the dozen");
  await act(async () => { again.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true })); });
  await settleUntil(() => calls.filter((c) => c.method === "PATCH").length === 2, "the second rename");
  expect(bodyOf(calls.filter((c) => c.method === "PATCH")[1]!)).toEqual({ title: "Bake rye loaves by the dozen" });
  click(host.querySelector<HTMLElement>('[data-slot="task-title"]')!);
  const dropped = host.querySelector<HTMLInputElement>('[data-slot="task-title-input"]')!;
  await typeInto(dropped, "Not this");
  key(dropped, "Escape");
  expect(has(host, '[data-slot="task-title-input"]')).toBe(false);
  expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2);
  // Esc in the field closed the rename, not the task.
  expect(detail() !== null).toBe(true);
});

test("description folds past nine lines, Show more opens it; edit and save", async () => {
  const long = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join("\n\n");
  const { host, calls } = render(taskDetailDto("tsk_a", { description: long }), (call) => (call.method === "PATCH" ? jsonResponse({ task: taskDetailDto("tsk_a", { description: "Short now." }) }) : undefined));
  await loaded(host);
  const body = host.querySelector<HTMLElement>('[data-slot="task-description"]')!;
  expect(body.dataset.folded).toBe("true");
  click(button(host, "Show more")!);
  expect(host.querySelector<HTMLElement>('[data-slot="task-description"]')!.dataset.folded).toBe("false");
  expect(button(host, "Show less") !== undefined).toBe(true);
  click(button(host, "Edit description")!);
  const area = host.querySelector<HTMLTextAreaElement>('[data-slot="task-description-input"]')!;
  expect(area.placeholder).toBe("Paste or write as much as you like. Markdown works.");
  await typeInto(area, "Short now.");
  click(button(host, "Save")!);
  await settleUntil(() => calls.some((c) => c.method === "PATCH"), "the save");
  expect(bodyOf(calls.find((c) => c.method === "PATCH")!)).toEqual({ description: "Short now." });
});

test("an empty description offers to add one", async () => {
  const { host } = render(taskDetailDto("tsk_a"));
  await loaded(host);
  click(button(host, "Add a description…")!);
  expect(has(host, '[data-slot="task-description-input"]')).toBe(true);
  // An edit left open is kept for the page's life: let go of it.
  click(button(host, "Cancel")!);
});

test("Result shows by the agent with its age", async () => {
  const { host } = render(taskDetailDto("tsk_a", { status: "review", result: "Picked **FoodList**.", resultAt: hoursAgo(2.5) }));
  await loaded(host);
  const result = host.querySelector<HTMLElement>('[data-slot="task-result"]')!;
  expect(result.textContent).toContain("by Juno · 2h ago");
  expect(result.textContent).toContain("Picked FoodList.");
  // No Result yet: no section.
  act(() => { useTaskBoardStore.getState().upsert({ ...useTaskBoardStore.getState().tasks!.get("tsk_a")!, result: null, resultAt: null }); });
  expect(has(host, '[data-slot="task-result"]')).toBe(false);
});

test("thread rows show dot, state and latest reply", async () => {
  const { host } = render(taskDetailDto("tsk_a", {
    threads: [
      { threadId: "thr_1", title: "Pantry page", dot: "needs_you", archived: false, lastReply: "Fixed __init__.py and __main__.py.", lastReplyAt: hoursAgo(1.5) },
      { threadId: "thr_2", title: "Old work", dot: "idle", archived: true, lastReply: null, lastReplyAt: null }
    ]
  }));
  await loaded(host);
  const rows = [...host.querySelectorAll<HTMLElement>('[data-slot="task-thread-row"]')];
  expect(rows.map((r) => r.querySelector('[data-slot="task-thread-state"]')?.textContent)).toEqual(["Needs you", "Archived"]);
  expect(rows[0]!.textContent).toContain("Pantry page");
  // The server's line, already in its words: drawn as it is, not read as Markdown again.
  expect(rows[0]!.textContent).toContain("Fixed __init__.py and __main__.py. · 1h ago");
  expect(rows[0]!.getAttribute("href")).toBe("/threads/thr_1");
  expect(host.textContent).toContain("Juno keeps these");
});

test("no thread yet says how one starts", async () => {
  const { host } = render(taskDetailDto("tsk_a"));
  await loaded(host);
  expect(host.textContent).toContain("No thread works on it yet. Mention @Juno in a comment when it should start.");
  expect(host.textContent).toContain("No comments yet.");
});

test("a status change by the owner from the menu", async () => {
  const { host, calls } = render(taskDetailDto("tsk_a", { status: "review" }), (call) => (call.method === "PATCH" ? jsonResponse({ task: taskDetailDto("tsk_a", { status: "done" }) }) : undefined));
  await loaded(host);
  await press(host.querySelector<HTMLElement>('[data-slot="task-status"]')!);
  expect(["Todo", "In progress", "In review", "Done", "Cancelled"].every((name) => menuItem(name) !== undefined)).toBe(true);
  await act(async () => { menuItem("Done")!.click(); });
  await settleUntil(() => calls.some((c) => c.method === "PATCH"), "the status change");
  expect(bodyOf(calls.find((c) => c.method === "PATCH")!)).toEqual({ status: "done" });
});

/** Every plain toast the page shows, with its action when it has one. */
function messages(): Array<{ message: string; action?: { label: string; onClick: () => void } }> {
  const shown: Array<{ message: string; action?: { label: string; onClick: () => void } }> = [];
  const original = toast.message;
  toast.message = ((message: unknown, options?: { action?: { label: string; onClick: () => void } }) => {
    shown.push({ message: String(message), ...(options?.action ? { action: options.action } : {}) });
    return "";
  }) as typeof toast.message;
  onCleanup(() => { toast.message = original; });
  return shown;
}

test("delete with confirmation, then Undo restores", async () => {
  const shown = messages();
  const { host, calls } = render(taskDetailDto("tsk_a", { title: "Bake rye loaves" }), (call) => {
    if (call.method === "DELETE") return jsonResponse({ ok: true });
    if (call.method === "POST") return jsonResponse({ task: taskDetailDto("tsk_a") });
    return undefined;
  });
  await loaded(host);
  await press(button(detail()!, "Task actions")!);
  await act(async () => { menuItem("Delete task")!.click(); });
  expect(useConfirmStore.getState().pending).toEqual({
    title: "Delete this task?",
    description: "“Bake rye loaves” moves to Recently deleted. Its threads stay as they are.",
    confirmLabel: "Delete"
  });
  await act(async () => { useConfirmStore.getState().resolve(true); });
  await settleUntil(() => calls.some((c) => c.method === "DELETE"), "the delete");
  expect(calls.find((c) => c.method === "DELETE")!.url).toEndWith("/api/task-board/tasks/tsk_a");
  await settleUntil(() => shown.length > 0, "the Undo toast");
  expect(shown.map((t) => [t.message, t.action?.label])).toEqual([["Task deleted", "Undo"]]);
  expect(where).toBe("/tasks");
  await act(async () => { shown[0]!.action!.onClick(); });
  await settleUntil(() => calls.some((c) => isPost(c)), "the restore");
  expect(calls.find((c) => isPost(c))!.url).toEndWith("/api/task-board/tasks/tsk_a/restore");
});

test("a comment without @agent shows the toast", async () => {
  const shown = messages();
  const { host, calls } = render(taskDetailDto("tsk_a"), (call) => (call.method === "POST" ? jsonResponse({ entry: entry(1, { text: "No rush." }) }, 201) : undefined));
  await loaded(host);
  const box = host.querySelector<HTMLTextAreaElement>('[data-slot="task-comments"] textarea')!;
  expect(box.placeholder).toBe("Leave a comment. @Juno to have Juno act on it now.");
  // Words only: no image button.
  expect(button(host.querySelector('[data-slot="task-comments"]')!, "Attach image") === undefined).toBe(true);
  await typeInto(box, "No rush.");
  click(button(host.querySelector('[data-slot="task-comments"]')!, "Comment")!);
  await settleUntil(() => calls.some((c) => isPost(c)), "the comment");
  const post = calls.find((c) => isPost(c))!;
  expect(post.url).toEndWith("/api/task-board/tasks/tsk_a/comments");
  expect(bodyOf(post)).toEqual({ text: "No rush.", mentions: [] });
  await settleUntil(() => shown.length > 0, "the toast");
  expect(shown.map((t) => t.message)).toEqual(["Comment added. Juno reads it the next time it works on this task."]);
});

test("the detail resizes from its left edge and keeps its width", async () => {
  const { host } = render(taskDetailDto("tsk_a"));
  await loaded(host);
  const grip = host.querySelector<HTMLElement>('[data-slot="task-detail"] [role="separator"]')!;
  expect(grip.getAttribute("aria-label")).toBe("Drag to resize");
  expect(detail()!.style.width).toBe("680px");
  key(grip, "ArrowLeft");
  expect(detail()!.style.width).toBe("700px");
  await act(async () => {
    grip.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 500, pointerId: 1 }));
    grip.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, clientX: 460, pointerId: 1 }));
    grip.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, clientX: 460, pointerId: 1 }));
  });
  expect(detail()!.style.width).toBe("740px");
  const kept = JSON.parse(localStorage.getItem(TASK_BOARD_STORAGE_KEY)!) as { state: { detailWidth: number } };
  expect(kept.state.detailWidth).toBe(740);
  // Never narrower than 420.
  for (let i = 0; i < 20; i++) key(grip, "ArrowRight");
  expect(detail()!.style.width).toBe("420px");
});

test("a click on the view's empty space closes the task; a card opens another; a control and the task itself leave it open", async () => {
  const { host } = render(taskDetailDto("tsk_a", { title: "Bake rye loaves" }));
  await loaded(host);
  act(() => {
    useTaskBoardStore.getState().replaceAll([
      taskDetailDto("tsk_a", { title: "Bake rye loaves" }), taskDetailDto("tsk_b", { title: "Bake oat loaves" }), taskDetailDto("tsk_c", { title: "Old idea", status: "cancelled" })
    ]);
  });
  const view = host.querySelector<HTMLElement>('[data-slot="task-board-home"]')!;
  const card = (title: string) => [...view.querySelectorAll<HTMLElement>('[data-slot="task-card"]')].find((c) => c.textContent?.includes(title))!;
  // In the task itself: it stays.
  click(detail()!.querySelector<HTMLElement>("h3")!);
  expect(where).toBe("/tasks/tsk_a");
  // A control of the view does its own thing only.
  click(button(view, "Show cancelled")!);
  expect([where, has(view, '[data-slot="task-detail"]')]).toEqual(["/tasks/tsk_a", true]);
  // Another card: that task.
  click(card("Bake oat loaves"));
  expect(where).toBe("/tasks/tsk_b");
  // The board's own ground: the view's empty space.
  click(view.querySelector<HTMLElement>('[data-slot="task-board"]')!);
  expect([where, detail() === null]).toEqual(["/tasks", true]);
});

test("a drag of the board's ground does not close the open task: the click that ends it is the drag's; a press that did not move is a click", async () => {
  const { host } = render(taskDetailDto("tsk_a", { title: "Bake rye loaves" }));
  await loaded(host);
  act(() => { useTaskBoardStore.getState().replaceAll([taskDetailDto("tsk_a", { title: "Bake rye loaves" })]); });
  const ground = host.querySelector<HTMLElement>('[data-slot="task-board"]')!;
  const pointer = (type: string, x: number) => ground.dispatchEvent(new window.PointerEvent(type, { bubbles: true, button: 0, pointerType: "mouse", pointerId: 1, clientX: x, clientY: 10 }));
  // Pressed, moved 40px, let go: the browser then clicks where the pointer is held.
  act(() => { pointer("pointerdown", 100); pointer("pointermove", 60); pointer("pointerup", 60); });
  click(ground);
  expect([where, has(host, '[data-slot="task-detail"]')]).toEqual(["/tasks/tsk_a", true]);
  act(() => { pointer("pointerdown", 100); pointer("pointerup", 100); });
  click(ground);
  expect([where, detail() === null]).toEqual(["/tasks", true]);
});

// A comment's box sends as every composer does: Enter sends, Shift+Enter is
// a new line, and Enter with Cmd or Ctrl held is left alone.
test("Enter sends a comment; with Shift, Cmd or Ctrl held it does not", async () => {
  messages();
  const { host, calls } = render(taskDetailDto("tsk_a"), (call) => (call.method === "POST" ? jsonResponse({ entry: entry(1, { text: "x" }) }, 201) : undefined));
  await loaded(host);
  const comments = host.querySelector<HTMLElement>('[data-slot="task-comments"]')!;
  const box = comments.querySelector<HTMLTextAreaElement>("textarea")!;
  /** True when the key was left to the box (a new line, or nothing). */
  const press = (init: KeyboardEventInit) => {
    let left = false;
    act(() => { left = box.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init })); });
    return left;
  };
  // The hint every composer shows while Enter sends.
  expect(comments.textContent).toContain("⏎ to send");
  await typeInto(box, "First line");
  expect([press({ shiftKey: true }), press({ metaKey: true }), press({ ctrlKey: true })]).toEqual([true, true, true]);
  await settle(20);
  expect(calls.filter((c) => isPost(c))).toHaveLength(0);
  expect(press({})).toBe(false);
  await settleUntil(() => calls.filter((c) => isPost(c)).length === 1, "the comment sent with Enter");
  expect(bodyOf(calls.find((c) => isPost(c))!)).toEqual({ text: "First line", mentions: [] });
  await settleUntil(() => box.value === "", "the box emptied");
});

test("Ask <name> starts a comment with @<name>", async () => {
  const shown = messages();
  const { host, calls } = render(taskDetailDto("tsk_a"), (call) => (call.method === "POST" ? jsonResponse({ entry: entry(1, { text: "@Juno start" }) }, 201) : undefined));
  await loaded(host);
  await press(button(detail()!, "Task actions")!);
  await act(async () => { menuItem("Ask Juno")!.click(); });
  const box = host.querySelector<HTMLTextAreaElement>('[data-slot="task-comments"] textarea')!;
  await settleUntil(() => box.value === "@Juno ", "the box started with @Juno");
  expect(document.activeElement === box).toBe(true);
  await typeInto(box, "@Juno start with dairy", "@Juno start with dairy".length);
  act(() => { box.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  await settleUntil(() => calls.some((c) => isPost(c)), "the comment");
  expect(bodyOf(calls.find((c) => isPost(c))!)).toEqual({ text: "@Juno start with dairy", mentions: [{ kind: "agent", id: "personal", label: "Juno" }] });
  // It asked the agent: no "reads it next time" toast.
  await new Promise((r) => setTimeout(r, 20));
  expect(shown).toEqual([]);
});

test("Rename from the menu keeps the cursor in the title", async () => {
  const { host } = render(taskDetailDto("tsk_a", { title: "Bake rye loaves" }));
  await loaded(host);
  await press(button(detail()!, "Task actions")!);
  await act(async () => { menuItem("Rename")!.click(); });
  await settleUntil(() => has(host, '[data-slot="task-title-input"]'), "the title field");
  // Still there once everything has settled, and the cursor in it.
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  const input = host.querySelector<HTMLInputElement>('[data-slot="task-title-input"]');
  expect(input !== null).toBe(true);
  expect(document.activeElement === input).toBe(true);
});

// Ask over a box that already starts with the words still makes them the
// mention.
test("Ask over words already written names the agent", async () => {
  messages();
  const { host, calls } = render(taskDetailDto("tsk_a"), (call) => (call.method === "POST" ? jsonResponse({ entry: entry(1, { text: "x" }) }, 201) : undefined));
  await loaded(host);
  const box = host.querySelector<HTMLTextAreaElement>('[data-slot="task-comments"] textarea')!;
  await typeInto(box, "@Juno please start", "@Juno please start".length);
  await press(button(detail()!, "Task actions")!);
  await act(async () => { menuItem("Ask Juno")!.click(); });
  await settleUntil(() => document.activeElement === box, "the box focused");
  expect(box.value).toBe("@Juno please start");
  act(() => { box.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  await settleUntil(() => calls.some((c) => isPost(c)), "the comment");
  expect(bodyOf(calls.find((c) => isPost(c))!)).toEqual({ text: "@Juno please start", mentions: [{ kind: "agent", id: "personal", label: "Juno" }] });
});

test("a comment keeps the lines it was typed on", async () => {
  const { host } = render(taskDetailDto("tsk_a", { entries: [entry(1, { kind: "comment", by: "owner", text: "Looks right.\nShip it next." })] }));
  await loaded(host);
  const body = host.querySelector('[data-slot="task-comment"]')!;
  expect(body.querySelectorAll("br").length).toBe(1);
  expect(body.textContent).toContain("Looks right.");
});

// The detail says it was opened only while the user can see it: once when it
// shows a task, again when the page comes back into view; its background
// re-reads say nothing.
test("the detail tells the board it was opened only while the page is in view", async () => {
  const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  let state: DocumentVisibilityState = "hidden";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  onCleanup(() => {
    if (visibility) Object.defineProperty(document, "visibilityState", visibility);
    else delete (document as unknown as Record<string, unknown>).visibilityState;
  });
  const { host, calls } = render(taskDetailDto("tsk_a"), (call) => (call.url.endsWith("/opened") ? jsonResponse({ ok: true }) : undefined));
  await loaded(host);
  const opened = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/api/task-board/tasks/tsk_a/opened")).length;
  expect(opened()).toBe(0);
  // The task changes while it is open: read again, still not "opened".
  act(() => { useTaskBoardStore.getState().upsert({ ...useTaskBoardStore.getState().tasks!.get("tsk_a")!, updatedAt: new Date().toISOString() }); });
  await settleUntil(() => calls.filter((c) => c.method === "GET" && c.url.endsWith("/tsk_a")).length >= 2, "the second read");
  expect(opened()).toBe(0);
  state = "visible";
  await act(async () => { document.dispatchEvent(new CustomEvent("visibilitychange")); });
  await settleUntil(() => opened() === 1, "opened once the page is seen");
});
