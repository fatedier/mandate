import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import type { BackgroundTaskDto } from "@shared/api-contracts";
import { AssistantMessage } from "@/routes/window/chat/AssistantMessage";
import type { ToolResultSpec } from "@/routes/window/chat/tool-run-summary";
import { useAgentChatStore, type AgentMessage } from "@/store/agent-chat";
import { refetchBackgroundTasks, useBackgroundTasksStore } from "@/store/background-tasks";
import { fakePhoneWidth } from "../fake-phone-width";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle, settleUntil } from "../helpers/mount.js";
import { backgroundTask, resetBackgroundTasksStore, subagentPage, taskDetail } from "../helpers/subagent-client.js";
import { agentMessage } from "../helpers/typed.js";

// A subagent is a line of its own where it started, out of its run, as a
// question's line is: what it is, its job, the step it is on (or how it
// ended), and how long it has run. A click opens its steps in place; the
// transcript neither scrolls to anything nor opens anything.

beforeEach(() => { setSystemTime(new Date("2026-10-18T09:01:13.000Z")); });
afterEach(() => {
  runCleanups();
  setSystemTime();
  // Its box and its sheet portal into document.body, outside the host.
  document.body.innerHTML = "";
  resetBackgroundTasksStore();
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
});

const SUB = { toolCallId: "c-sub", toolName: "subagent", args: { title: "0.72 release notes", task: "Summarise what changed in 0.72 from the material below." } };
const GREP = { toolCallId: "c-grep", toolName: "bash", args: { command: "git log --oneline v0.71.0..HEAD", description: "List the commits since 0.71" } };
const started: ToolResultSpec = { result: { taskId: "task_1", status: "started", message: "Started the subagent “0.72 release notes”." }, createdAt: "2026-10-18T09:00:01.000Z" };

function reply(threadId: string, calls: Array<{ toolCallId: string; toolName: string; args: unknown }>): AgentMessage {
  return agentMessage({ id: `a-${threadId}`, threadId, role: "assistant", source: "self", wakeId: "w_parent", createdAt: "2026-10-18T09:00:00.000Z", content: { type: "assistant", text: "", toolCalls: calls } });
}
const task = (over: Partial<BackgroundTaskDto> = {}) => backgroundTask({ childThreadId: "thr_child_l", ...over });
function hold(threadId: string, ...tasks: BackgroundTaskDto[]) {
  act(() => { useBackgroundTasksStore.setState({ byThread: new Map([[threadId, tasks]]) }); });
}
/** Its conversation, and its detail as GET agentTask answers it. */
function serveChild(stage: "on" | "done") {
  return mockFetch(({ url }) => (url.includes("/api/agents/threads/thr_child_l")
    ? jsonResponse(subagentPage("thr_child_l", stage))
    : /\/api\/agents\/tasks\/task_1$/.test(url)
      ? jsonResponse(taskDetail(task(stage === "done" ? { status: "finished", finishedAt: "2026-10-18T09:04:13.000Z" } : {}), { stepCount: stage === "done" ? 3 : 2 }))
      : jsonResponse({ error: "not served" }, 500)));
}
/** Opens the folded steps in `scope`. */
async function openSteps(scope: string) {
  await settleUntil(() => document.querySelector(`${scope} [data-slot="task-steps-toggle"]`) !== null, "its Steps");
  await act(async () => { document.querySelector<HTMLElement>(`${scope} [data-slot="task-steps-toggle"]`)!.click(); });
}
async function render(message: AgentMessage, results: Map<string, ToolResultSpec>, onToolExpandedChange?: (id: string, open: boolean) => void) {
  const { host } = await mountAsync(
    <AssistantMessage message={message} toolResultsByCallId={results} activeToolCallId={null} onToolExpandedChange={onToolExpandedChange} />,
    { path: "/threads/thr_m" }
  );
  return host;
}
/** A task that ended after task_1: the one page of thr_m read, with older done ones left unread. */
const LATER = task({ id: "task_9", title: "A later job", status: "finished", finishedAt: "2026-10-18T09:05:00.000Z" });
function holdPaged() {
  act(() => {
    useBackgroundTasksStore.setState({ byThread: new Map([["thr_m", [LATER]]]), pages: new Map([["thr_m", { olderDone: "cursor-9", loadingOlder: false, seq: 60 }]]) });
  });
}
const line = (host: ParentNode) => host.querySelector<HTMLElement>('[data-slot="subagent-line"]');
const text = (host: ParentNode, slot: string) => host.querySelector(`[data-slot="${slot}"]`)?.textContent ?? null;

