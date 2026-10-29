import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { toast } from "sonner";
import { useState } from "react";
import { BackgroundTasksList, BackgroundTasksPanel } from "@/routes/window/chat/BackgroundTasksList";
import { useBackgroundTasksStore } from "@/store/background-tasks";
import { useAgentChatStore } from "@/store/agent-chat";
import { formatCalendarDate, formatClockMinutes } from "@/lib/format";
import { fakePhoneWidth } from "../fake-phone-width";
import type { BackgroundTaskDto } from "@shared/api-contracts";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch, type FetchCall } from "../helpers/fetch.js";
import { mount, settle, settleUntil } from "../helpers/mount.js";
import { resetBackgroundTasksStore } from "../helpers/subagent-client.js";

afterEach(() => {
  // Unmount before the stores the list reads are reset under it.
  runCleanups();
  act(() => {
    resetBackgroundTasksStore();
    useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
  });
});

const DAY = 86_400_000;

/** Thread thr_a's tasks, their times taken back from one `now`, so a clock
 *  reads mid-second and the day of each is known. */
function tasksAt(now: number) {
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  const task = (id: string, patch: Partial<BackgroundTaskDto>): BackgroundTaskDto => ({
    id, kind: "subagent", parentThreadId: "thr_a", childThreadId: `thr_c_${id}`, type: "general", title: id,
    status: "running", stoppedBy: null, error: null,
    createdAt: at(80_000), startedAt: at(72_500), finishedAt: null,
    seq: patch.status === undefined || patch.status === "running" ? 2 : patch.status === "queued" ? 1 : 3, exitCode: null, command: null, outputPath: null, ...patch
  });
  return {
    at,
    running: task("task_run", { title: "Find the retry call sites" }),
    queued: task("task_queue", { title: "API changes since 0.71", status: "queued", createdAt: at(41_500), startedAt: null }),
    done: task("task_done", {
      title: "0.71 retrospective", status: "finished",
      createdAt: at(260_000), startedAt: at(253_000), finishedAt: at(1_000)
    }),
    stopped: task("task_stop", { title: "Benchmark notes", status: "stopped", stoppedBy: "user", createdAt: at(130_000), startedAt: at(123_000), finishedAt: at(60_000) }),
    neverRan: task("task_never", { title: "Old upgrade guide", status: "stopped", stoppedBy: "agent", createdAt: at(3 * DAY + 5_000), startedAt: null, finishedAt: at(3 * DAY) })
  };
}

function seed(tasks: BackgroundTaskDto[]) {
  act(() => useBackgroundTasksStore.setState({ byThread: new Map([["thr_a", tasks]]) }));
}

/** What each task answered, as its detail gives it once it has ended. */
const REPLIES: Record<string, string> = {
  task_done: "What slipped in 0.71: the cache change and the retry fix; the next release moves both earlier.",
  task_run: "Two call sites, both in the wake path."
};

/** The server as the list meets it: a task's detail as the store holds the
 *  task (its reply once it has ended); a subagent's conversation by its id
 *  (an empty one unless a page is given); `first` answers anything it knows. */
function serve(pages: Record<string, unknown> = {}, first?: (call: FetchCall) => Response | Promise<Response> | null): FetchCall[] {
  return mockFetch((call) => {
    const answered = first?.(call);
    if (answered) return answered;
    const detail = /\/api\/agents\/tasks\/([^/?]+)$/.exec(call.url)?.[1];
    if (detail && call.method === "GET") {
      const task = useBackgroundTasksStore.getState().byThread.get("thr_a")?.find((shown) => shown.id === detail);
      if (!task) return jsonResponse({ error: "No such task." }, 404);
      const ended = task.status !== "running" && task.status !== "queued";
      return jsonResponse({ task, brief: `The brief of ${task.title}.`, reply: ended ? REPLIES[task.id] ?? null : null, stepCount: 0 });
    }
    const id = /\/api\/agents\/threads\/([^/?]+)/.exec(call.url)?.[1] ?? "";
    return jsonResponse(pages[id] ?? { thread: { id }, messages: [], hasMore: false, contextUsage: null, activeWake: null, readAt: null });
  });
}

