import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { MarkdownView } from "@/components/MarkdownView";
import { AssistantMessage } from "@/routes/window/chat/AssistantMessage";
import { ToolRun } from "@/routes/window/chat/ToolRun";
import type { AgentMessage } from "@/store/agent-chat";
import { useTaskBoardStore } from "@/store/task-board";
import { useAgentPageUi } from "@/store/agent-page-ui";
import { runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";
import { taskDto } from "../helpers/client-builders.js";
import { resetTaskBoardStore } from "../helpers/task-board.js";

// A task named in the agent's reply: a chip that follows the task.

afterEach(() => {
  runCleanups();
  resetTaskBoardStore();
  useAgentPageUi.setState({ tabs: [], active: "page" });
});

const A = "tsk_aaaaaaaaaaa";
const B = "tsk_bbbbbbbbbbb";
const yesterday = () => {
  const d = new Date(Date.now() - 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

let at = "";
function Where() {
  const location = useLocation();
  at = `${location.pathname}${location.search}`;
  return null;
}

function render(text: string) {
  return mount(
    <MemoryRouter initialEntries={["/threads/thr_1"]}>
      <Routes><Route path="*" element={<><MarkdownView text={text} /><Where /></>} /></Routes>
    </MemoryRouter>
  ).host;
}
const chips = (host: HTMLElement) => [...host.querySelectorAll<HTMLAnchorElement>('[data-slot="task-chip"]')];

test("an agent reply's task link is a chip with the task's current status", async () => {
  act(() => {
    useTaskBoardStore.getState().replaceAll([
      taskDto(A, { title: "Prices from one source", status: "progress", dueDate: yesterday(), marks: { needsYou: true, failed: false, quiet: false } }),
      taskDto(B, { title: "Docs overhaul", status: "review" })
    ]);
  });
  const host = render(`Started [prices](/tasks/${A}); also /tasks/${B}.`);
  expect(chips(host).map((c) => c.getAttribute("href"))).toEqual([`/tasks/${A}`, `/tasks/${B}`]);
  const [a, b] = chips(host);
  // Its title as the board has it, whatever the link's words.
  expect(a!.querySelector('[data-slot="task-chip-title"]')?.textContent).toBe("Prices from one source");
  expect(a!.querySelector('[data-slot="task-status-icon"]')?.getAttribute("data-status")).toBe("progress");
  expect([...a!.querySelectorAll('[data-slot="task-chip-mark"]')].map((m) => m.textContent)).toEqual(["Overdue", "Needs you"]);
  expect(b!.querySelector('[data-slot="task-chip-title"]')?.textContent).toBe("Docs overhaul");
  expect(b!.querySelectorAll('[data-slot="task-chip-mark"]').length).toBe(0);
  // It follows the task.
  act(() => { useTaskBoardStore.getState().upsert(taskDto(A, { title: "Prices from one source", status: "review" })); });
  expect(chips(host)[0]!.querySelector('[data-slot="task-status-icon"]')?.getAttribute("data-status")).toBe("review");
  expect(chips(host)[0]!.querySelectorAll('[data-slot="task-chip-mark"]').length).toBe(0);
  // Pressed, it opens the task in the agent's panel.
  await act(async () => { chips(host)[1]!.click(); });
  expect(at).toBe(`/agent?task=${B}`);
});

test("a link to a task the board does not have keeps its words", () => {
  act(() => { useTaskBoardStore.getState().replaceAll([]); });
  const host = render(`See [the old one](/tasks/${A}).`);
  expect(chips(host)[0]!.querySelector('[data-slot="task-chip-title"]')?.textContent).toBe("the old one");
});

test("a task path inside a word, a longer path or code is not a chip", () => {
  act(() => { useTaskBoardStore.getState().replaceAll([taskDto(A)]); });
  const host = render(`docs/tasks/${A} and /tasks/${A}/x and \`/tasks/${A}\``);
  expect(chips(host).length).toBe(0);
});

test("a task_board call shows as one tool row with its word and the task's chip", () => {
  act(() => { useTaskBoardStore.getState().replaceAll([taskDto(A, { title: "Prices from one source", status: "review" })]); });
  const message = {
    id: "m1", threadId: "thr_g", seq: 3, role: "assistant", source: "self", sourceThreadId: null, wakeId: "w1",
    wakeReason: null, wakeMetadata: null, wakeStartedAt: null, createdAt: "2026-11-09T10:00:00.000Z",
    content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "c1", toolName: "task_board", args: { action: "set_status", taskId: A, status: "review", note: "Back." } }] }
  } as unknown as AgentMessage;
  const results = new Map([["c1", { result: `Prices from one source (${A}) · In review`, createdAt: "2026-11-09T10:00:01.000Z" }]]);
  const host = mount(<AssistantMessage message={message} toolResultsByCallId={results} activeToolCallId={null} />, { path: "/agent" }).host;
  const line = host.querySelectorAll<HTMLElement>('[data-slot="tool-run-line"]');
  expect(line.length).toBe(1);
  expect(line[0]!.textContent).toContain("Updated task");
  // Beside the line's button, not in it: a link of its own.
  const head = host.querySelector<HTMLElement>('[data-slot="tool-run-head"]')!;
  const chip = head.querySelector<HTMLAnchorElement>('a[data-slot="task-chip"]');
  expect(chip?.getAttribute("data-task-id")).toBe(A);
  expect(chip?.querySelector('[data-slot="task-chip-title"]')?.textContent).toBe("Prices from one source");
  expect(line[0]!.querySelectorAll('[data-slot="task-chip"]').length).toBe(0);
  // Pressed, it opens the task (here, in a tab of its own in the agent's panel), and the run stays shut.
  act(() => { chip!.click(); });
  expect(useAgentPageUi.getState()).toMatchObject({ active: `task:${A}`, tabs: [`task:${A}`] });
  expect(line[0]!.getAttribute("aria-expanded")).toBe("false");
});

// A live run of several calls names its current one, and
// that one's task keeps its chip.
test("a live run of task calls keeps the current call's chip", () => {
  act(() => { useTaskBoardStore.getState().replaceAll([taskDto(A, { title: "Prices from one source", status: "progress" })]); });
  const rows = [
    { call: { toolCallId: "c1", toolName: "task_board", args: { action: "read", taskId: A } }, result: { result: "[Task …]" }, isRunning: false },
    { call: { toolCallId: "c2", toolName: "task_board", args: { action: "comment", taskId: A, text: "x" } }, result: null, isRunning: true }
  ];
  const host = mount(<ToolRun rows={rows as never} live />, { path: "/agent" }).host;
  const head = host.querySelector<HTMLElement>('[data-slot="tool-run-head"]')!;
  expect(head.querySelector('[data-slot="tool-run-line"]')!.textContent).toContain("Commented on task");
  expect(head.querySelector('a[data-slot="task-chip"]')?.getAttribute("data-task-id")).toBe(A);
});