test("a subagent that started is a line of its own, still: its job and that it runs, its progress being on the strip; its call leaves the run", async () => {
  hold("thr_m", task());
  const calls = mockFetch(() => jsonResponse({ error: "not served" }, 500));
  const host = await render(reply("thr_m", [GREP, SUB]), new Map([["c-grep", { result: "abc", createdAt: "2026-10-18T09:00:00.500Z" }], ["c-sub", started]]));
  await settleUntil(() => line(host) !== null, "its line");
  expect(text(host, "subagent-line-text")).toBe("Subagent · 0.72 release notes · Running");
  // No clock, nothing turning or shimmering, and no step read for it.
  expect(text(host, "subagent-line-clock")).toBe(null);
  expect(line(host)!.querySelector('[data-slot="working-glyph"], .text-shimmer') === null).toBe(true);
  expect(line(host)!.querySelector('[data-slot="task-mark"]')).not.toBe(null);
  expect(calls).toHaveLength(0);
  expect(line(host)!.tagName).toBe("BUTTON");
  // The run keeps the other call, alone: its line is that call's.
  expect(text(host, "tool-run-line")).toContain("List the commits since 0.71");
  expect(host.querySelector('[data-slot="tool-run-count"]') === null).toBe(true);
});

test("a call the server refused, or one still on its way, started nothing: it stays in its run, with no line", async () => {
  hold("thr_m", task());
  const refused = await render(reply("thr_m", [SUB]), new Map([["c-sub", { result: { error: "Write the task: the subagent sees nothing else." }, createdAt: "2026-10-18T09:00:01.000Z" }]]));
  expect(line(refused) === null).toBe(true);
  expect(refused.querySelector('[data-slot="tool-run-line"]') !== null).toBe(true);
  runCleanups();
  const onItsWay = await render(reply("thr_m", [SUB]), new Map());
  expect(line(onItsWay) === null).toBe(true);
  expect(onItsWay.querySelector('[data-slot="tool-run-line"]') !== null).toBe(true);
});

test("an ended one says how it ended and how long it ran; a queued one, or one stopped before it started, has no clock; none reads anything more", async () => {
  const calls = mockFetch(() => jsonResponse({ error: "not served" }, 500));
  const states: Array<[Partial<BackgroundTaskDto>, string, string | null]> = [
    [{ status: "finished", finishedAt: "2026-10-18T09:04:13.000Z" }, "Finished", "· 4m 12s"],
    [{ status: "finished", finishedAt: "2026-10-18T09:00:43.000Z" }, "Finished", "· 42s"],
    [{ status: "stopped", stoppedBy: "user", finishedAt: "2026-10-18T09:01:04.000Z" }, "Stopped", "· 1m 03s"],
    [{ status: "failed", error: "model error", finishedAt: "2026-10-18T09:02:11.000Z" }, "Failed", "· 2m 10s"],
    [{ status: "interrupted", finishedAt: "2026-10-18T09:00:31.000Z" }, "Interrupted", "· 30s"],
    [{ status: "queued", startedAt: null }, "Queued", null],
    [{ status: "stopped", stoppedBy: "user", startedAt: null, finishedAt: "2026-10-18T09:00:31.000Z" }, "Stopped", null]
  ];
  const seen: Array<[string | null, string | null]> = [];
  for (const [over] of states) {
    hold("thr_m", task(over));
    // Unmounted one by one, not by runCleanups: that would also put the
    // real fetch back, and `calls` would then see only the first.
    const { host, unmount } = await mountAsync(
      <AssistantMessage message={reply("thr_m", [SUB])} toolResultsByCallId={new Map([["c-sub", started]])} activeToolCallId={null} />,
      { path: "/threads/thr_m" }
    );
    seen.push([text(host, "subagent-line-state"), text(host, "subagent-line-clock")]);
    unmount();
  }
  expect(seen).toStrictEqual(states.map(([, state, clock]) => [` · ${state}`, clock]));
  expect(calls).toHaveLength(0);
});