/** The running subagent's conversation: its wake is on a read. */
function runningChildPage(at: (msAgo: number) => string) {
  return {
    thread: { id: "thr_c_task_run" }, hasMore: false, contextUsage: null, readAt: at(0),
    activeWake: { wakeId: "w_run", startedAt: at(72_000) },
    messages: [{
      id: "m1", threadId: "thr_c_task_run", seq: 1, role: "assistant", source: "self", sourceThreadId: null, wakeId: "w_run", createdAt: at(70_000),
      content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "call_read", toolName: "read", args: { path: "/repo/CHANGELOG.md" } }] }
    }]
  };
}

/** The list as data, each section and its rows: no DOM node reaches an expectation. */
function sections() {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="background-tasks-section"]')].map((section) => ({
    section: section.getAttribute("data-section"),
    rows: [...section.querySelectorAll<HTMLElement>('[data-slot="background-task-row"]')].map((row) => ({
      name: row.querySelector('[data-slot="background-task-name"]')?.textContent ?? null,
      line: row.querySelector('[data-slot="background-task-step"], [data-slot="background-task-outcome"]')?.textContent ?? null,
      time: row.querySelector('[data-slot="background-task-clock"], [data-slot="background-task-time"]')?.textContent ?? null,
      stop: row.querySelector('button[aria-label^="Stop"]') !== null
    }))
  }));
}

const text = (selector: string) => document.querySelector(selector)?.textContent ?? null;
const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const bodyText = () => document.body.textContent ?? "";