test("a click opens its steps in a box at the line; nothing in the transcript opens or scrolls", async () => {
  hold("thr_m", task({ status: "finished", finishedAt: "2026-10-18T09:04:13.000Z" }));
  serveChild("done");
  let scrolled = 0;
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, writable: true, value: () => { scrolled += 1; } });
  onCleanup(() => {
    if (descriptor) Object.defineProperty(Element.prototype, "scrollIntoView", descriptor);
    else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
  const opened: string[] = [];
  const host = await render(reply("thr_m", [SUB]), new Map([["c-sub", started]]), (id) => opened.push(id));
  await act(async () => { line(host)!.click(); });
  await openSteps('[data-slot="task-steps-popover"]');
  await settleUntil(() => document.querySelectorAll('[data-slot="task-steps-popover"] [data-slot="tool-call"]').length === 3, "its steps in the box");
  const box = document.querySelector('[data-slot="task-steps-popover"]')!;
  expect(box.querySelector('[data-slot="task-steps-title"]')!.textContent).toBe("Subagent · 0.72 release notes");
  expect(box.querySelector('[data-slot="bottom-sheet-body"]') === null).toBe(true);
  expect([opened, scrolled]).toEqual([[], 0]);
});

test("on a phone its steps rise in the sheet: a step opens its details, ‹ and Esc go back to the steps, the next Esc closes it", async () => {
  onCleanup(fakePhoneWidth(390));
  hold("thr_m", task());
  serveChild("on");
  const host = await render(reply("thr_m", [SUB]), new Map([["c-sub", started]]));
  await act(async () => { line(host)!.click(); });
  const open = '[data-slot="task-steps-sheet"]:not([data-state="closed"])';
  const steps = () => [...document.querySelectorAll<HTMLElement>(`${open} [data-slot="tool-call"]`)];
  await openSteps(open);
  await settleUntil(() => steps().length === 2, "its steps in the sheet");
  expect(document.querySelector(`${open} [data-slot="bottom-sheet-body"]`) !== null).toBe(true);
  await act(async () => { steps()[0]!.click(); });
  expect(document.querySelector(`${open} [data-slot="tool-details"]`) !== null).toBe(true);
  await act(async () => { document.querySelector<HTMLElement>(`${open} [aria-label="All steps"]`)!.click(); });
  expect(steps().length).toBe(2);
  await act(async () => { steps()[1]!.click(); });
  const escape = () => act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  escape();
  expect(document.querySelector(`${open} [data-slot="tool-details"]`) === null).toBe(true);
  expect(steps().length).toBe(2);
  escape();
  expect(document.querySelector(open) === null).toBe(true);
});

test("until the conversation's tasks are read the line names the job alone, and is not a control", async () => {
  let answer!: (response: Response) => void;
  mockFetch(() => new Promise<Response>((resolve) => { answer = resolve; }));
  const host = await render(reply("thr_m2", [SUB]), new Map([["c-sub", started]]));
  expect(line(host)!.tagName).toBe("P");
  expect(text(host, "subagent-line-text")).toBe("Subagent · 0.72 release notes");
  await act(async () => { answer(jsonResponse({ tasks: [task({ parentThreadId: "thr_m2", status: "queued", startedAt: null })] })); });
  await settleUntil(() => line(host)?.tagName === "BUTTON", "the task read");
  expect(text(host, "subagent-line-state")).toBe(" · Queued");
});

test("a page subagent's line says Page subagent, before its task is read and after", async () => {
  let answer!: (response: Response) => void;
  mockFetch(() => new Promise<Response>((resolve) => { answer = resolve; }));
  const page = { ...SUB, args: { ...SUB.args, type: "page" } };
  const host = await render(reply("thr_g", [page]), new Map([["c-sub", started]]));
  expect(text(host, "subagent-line-text")).toBe("Page subagent · 0.72 release notes");
  await act(async () => { answer(jsonResponse({ tasks: [task({ parentThreadId: "thr_g", type: "page", status: "queued", startedAt: null })] })); });
  await settleUntil(() => line(host)?.tagName === "BUTTON", "the task read");
  expect(text(host, "subagent-line-text")).toBe("Page subagent · 0.72 release notes · Queued");
});

test("a task older than the pages its conversation's list has read is read by its id: the line says how it ended, and the list stays as read", async () => {
  holdPaged();
  const calls = mockFetch(({ url }) => (/\/api\/agents\/tasks\/task_1$/.test(url)
    ? jsonResponse(taskDetail(task({ status: "finished", finishedAt: "2026-10-18T09:04:13.000Z" })))
    : jsonResponse({ error: "not served" }, 500)));
  const host = await render(reply("thr_m", [SUB]), new Map([["c-sub", started]]));
  await settleUntil(() => text(host, "subagent-line-state") !== null, "how it ended");
  expect([text(host, "subagent-line-state"), text(host, "subagent-line-clock")]).toEqual([" · Finished", "· 4m 12s"]);
  expect(calls.map((c) => c.url)).toStrictEqual(["/api/agents/tasks/task_1"]);
  expect(useBackgroundTasksStore.getState().byThread.get("thr_m")!.map((t) => t.id)).toEqual(["task_9"]);
});

test("a task that could not be read by its id is read again once the stream is back", async () => {
  holdPaged();
  let refuse = true;
  const calls = mockFetch(({ url }) => {
    if (/\/api\/agents\/tasks\/task_1$/.test(url)) {
      return refuse ? jsonResponse({ error: "Server restarting." }, 503) : jsonResponse(taskDetail(task({ status: "finished", finishedAt: "2026-10-18T09:04:13.000Z" })));
    }
    if (url.includes("/api/agents/threads/thr_m/tasks")) return jsonResponse({ tasks: [], seq: 60 });
    return jsonResponse({ error: "not served" }, 500);
  });
  const host = await render(reply("thr_m", [SUB]), new Map([["c-sub", started]]));
  await settleUntil(() => calls.some((c) => c.url.endsWith("/tasks/task_1")), "its read by id");
  await settle(20);
  expect(line(host)!.getAttribute("data-status")).toBe("unread");
  refuse = false;
  await act(() => refetchBackgroundTasks());
  await settleUntil(() => text(host, "subagent-line-state") !== null, "how it ended");
  expect(text(host, "subagent-line-state")).toBe(" · Finished");
});

// A command bash runs in the background is a line too, out of its run: its
// description, its output's last line while it runs, how it exited.
const RUN_E2E = { toolCallId: "c-e2e", toolName: "bash", args: { command: "make e2e", description: "Run the e2e suite", run_in_background: true } };
const backgrounded: ToolResultSpec = { result: { taskId: "task_cmd", status: "running", outputPath: "/out/task_cmd.log", message: "Running in the background as task_cmd…" }, createdAt: "2026-10-18T08:53:40.000Z" };
const command = (over: Partial<BackgroundTaskDto> = {}) => backgroundTask({
  id: "task_cmd", kind: "command", childThreadId: null, title: "Run the e2e suite", command: "make e2e", outputPath: "/out/task_cmd.log",
  createdAt: "2026-10-18T08:53:40.000Z", startedAt: "2026-10-18T08:53:40.000Z", ...over
});

test("a command run in the background is a line: Command, its description, and that it runs, its output on the strip", async () => {
  hold("thr_m", command());
  act(() => { useBackgroundTasksStore.getState().applyOutput({ taskId: "task_cmd", parentThreadId: "thr_m", lastLine: "ok 12 - retries", bytes: 2048, lines: 40 }); });
  mockFetch(() => jsonResponse({ error: "not served" }, 500));
  const host = await render(reply("thr_m", [RUN_E2E]), new Map([["c-e2e", backgrounded]]));
  await settleUntil(() => line(host) !== null, "its line");
  expect(text(host, "subagent-line-text")).toBe("Command · Run the e2e suite · Running");
  expect(text(host, "subagent-line-clock")).toBe(null);
  // Its call left the run.
  expect(host.querySelector('[data-slot="tool-run-line"]') === null).toBe(true);
});

test("a command that ended: how it exited, red when it failed, and how long it ran", async () => {
  hold("thr_m", command({ title: "Lint the whole tree", status: "failed", exitCode: 1, error: "exit 1", startedAt: "2026-10-18T08:50:00.000Z", finishedAt: "2026-10-18T08:53:09.000Z" }));
  mockFetch(() => jsonResponse({ error: "not served" }, 500));
  const host = await render(reply("thr_m", [RUN_E2E]), new Map([["c-e2e", backgrounded]]));
  await settleUntil(() => line(host) !== null, "its line");
  expect(text(host, "subagent-line-text")).toBe("Command · Lint the whole tree · Exit 1");
  expect(text(host, "subagent-line-clock")).toBe("· 3m 09s");
  expect(host.querySelector('[data-slot="subagent-line-state"]')!.classList.contains("text-red")).toBe(true);
});

test("a command's line names its kind before its task is read", async () => {
  mockFetch(() => jsonResponse({ error: "not served" }, 500));
  const host = await render(reply("thr_m", [RUN_E2E]), new Map([["c-e2e", backgrounded]]));
  await settleUntil(() => line(host) !== null, "its line");
  expect(text(host, "subagent-line-text")).toBe("Command · Run the e2e suite");
});