async function press(target: HTMLElement) {
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** What toast.error was told, for the test's length. */
function toastErrors(): string[] {
  const shown: string[] = [];
  const original = toast.error;
  toast.error = ((message: unknown) => { shown.push(String(message)); return 0; }) as typeof toast.error;
  onCleanup(() => { toast.error = original; });
  return shown;
}

test("running and queued tasks come first, each with its step or Queued, a clock and Stop; then the ones done, latest first, with how each ended, for how long and when", async () => {
  const now = Date.now();
  const t = tasksAt(now);
  serve({ thr_c_task_run: runningChildPage(t.at) });
  // As the server lists them: newest first.
  seed([t.queued, t.running, t.stopped, t.done, t.neverRan]);
  mount(<BackgroundTasksList threadId="thr_a" />, { path: "/threads/thr_a" });
  // The running one says the call its subagent is on, read from the subagent's own conversation.
  await settleUntil(() => sections()[0]?.rows[0]?.line === "Reading CHANGELOG.md…", "the running task's step");
  expect(text('[data-slot="background-tasks-counts"]')).toBe("1 running · 1 queued");
  expect(sections()).toEqual([
    { section: "running", rows: [{ name: "Find the retry call sites · Subagent", line: "Reading CHANGELOG.md…", time: expect.stringMatching(/^1m 1\ds$/), stop: true }] },
    // A queued one has no clock: it has not started.
    { section: "queued", rows: [{ name: "API changes since 0.71 · Subagent", line: "Queued", time: null, stop: true }] },
    { section: "done", rows: [
      { name: "0.71 retrospective · Subagent", line: "Finished · 4m 12s", time: formatClockMinutes(t.done.finishedAt), stop: false },
      { name: "Benchmark notes · Subagent", line: "Stopped · 1m 03s", time: formatClockMinutes(t.stopped.finishedAt), stop: false },
      // Stopped before it started: no time it ran. Ended days ago: its date, not a clock that reads as today.
      { name: "Old upgrade guide · Subagent", line: "Stopped", time: formatCalendarDate(t.neverRan.finishedAt, now), stop: false }
    ] }
  ]);
});

test("Stop asks the server to stop that task; the change it brings moves the task to Done", async () => {
  const t = tasksAt(Date.now());
  const stopped: BackgroundTaskDto = { ...t.running, status: "stopped", seq: 9, stoppedBy: "user", finishedAt: t.at(0) };
  const calls = serve({}, ({ url, method }) => (method === "POST" && url.endsWith("/api/agents/tasks/task_run/stop") ? jsonResponse({ task: stopped }) : null));
  seed([t.running]);
  mount(<BackgroundTasksList threadId="thr_a" />, { path: "/threads/thr_a" });
  await press(button("Stop Find the retry call sites")!);
  await settleUntil(() => calls.some((call) => call.method === "POST"), "the stop request");
  const posts = calls.filter((call) => call.method === "POST").map((call) => call.url);
  expect(posts.length).toBe(1);
  expect(posts[0]!.endsWith("/api/agents/tasks/task_run/stop")).toBe(true);
  // The task's change, as the event stream brings it.
  act(() => useBackgroundTasksStore.getState().apply(stopped));
  expect(sections()).toEqual([
    { section: "done", rows: [{ name: "Find the retry call sites · Subagent", line: "Stopped · 1m 12s", time: formatClockMinutes(stopped.finishedAt), stop: false }] }
  ]);
});

test("a stop the server refuses is said, in the server's words, and the task stays with its Stop usable again", async () => {
  const errors = toastErrors();
  const t = tasksAt(Date.now());
  serve({}, ({ method }) => (method === "POST" ? jsonResponse({ error: "No running task task_run of this conversation." }, 404) : null));
  seed([t.running]);
  mount(<BackgroundTasksList threadId="thr_a" />, { path: "/threads/thr_a" });
  await press(button("Stop Find the retry call sites")!);
  await settleUntil(() => errors.length > 0, "the refusal said");
  expect(errors).toStrictEqual(["Couldn't stop “Find the retry call sites”: No running task task_run of this conversation."]);
  expect(sections().map((section) => section.section)).toEqual(["running"]);
  await settleUntil(() => button("Stop Find the retry call sites")?.disabled === false, "Stop usable again");
});

test("a row opens its steps and reply in the list's place; ‹ goes back to the list", async () => {
  const t = tasksAt(Date.now());
  serve();
  seed([t.done, t.stopped]);
  mount(<BackgroundTasksList threadId="thr_a" />, { path: "/threads/thr_a" });
  await press(document.querySelector<HTMLElement>('[data-slot="background-task-row"][data-status="finished"]')!);
  await settleUntil(() => bodyText().includes("the cache change and the retry fix"), "its reply");
  // The list gave way to the task: no sections, one ‹ (the task's own), no ×.
  expect(document.querySelectorAll('[data-slot="background-tasks-section"]').length).toBe(0);
  expect(document.querySelectorAll('button[aria-label="All background tasks"]').length).toBe(1);
  expect(button("Close") === null).toBe(true);
  await press(button("All background tasks")!);
  expect(sections().map((section) => [section.section, section.rows.length])).toEqual([["done", 2]]);
});

test("an open task that finishes stays open, its reply in place", async () => {
  const t = tasksAt(Date.now());
  serve();
  seed([t.running]);
  mount(<BackgroundTasksList threadId="thr_a" />, { path: "/threads/thr_a" });
  await press(document.querySelector<HTMLElement>('[data-slot="background-task-row"][data-status="running"] button')!);
  await settleUntil(() => document.querySelectorAll('[data-slot="background-tasks-section"]').length === 0, "its steps open");
  act(() => useBackgroundTasksStore.getState().apply({ ...t.running, status: "finished", seq: 9, finishedAt: t.at(0) }));
  await settleUntil(() => bodyText().includes("Two call sites, both in the wake path."), "its reply, in place");
  expect(document.querySelectorAll('[data-slot="background-tasks-section"]').length).toBe(0);
});

test("in a sheet one header row keeps ‹ and × at its ends at both levels, and × closes", async () => {
  let closed = 0;
  const t = tasksAt(Date.now());
  serve();
  seed([t.done]);
  mount(<BackgroundTasksList threadId="thr_a" onClose={() => { closed += 1; }} />, { path: "/threads/thr_a" });
  expect(text('[data-slot="background-tasks-counts"]')).toBe("");
  // The list: nothing to go back to; × at the end.
  expect([button("All background tasks") === null, button("Close") === null]).toEqual([true, false]);
  await press(document.querySelector<HTMLElement>('[data-slot="background-task-row"]')!);
  await settleUntil(() => bodyText().includes("What slipped in 0.71"), "its reply");
  // One ‹ and one ×, both the header row's: the task's own header has no second ‹.
  expect(document.querySelectorAll('button[aria-label="All background tasks"]').length).toBe(1);
  expect(document.querySelectorAll('button[aria-label="Close"]').length).toBe(1);
  await press(button("Close")!);
  expect(closed).toBe(1);
  await press(button("All background tasks")!);
  expect(sections().map((section) => section.section)).toEqual(["done"]);
});

/** The desktop popover against a button it opens from, and a field beside
 *  it; `close` closes it from outside, as a press elsewhere does. */
function panelHost() {
  let close!: () => void;
  function Host() {
    const [open, setOpen] = useState(true);
    const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
    close = () => setOpen(false);
    return (
      <>
        <button ref={setAnchor} type="button" aria-label="Thread actions">⋯</button>
        <input aria-label="Elsewhere" />
        {anchor && <BackgroundTasksPanel threadId="thr_a" open={open} onOpenChange={setOpen} anchor={anchor} side="bottom" align="end" />}
      </>
    );
  }
  mount(<Host />, { path: "/threads/thr_a" });
  return { close: () => act(() => close()) };
}

test("closed by Esc the list gives focus back to what it opened from; closed by a press elsewhere it leaves focus there", async () => {
  const t = tasksAt(Date.now());
  serve();
  seed([t.done]);
  panelHost();
  await settleUntil(() => document.querySelector('[data-slot="background-tasks-popover"] [data-slot="background-task-row"]') !== null, "the list open");
  const row = document.querySelector<HTMLElement>('[data-slot="background-tasks-popover"] [data-slot="background-task-row"]')!;
  act(() => row.focus());
  await act(async () => {
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settleUntil(() => document.activeElement?.getAttribute("aria-label") === "Thread actions", "focus back on what it opened from");
  runCleanups();

  serve();
  seed([t.done]);
  const second = panelHost();
  await settleUntil(() => document.querySelector('[data-slot="background-tasks-popover"]') !== null, "the list open again");
  const elsewhere = document.querySelector<HTMLInputElement>('input[aria-label="Elsewhere"]')!;
  act(() => elsewhere.focus());
  second.close();
  await settleUntil(() => document.querySelector('[data-slot="background-tasks-popover"]') === null, "the list closed");
  await settle(20);
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Elsewhere");
});

// Opened from a list scrolled down, a task's detail would open as far down,
// its header (‹, its title, Stop) out of sight.
test("a task opened from a list scrolled down opens at its top; ‹ goes back to where the list was", async () => {
  const t = tasksAt(Date.now());
  serve();
  seed([t.running, t.queued, t.done, t.stopped, t.neverRan]);
  panelHost();
  await settleUntil(() => document.querySelector('[data-slot="background-tasks-popover"] [data-slot="background-task-row"][data-status="finished"]') !== null, "the list open");
  const popover = document.querySelector<HTMLElement>('[data-slot="background-tasks-popover"]')!;
  popover.scrollTop = 300;
  await press(document.querySelector<HTMLElement>('[data-slot="background-task-row"][data-status="finished"]')!);
  await settleUntil(() => document.querySelectorAll('[data-slot="background-tasks-section"]').length === 0, "its steps open");
  expect(popover.scrollTop).toBe(0);
  await press(button("All background tasks")!);
  expect(popover.scrollTop).toBe(300);
});

test("on a phone the sheet closed gives focus back to what it opened from", async () => {
  onCleanup(fakePhoneWidth(390));
  const t = tasksAt(Date.now());
  serve();
  seed([t.done]);
  panelHost();
  await settleUntil(() => document.querySelector('[data-slot="background-tasks-sheet"]') !== null, "the sheet open");
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settleUntil(() => document.activeElement?.getAttribute("aria-label") === "Thread actions", "focus back on what it opened from");
});

// A Stop on its way while its task moves to another section (queued to
// running): the row is drawn anew there, and Stop is still on its way.
test("a Stop on its way stays so when its task moves to another section: no second request goes", async () => {
  const t = tasksAt(Date.now());
  let answer!: (response: Response) => void;
  const posts = mockFetch(({ method, url }) => {
    if (method === "POST") return new Promise<Response>((resolve) => { answer = resolve; });
    const id = /\/api\/agents\/threads\/([^/?]+)/.exec(url)?.[1] ?? "";
    return jsonResponse({ thread: { id }, messages: [], hasMore: false, contextUsage: null, activeWake: null, readAt: null });
  });
  seed([t.queued]);
  mount(<BackgroundTasksList threadId="thr_a" />, { path: "/threads/thr_a" });
  await press(button("Stop API changes since 0.71")!);
  expect(button("Stop API changes since 0.71")!.disabled).toBe(true);
  // It starts before the stop reaches it.
  act(() => useBackgroundTasksStore.getState().apply({ ...t.queued, status: "running", seq: 4, startedAt: t.at(0) }));
  expect(sections().map((section) => section.section)).toEqual(["running"]);
  expect(button("Stop API changes since 0.71")!.disabled).toBe(true);
  await press(button("Stop API changes since 0.71")!);
  expect(posts.filter((call) => call.method === "POST").length).toBe(1);
  await act(async () => { answer(jsonResponse({ task: { ...t.queued, status: "stopped", seq: 9, stoppedBy: "user", startedAt: t.at(0), finishedAt: t.at(0) } })); });
  await settleUntil(() => sections()[0]?.section === "done", "the stopped task in Done");
});

test("Show older reads the next page into Done, says why it could not, waits while it reads, and goes once none are left; done ones are not counted", async () => {
  const t = tasksAt(Date.now());
  const shown = toastErrors();
  let older: Promise<Response> | null = null;
  let answerOlder!: (response: Response) => void;
  const calls = serve({}, ({ url }) => {
    if (url.endsWith("/api/agents/threads/thr_a/tasks")) return jsonResponse({ tasks: [t.running, t.done], olderDone: "cursor-1", seq: 9 });
    if (!url.includes("?before=cursor-1")) return null;
    if (older === null) return jsonResponse({ error: "Server restarting." }, 503);
    return older;
  });
  await act(() => useBackgroundTasksStore.getState().load("thr_a"));
  mount(<BackgroundTasksList threadId="thr_a" />, { path: "/threads/thr_a" });
  const more = () => document.querySelector<HTMLButtonElement>('[data-slot="background-tasks-older"]');
  expect([text('[data-slot="background-tasks-counts"]'), sections().map((s) => [s.section, s.rows.length]), more()?.textContent]).toEqual(["1 running", [["running", 1], ["done", 1]], "Show older"]);
  await press(more()!);
  await settleUntil(() => shown.length === 1, "why it could not");
  expect([shown, more()?.disabled]).toEqual([["Couldn't load older tasks: Server restarting."], false]);
  older = new Promise<Response>((resolve) => { answerOlder = resolve; });
  await press(more()!);
  // One read at a time: it waits, and says so.
  expect(more()?.disabled).toBe(true);
  answerOlder(jsonResponse({ tasks: [t.stopped, t.neverRan], olderDone: null, seq: 9 }));
  await settleUntil(() => more() === null, "none left");
  expect([text('[data-slot="background-tasks-counts"]'), sections().find((s) => s.section === "done")!.rows.map((row) => row.name)]).toEqual(["1 running", ["0.71 retrospective · Subagent", "Benchmark notes · Subagent", "Old upgrade guide · Subagent"]]);
  expect(calls.filter((call) => call.url.includes("?before=")).length).toBe(2);
});

test("a running command's row says its output's last line, else Running; a done one how it exited and for how long", async () => {
  const now = Date.now();
  const t = tasksAt(now);
  const run = { ...t.running, id: "task_cmd", kind: "command" as const, childThreadId: null, title: "Run the e2e suite", command: "make e2e", outputPath: "/out/a.log" };
  const lint = { ...t.done, id: "task_lint", kind: "command" as const, childThreadId: null, title: "Lint the whole tree", status: "failed" as const, exitCode: 1, error: "exit 1", command: "make lint", outputPath: "/out/b.log",
    startedAt: t.at(190_000), finishedAt: t.at(1_000) };
  serve();
  seed([run, lint]);
  mount(<BackgroundTasksList threadId="thr_a" />, { path: "/threads/thr_a" });
  await settleUntil(() => sections().length === 2, "the two sections");
  expect(sections()[0]!.rows[0]!.line).toBe("Running");
  act(() => { useBackgroundTasksStore.getState().applyOutput({ taskId: "task_cmd", parentThreadId: "thr_a", lastLine: "ok 12 - retries", bytes: 10, lines: 2 }); });
  expect(sections()[0]!.rows[0]).toMatchObject({ name: "Run the e2e suite · Command", line: "ok 12 - retries", stop: true });
  expect(sections()[1]!.rows[0]).toMatchObject({ name: "Lint the whole tree · Command", line: "Exit 1 · 3m 09s", stop: false });
});
