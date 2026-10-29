import { afterEach, beforeEach, expect, jest, setSystemTime, test } from "bun:test";
import { act, StrictMode, type ReactNode } from "react";
import { MemoryRouter } from "react-router";
import type { BackgroundTaskDto } from "@shared/api-contracts";
import { TaskSteps } from "@/routes/window/chat/TaskSteps";
import { formatClockMinutes } from "@/lib/format";
import { newThreadState, useAgentChatStore } from "@/store/agent-chat";
import { useBackgroundTasks, useBackgroundTasksStore } from "@/store/background-tasks";
import { fakePhoneWidth } from "../fake-phone-width";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch, type FetchHandler } from "../helpers/fetch.js";
import { mountAsync, settle, settleUntil } from "../helpers/mount.js";
import { backgroundTask, resetBackgroundTasksStore, subagentPage, taskDetail } from "../helpers/subagent-client.js";
import { agentMessage } from "../helpers/typed.js";
import { fakeClock } from "../helpers/fake-clock.js";
import { fireAnimation, foldsCloseAnimated } from "../helpers/motion.js";

// A task's steps, where the line, the strip and the list open them: what it
// is and its job, how it stands, Stop while it can be stopped, the calls it
// made as the transcript's own rows, and its reply.

beforeEach(() => { setSystemTime(new Date("2026-10-18T09:01:13.000Z")); });
afterEach(() => {
  runCleanups();
  setSystemTime();
  resetBackgroundTasksStore();
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
});

const task = (childThreadId: string, over: Partial<BackgroundTaskDto> = {}) => backgroundTask({ id: `task_${childThreadId}`, childThreadId, ...over });
const REPLY = "0.72 changes **the retry policy** and drops the legacy cache flag.";
/** Fetch as these tests serve it: a task's detail (GET agentTask) as the
 *  server answers it, everything else by `handler`. */
function mockFetchWithDetails(handler: FetchHandler) {
  return mockFetch((call, index) => {
    const detail = /\/api\/agents\/tasks\/([^/?]+)$/.exec(call.url);
    if (detail && call.method === "GET") {
      const id = decodeURIComponent(detail[1]!);
      return jsonResponse(taskDetail(backgroundTask({ id, childThreadId: id.replace(/^task_/, "") }), { reply: REPLY, stepCount: 3 }));
    }
    return handler(call, index);
  });
}
function serve(childThreadId: string, stage: "waiting" | "on" | "done", extra?: FetchHandler) {
  return mockFetchWithDetails((call, index) => (call.url.includes(`/api/agents/threads/${childThreadId}`)
    ? jsonResponse(subagentPage(childThreadId, stage))
    : extra ? extra(call, index) : jsonResponse({ error: "not served" }, 500)));
}
/** Opens its folded steps. */
const openSteps = (host: ParentNode) => act(async () => { host.querySelector<HTMLElement>('[data-slot="task-steps-toggle"]')!.click(); });
async function render(node: ReactNode) {
  const { host } = await mountAsync(node, { path: "/threads/thr_m" });
  return host;
}
/** A running command's open detail reads its output again every 2 s, by the
 *  clock: tests of that fake the clock and move it on, 100 ms at a time,
 *  letting the reads' promises run between. */
async function advanceUntil(predicate: () => boolean, label: string, rounds = 60) {
  for (let round = 0; round < rounds && !predicate(); round++) {
    await act(async () => {
      jest.advanceTimersByTime(100);
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
  }
  if (!predicate()) throw new Error(`advanceUntil gave up: ${label}`);
}
const text = (host: ParentNode, slot: string) => host.querySelector(`[data-slot="${slot}"]`)?.textContent ?? null;
const phrases = (host: ParentNode) => [...host.querySelectorAll('[data-slot="tool-call"] [data-slot="tool-phrase"]')].map((p) => p.textContent);

test("a running subagent: what it is and its job, Running and its clock, Stop, and its calls as the transcript's rows", async () => {
  serve("thr_child_t1", "on");
  const host = await render(<TaskSteps task={task("thr_child_t1")} />);
  await settleUntil(() => text(host, "task-brief-text") !== null, "what it was asked");
  expect(text(host, "task-brief-text")).toBe("Summarise what changed in 0.72 from the material below.");
  await settleUntil(() => (text(host, "task-step-text") ?? "").includes("release-0.72.md"), "the step it is on");
  expect(text(host, "task-step-text")).toBe("Reading release-0.72.md…");
  await openSteps(host);
  await settleUntil(() => host.querySelectorAll('[data-slot="tool-call"]').length === 2, "its steps");
  expect(text(host, "task-steps-title")).toBe("Subagent · 0.72 release notes");
  expect(text(host, "task-steps-status")).toBe("Running · 1m 12s");
  expect(text(host, "task-stop")).toBe("Stop");
  expect(phrases(host)).toEqual(["ReadCHANGELOG.md", "Readingrelease-0.72.md"]);
  expect(host.querySelector('[data-slot="task-reply"]') === null).toBe(true);
  // A row opens its details in place.
  await act(async () => { host.querySelectorAll<HTMLElement>('[data-slot="tool-call"]')[0]!.click(); });
  expect(host.querySelector('[data-slot="tool-details"]') !== null).toBe(true);
});

test("an ended one: how it ended, how long it ran and when; its steps, and its reply as written; no Stop", async () => {
  serve("thr_child_t2", "done");
  const done = task("thr_child_t2", { status: "finished", finishedAt: "2026-10-18T09:04:13.000Z" });
  const host = await render(<TaskSteps task={done} />);
  // Folded, its steps say how many calls it made.
  await settleUntil(() => text(host, "task-steps-count") !== null, "how many calls it made");
  expect(text(host, "task-steps-count")).toBe("· 3");
  await openSteps(host);
  await settleUntil(() => host.querySelectorAll('[data-slot="tool-call"]').length === 3, "its steps");
  expect(phrases(host)).toEqual(["ReadCHANGELOG.md", "Readrelease-0.72.md", "RanList the commits since 0.71"]);
  expect(text(host, "task-steps-status")).toBe(`Finished · 4m 12s · ${formatClockMinutes("2026-10-18T09:04:13.000Z")}`);
  expect(host.querySelector('[data-slot="task-stop"]') === null).toBe(true);
  const said = host.querySelector('[data-slot="task-reply"]')!;
  expect([said.querySelector("strong")?.textContent, said.lastElementChild?.textContent]).toEqual(["the retry policy", "0.72 changes the retry policy and drops the legacy cache flag."]);
});

test("its steps are live: a call the subagent makes while they are open joins them", async () => {
  serve("thr_child_t3", "on");
  const host = await render(<TaskSteps task={task("thr_child_t3")} />);
  await openSteps(host);
  await settleUntil(() => host.querySelectorAll('[data-slot="tool-call"]').length === 2, "its steps");
  act(() => {
    useAgentChatStore.getState().onMessageAppended("thr_child_t3", agentMessage({
      id: "thr_child_t3-9", threadId: "thr_child_t3", seq: 9, role: "assistant", source: "self", wakeId: "w_child", createdAt: "2026-10-18T09:01:10.000Z",
      content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "k9", toolName: "bash", args: { command: "git log --oneline v0.71.0..HEAD", description: "List the commits since 0.71" } }] }
    }));
  });
  expect(phrases(host)).toEqual(["ReadCHANGELOG.md", "Readingrelease-0.72.md", "RanList the commits since 0.71"]);
});

test("a queued one says it waits its turn, and can be stopped before it starts", async () => {
  serve("thr_child_t4", "waiting");
  const host = await render(<TaskSteps task={task("thr_child_t4", { status: "queued", startedAt: null })} />);
  await settle();
  expect(text(host, "task-steps-status")).toBe("Queued");
  expect(text(host, "task-queued")).toBe("It starts by itself when one of this conversation's running subagents ends.");
  expect(host.querySelector('[data-slot="task-stop"]') !== null).toBe(true);
  expect(host.querySelectorAll('[data-slot="tool-call"]').length).toBe(0);
  expect(host.querySelector('[data-slot="loading-line"]') === null).toBe(true);
});

test("Stop asks the server to stop it; the answer, taken in, ends its clock and takes Stop away", async () => {
  const running = task("thr_child_t5", { parentThreadId: "thr_m5" });
  useBackgroundTasksStore.setState({ byThread: new Map([["thr_m5", [running]]]) });
  const calls = serve("thr_child_t5", "on", ({ url }) => (url.endsWith("/stop")
    ? jsonResponse({ task: { ...running, status: "stopped", seq: 9, stoppedBy: "user", finishedAt: "2026-10-18T09:01:13.000Z" } })
    : jsonResponse({ error: "not served" }, 500)));
  // As every host passes it: the store's copy.
  function Host() {
    const shown = useBackgroundTasks("thr_m5")[0]!;
    return <TaskSteps task={shown} />;
  }
  const host = await render(<Host />);
  await act(async () => { host.querySelector<HTMLElement>('[data-slot="task-stop"]')!.click(); });
  await settleUntil(() => (text(host, "task-steps-status") ?? "").startsWith("Stopped"), "stopped");
  expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["/api/agents/tasks/task_thr_child_t5/stop"]);
  expect(text(host, "task-steps-status")).toBe(`Stopped · 1m 12s · ${formatClockMinutes("2026-10-18T09:01:13.000Z")}`);
  expect(host.querySelector('[data-slot="task-stop"]') === null).toBe(true);
});

test("a failed one says why, its status in red", async () => {
  serve("thr_child_t6", "on");
  const failed = task("thr_child_t6", { status: "failed", error: "Its replies kept reaching the output token limit.", finishedAt: "2026-10-18T09:02:11.000Z" });
  const host = await render(<TaskSteps task={failed} />);
  await settle();
  expect(text(host, "task-error")).toContain("output token limit");
  expect(host.querySelector('[data-slot="task-steps-status"]')!.classList.contains("text-red")).toBe(true);
});

test("given a way back, its header leads with ‹ to what listed it", async () => {
  serve("thr_child_t7", "on");
  let back = 0;
  const host = await render(<TaskSteps task={task("thr_child_t7")} onBack={() => { back += 1; }} />);
  await act(async () => { host.querySelector<HTMLElement>('[aria-label="All background tasks"]')!.click(); });
  expect(back).toBe(1);
});

// The phone sheet: one header row, ‹ · its title and status · Stop · ×.
test("in a phone's sheet what holds it puts its × at the end of the one header row: ‹, the title, Stop, ×", async () => {
  onCleanup(fakePhoneWidth(390));
  serve("thr_child_t8", "on");
  let closed = 0;
  const host = await render(
    <TaskSteps task={task("thr_child_t8")} onBack={() => {}} close={<button type="button" aria-label="Close" onClick={() => { closed += 1; }}>×</button>} />
  );
  const header = host.querySelector('[data-slot="task-steps-header"]')!;
  expect([...header.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["All background tasks", "Stop 0.72 release notes", "Close"]);
  expect(header.querySelector('[data-slot="task-steps-title"]')!.textContent).toBe("Subagent · 0.72 release notes");
  await act(async () => { header.querySelector<HTMLElement>('[aria-label="Close"]')!.click(); });
  expect(closed).toBe(1);
});

test("more steps than one page: older pages are read one after another to its start, each once, under StrictMode too", async () => {
  const id = "thr_child_pages";
  const step = (seq: number, callId: string, file: string) => agentMessage({
    id: `pg-${seq}`, threadId: id, seq, role: "assistant", source: "self", wakeId: "w_child", createdAt: `2026-10-18T09:00:0${seq}.000Z`,
    content: { type: "assistant", text: "", toolCalls: [{ toolCallId: callId, toolName: "read", args: { path: `/repo/${file}` } }] }
  });
  const done = (seq: number, callId: string) => agentMessage({
    id: `pg-${seq}`, threadId: id, seq, role: "tool", source: "self", wakeId: "w_child", createdAt: `2026-10-18T09:00:0${seq}.500Z`,
    content: { type: "tool_result", toolCallId: callId, toolName: "read", result: "…" }
  });
  const calls = mockFetchWithDetails(({ url }) => jsonResponse(url.includes("before=3")
    ? { thread: { id }, messages: [step(1, "k1", "CHANGELOG.md"), done(2, "k1")], hasMore: false }
    : { thread: { id }, messages: [step(3, "k2", "release-0.72.md"), done(4, "k2")], hasMore: true, activeWake: null, readAt: null }));
  const finished = task(id, { status: "finished", finishedAt: "2026-10-18T09:04:13.000Z" });
  const { host } = await mountAsync(<StrictMode><MemoryRouter initialEntries={["/threads/thr_m"]}><TaskSteps task={finished} /></MemoryRouter></StrictMode>);
  await openSteps(host);
  await settleUntil(() => host.querySelectorAll('[data-slot="tool-call"]').length >= 2, "both pages' steps");
  await settle(20);
  expect([...host.querySelectorAll('[data-slot="tool-call"] [data-slot="tool-detail"]')].map((d) => d.textContent)).toEqual(["CHANGELOG.md", "release-0.72.md"]);
  expect(calls.filter((c) => c.url.includes("before=")).length).toBe(1);
});

// Its first page already here (its steps were open before): StrictMode runs
// the read of the older page's effect twice at once, and it still goes out once.
test("opened again once its first page is here, under StrictMode, its older page is read once", async () => {
  const id = "thr_child_pages_again";
  const step = (seq: number, callId: string, file: string) => agentMessage({
    id: `pa-${seq}`, threadId: id, seq, role: "assistant", source: "self", wakeId: "w_child", createdAt: `2026-10-18T09:00:0${seq}.000Z`,
    content: { type: "assistant", text: "", toolCalls: [{ toolCallId: callId, toolName: "read", args: { path: `/repo/${file}` } }] }
  });
  const done = (seq: number, callId: string) => agentMessage({
    id: `pa-${seq}`, threadId: id, seq, role: "tool", source: "self", wakeId: "w_child", createdAt: `2026-10-18T09:00:0${seq}.500Z`,
    content: { type: "tool_result", toolCallId: callId, toolName: "read", result: "…" }
  });
  useAgentChatStore.setState({ threadsByScope: new Map([[`subagent:${id}`, {
    ...newThreadState(), threadId: id, loaded: true, messages: [step(3, "k2", "release-0.72.md"), done(4, "k2")], oldestSeqLoaded: 3, hasMoreOlder: true
  }]]) });
  const calls = mockFetchWithDetails(({ url }) => jsonResponse(url.includes("before=3")
    ? { thread: { id }, messages: [step(1, "k1", "CHANGELOG.md"), done(2, "k1")], hasMore: false }
    : { thread: { id }, messages: [], hasMore: false, activeWake: null, readAt: null }));
  const finished = task(id, { status: "finished", finishedAt: "2026-10-18T09:04:13.000Z" });
  const { host } = await mountAsync(<StrictMode><MemoryRouter initialEntries={["/threads/thr_m"]}><TaskSteps task={finished} /></MemoryRouter></StrictMode>);
  await openSteps(host);
  await settleUntil(() => host.querySelectorAll('[data-slot="tool-call"]').length >= 2, "both pages' steps");
  await settle(20);
  expect([...host.querySelectorAll('[data-slot="tool-call"] [data-slot="tool-detail"]')].map((d) => d.textContent)).toEqual(["CHANGELOG.md", "release-0.72.md"]);
  expect(calls.filter((c) => c.url.includes("before=")).length).toBe(1);
});

// Closed and opened again while an older page is on its way: the page is
// read once, or both answers would join its steps and every step would show twice.
test("closed and opened again while an older page is on its way, its steps read that page once", async () => {
  const id = "thr_child_pages_reopen";
  const step = (seq: number, callId: string, file: string) => agentMessage({
    id: `pr-${seq}`, threadId: id, seq, role: "assistant", source: "self", wakeId: "w_child", createdAt: `2026-10-18T09:00:0${seq}.000Z`,
    content: { type: "assistant", text: "", toolCalls: [{ toolCallId: callId, toolName: "read", args: { path: `/repo/${file}` } }] }
  });
  useAgentChatStore.setState({ threadsByScope: new Map([[`subagent:${id}`, {
    ...newThreadState(), threadId: id, loaded: true, messages: [step(3, "k2", "release-0.72.md")], oldestSeqLoaded: 3, hasMoreOlder: true
  }]]) });
  let answer!: (response: Response) => void;
  const older = new Promise<Response>((resolve) => { answer = resolve; });
  const calls = mockFetchWithDetails(({ url }) => (url.includes("before=3")
    ? older
    : jsonResponse({ thread: { id }, messages: [], hasMore: false, activeWake: null, readAt: null })));
  const finished = task(id, { status: "finished", finishedAt: "2026-10-18T09:04:13.000Z" });
  const first = await mountAsync(<TaskSteps task={finished} />, { path: "/threads/thr_m" });
  await openSteps(first.host);
  await settleUntil(() => calls.some((c) => c.url.includes("before=3")), "the older page asked for");
  first.unmount();
  const { host } = await mountAsync(<TaskSteps task={finished} />, { path: "/threads/thr_m" });
  await openSteps(host);
  await settle(20);
  await act(async () => { answer(jsonResponse({ thread: { id }, messages: [step(1, "k1", "CHANGELOG.md")], hasMore: false })); });
  await settleUntil(() => host.querySelectorAll('[data-slot="tool-call"]').length >= 2, "both pages' steps");
  await settle(20);
  expect([...host.querySelectorAll('[data-slot="tool-call"] [data-slot="tool-detail"]')].map((d) => d.textContent)).toEqual(["CHANGELOG.md", "release-0.72.md"]);
  expect(calls.filter((c) => c.url.includes("before=")).length).toBe(1);
});

test("a subagent's conversation that cannot be read says so, with Retry, instead of loading for good; Retry reads it again", async () => {
  let fail = true;
  mockFetchWithDetails(({ url }) => (url.includes("/api/agents/threads/thr_child_t9")
    ? (fail ? jsonResponse({ error: "Thread not found." }, 404) : jsonResponse(subagentPage("thr_child_t9", "done")))
    : jsonResponse({ error: "not served" }, 500)));
  const host = await render(<TaskSteps task={task("thr_child_t9", { status: "finished", finishedAt: "2026-10-18T09:04:13.000Z" })} />);
  await openSteps(host);
  await settleUntil(() => host.querySelector('[data-slot="inline-error"]') !== null, "the failure said");
  expect(host.querySelector('[data-slot="inline-error"]')!.textContent).toContain("Couldn't load its steps.");
  expect(host.querySelector('[data-slot="inline-error"]')!.textContent).toContain("Thread not found.");
  expect(host.querySelector('[data-slot="loading-line"]') === null).toBe(true);
  fail = false;
  await act(async () => { [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Retry")!.click(); });
  await settleUntil(() => host.querySelectorAll('[data-slot="tool-call"]').length === 3, "its steps");
  expect(host.querySelector('[data-slot="inline-error"]') === null).toBe(true);
});

test("an older page that cannot be read says its earlier steps are missing, with Retry, which reads that page again", async () => {
  const id = "thr_child_pages_fail";
  const step = (seq: number, callId: string, file: string) => agentMessage({
    id: `pf-${seq}`, threadId: id, seq, role: "assistant", source: "self", wakeId: "w_child", createdAt: `2026-10-18T09:00:0${seq}.000Z`,
    content: { type: "assistant", text: "", toolCalls: [{ toolCallId: callId, toolName: "read", args: { path: `/repo/${file}` } }] }
  });
  let fail = true;
  const calls = mockFetchWithDetails(({ url }) => (url.includes("before=3")
    ? (fail ? jsonResponse({ error: "Server restarting." }, 503) : jsonResponse({ thread: { id }, messages: [step(1, "k1", "CHANGELOG.md")], hasMore: false }))
    : jsonResponse({ thread: { id }, messages: [step(3, "k2", "release-0.72.md")], hasMore: true, activeWake: null, readAt: null })));
  // Under StrictMode: the effect that asked is cleaned up before the answer.
  const { host } = await mountAsync(<StrictMode><MemoryRouter initialEntries={["/threads/thr_m"]}>
    <TaskSteps task={task(id, { status: "finished", finishedAt: "2026-10-18T09:04:13.000Z" })} />
  </MemoryRouter></StrictMode>);
  await openSteps(host);
  await settleUntil(() => host.querySelector('[data-slot="inline-error"]') !== null, "the missing steps said");
  expect(host.querySelector('[data-slot="inline-error"]')!.textContent).toContain("Couldn't load its earlier steps.");
  expect([...host.querySelectorAll('[data-slot="tool-call"] [data-slot="tool-detail"]')].map((d) => d.textContent)).toEqual(["release-0.72.md"]);
  fail = false;
  await act(async () => { [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Retry")!.click(); });
  await settleUntil(() => host.querySelectorAll('[data-slot="tool-call"]').length === 2, "the earlier steps");
  expect([...host.querySelectorAll('[data-slot="tool-call"] [data-slot="tool-detail"]')].map((d) => d.textContent)).toEqual(["CHANGELOG.md", "release-0.72.md"]);
  expect(host.querySelector('[data-slot="inline-error"]') === null).toBe(true);
  expect(calls.filter((c) => c.url.includes("before=3")).length).toBe(2);
});

test("reopened while an older page is on its way that then fails, the steps say so, with Retry", async () => {
  const id = "thr_child_pages_reopen_fail";
  const step = (seq: number, callId: string, file: string) => agentMessage({
    id: `prf-${seq}`, threadId: id, seq, role: "assistant", source: "self", wakeId: "w_child", createdAt: `2026-10-18T09:00:0${seq}.000Z`,
    content: { type: "assistant", text: "", toolCalls: [{ toolCallId: callId, toolName: "read", args: { path: `/repo/${file}` } }] }
  });
  useAgentChatStore.setState({ threadsByScope: new Map([[`subagent:${id}`, {
    ...newThreadState(), threadId: id, loaded: true, messages: [step(3, "k2", "release-0.72.md")], oldestSeqLoaded: 3, hasMoreOlder: true
  }]]) });
  let answer!: (response: Response) => void;
  let olderReads = 0;
  mockFetchWithDetails(({ url }) => {
    if (!url.includes("before=3")) return jsonResponse({ thread: { id }, messages: [], hasMore: false, activeWake: null, readAt: null });
    olderReads += 1;
    return olderReads === 1
      ? new Promise<Response>((resolve) => { answer = resolve; })
      : jsonResponse({ thread: { id }, messages: [step(1, "k1", "CHANGELOG.md")], hasMore: false });
  });
  const finished = task(id, { status: "finished", finishedAt: "2026-10-18T09:04:13.000Z" });
  const first = await mountAsync(<TaskSteps task={finished} />, { path: "/threads/thr_m" });
  await openSteps(first.host);
  await settleUntil(() => olderReads === 1, "the older page asked for");
  first.unmount();
  const { host } = await mountAsync(<TaskSteps task={finished} />, { path: "/threads/thr_m" });
  await openSteps(host);
  await act(async () => { answer(jsonResponse({ error: "Server restarting." }, 503)); });
  await settleUntil(() => host.querySelector('[data-slot="inline-error"]') !== null, "the missing steps said");
  expect(host.querySelector('[data-slot="inline-error"]')!.textContent).toContain("Couldn't load its earlier steps.");
  await act(async () => { [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Retry")!.click(); });
  await settleUntil(() => host.querySelectorAll('[data-slot="tool-call"]').length === 2, "the earlier steps");
  expect(olderReads).toBe(2);
});

// Its steps are its whole conversation: read only once a person asks for them.
test("its steps are read only once opened; folded, they say how many calls it made", async () => {
  const calls = serve("thr_child_t10", "done");
  const host = await render(<TaskSteps task={task("thr_child_t10", { status: "finished", finishedAt: "2026-10-18T09:04:13.000Z" })} />);
  await settleUntil(() => text(host, "task-steps-count") !== null, "how many calls it made");
  await settle(20);
  expect(calls.filter((c) => c.url.includes("/api/agents/threads/thr_child_t10")).length).toBe(0);
  expect(host.querySelectorAll('[data-slot="tool-call"]').length).toBe(0);
  expect(host.querySelector('[data-slot="task-steps-toggle"]')!.getAttribute("aria-expanded")).toBe("false");
  await openSteps(host);
  await settleUntil(() => host.querySelectorAll('[data-slot="tool-call"]').length === 3, "its steps");
  expect(calls.filter((c) => c.url.includes("/api/agents/threads/thr_child_t10")).length).toBeGreaterThan(0);
  // Folded again, they are gone from the page.
  await openSteps(host);
  expect(host.querySelectorAll('[data-slot="tool-call"]').length).toBe(0);
});

test("folded again, its steps stay while they fold away and are let go once they have", async () => {
  foldsCloseAnimated();
  // Holds on its conversation, as views take and let go of them.
  let holding = 0;
  const hold = useAgentChatStore.getState().holdThread;
  useAgentChatStore.setState({
    holdThread: (scope) => {
      const release = hold(scope);
      holding += 1;
      let held = true;
      return () => { if (held) { held = false; holding -= 1; } release(); };
    }
  });
  serve("thr_child_t11", "done");
  const host = await render(<TaskSteps task={task("thr_child_t11", { status: "finished", finishedAt: "2026-10-18T09:04:13.000Z" })} />);
  await openSteps(host);
  await settleUntil(() => host.querySelectorAll('[data-slot="tool-call"]').length === 3, "its steps");
  await openSteps(host);
  await settle();
  // Folding away, what shrinks is its steps, not a line that loads them.
  expect([phrases(host).length, host.querySelector('[data-slot="loading-line"]') === null, holding]).toEqual([3, true, 1]);
  fireAnimation(host.querySelector('[data-slot="task-steps-section"] [data-slot="fold"]')!, "animationend", "fold-close");
  await settle();
  expect([host.querySelectorAll('[data-slot="tool-call"]').length, holding]).toEqual([0, 0]);
});

test("what it was asked is a few lines until Show more, then as written; Show less folds it again", async () => {
  // happy-dom lays nothing out: the folded text is given a height longer
  // than its box. Both are Element's; the shadows go with the test.
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get() { return 200; } });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return 80; } });
  onCleanup(() => {
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  });
  const brief = "Write the 0.72 release notes.\n\n## Where to look\n- **CHANGELOG.md** for the entries.";
  mockFetch(({ url }) => (/\/api\/agents\/tasks\/[^/]+$/.test(url)
    ? jsonResponse(taskDetail(backgroundTask({ id: "task_thr_child_t11", childThreadId: "thr_child_t11", status: "finished" }), { brief, reply: "Done." }))
    : jsonResponse({ error: "not served" }, 500)));
  const host = await render(<TaskSteps task={task("thr_child_t11", { status: "finished", finishedAt: "2026-10-18T09:04:13.000Z" })} />);
  await settleUntil(() => host.querySelector('[data-slot="task-brief-fold"]') !== null, "its fold");
  const shown = () => host.querySelector('[data-slot="task-brief-text"]')!;
  expect([shown().tagName, shown().classList.contains("line-clamp-4"), text(host, "task-brief-fold")]).toEqual(["P", true, "Show more"]);
  // Folded, it reads as plain words: no Markdown marks.
  expect(shown().textContent).not.toContain("**");
  await act(async () => { host.querySelector<HTMLElement>('[data-slot="task-brief-fold"]')!.click(); });
  expect([shown().querySelector("strong")?.textContent, shown().querySelector("h3, h4, h5")?.textContent, text(host, "task-brief-fold")]).toEqual(["CHANGELOG.md", "Where to look", "Show less"]);
  await act(async () => { host.querySelector<HTMLElement>('[data-slot="task-brief-fold"]')!.click(); });
  expect(shown().tagName).toBe("P");
});

test("a task that ends while it is open is read again: what it answered appears", async () => {
  const running = task("thr_child_t12", { parentThreadId: "thr_m12" });
  useBackgroundTasksStore.setState({ byThread: new Map([["thr_m12", [running]]]) });
  let ended = false;
  mockFetch(({ url }) => (/\/api\/agents\/tasks\/[^/]+$/.test(url)
    ? jsonResponse(taskDetail({ ...running, status: ended ? "finished" : "running", seq: ended ? 9 : running.seq }, { reply: ended ? "Two call sites, both in the wake path." : null }))
    : url.includes("/api/agents/threads/thr_child_t12") ? jsonResponse(subagentPage("thr_child_t12", "on")) : jsonResponse({ error: "not served" }, 500)));
  function Host() {
    const shown = useBackgroundTasks("thr_m12")[0]!;
    return <TaskSteps task={shown} />;
  }
  const host = await render(<Host />);
  await settleUntil(() => text(host, "task-brief-text") !== null, "what it was asked");
  expect(host.querySelector('[data-slot="task-reply"]') === null).toBe(true);
  ended = true;
  act(() => useBackgroundTasksStore.getState().apply({ ...running, status: "finished", seq: 9, finishedAt: "2026-10-18T09:01:10.000Z" }));
  await settleUntil(() => host.querySelector('[data-slot="task-reply"]') !== null, "what it answered");
  expect(host.querySelector('[data-slot="task-reply"]')!.lastElementChild?.textContent).toBe("Two call sites, both in the wake path.");
});

test("a task that cannot be read says so with the server's words; Retry reads it again", async () => {
  let refuse = true;
  const calls = mockFetch(({ url }) => (/\/api\/agents\/tasks\/[^/]+$/.test(url)
    ? (refuse ? jsonResponse({ error: "Server restarting." }, 503) : jsonResponse(taskDetail(task("thr_child_t13", { status: "finished" }), { reply: "Done." })))
    : jsonResponse({ error: "not served" }, 500)));
  const host = await render(<TaskSteps task={task("thr_child_t13", { status: "finished", finishedAt: "2026-10-18T09:04:13.000Z" })} />);
  await settleUntil(() => host.querySelector('[data-slot="task-brief"] [data-slot="inline-error"]') !== null, "why it could not be read");
  expect(text(host, "inline-error")).toContain("Couldn't load the task.");
  expect(text(host, "inline-error")).toContain("Server restarting.");
  refuse = false;
  await act(async () => { [...host.querySelectorAll<HTMLElement>('[data-slot="inline-error"] button')].find((b) => b.textContent === "Retry")!.click(); });
  await settleUntil(() => host.querySelector('[data-slot="task-reply"]') !== null, "what it answered");
  expect([host.querySelector('[data-slot="inline-error"]') === null, calls.filter((c) => c.url.includes("/api/agents/tasks/")).length]).toEqual([true, 2]);
});

test("a task that moved on while its detail could not be read again keeps what it was asked, with why and Retry", async () => {
  // Read while it ran; a read again of the conversation's list then found it finished.
  useBackgroundTasksStore.setState({ details: new Map([["task_thr_child_t14", { brief: "Find the call sites.", reply: null, stepCount: 2, status: "running" }]]) });
  mockFetch(() => jsonResponse({ error: "Server restarting." }, 503));
  const host = await render(<TaskSteps task={task("thr_child_t14", { status: "finished", finishedAt: "2026-10-18T09:04:13.000Z" })} />);
  await settleUntil(() => host.querySelector('[data-slot="task-brief"] [data-slot="inline-error"]') !== null, "why it could not be read again");
  expect([text(host, "task-brief-text"), host.querySelector('[data-slot="task-brief"] [data-slot="inline-error"] button') !== null]).toEqual(["Find the call sites.", true]);
});

// A command's detail: what it runs and its output's end, how much there is
// and where it all is; no Task, no Steps, no Result. While it runs and is
// open, its output is read again every 2 s.
test("a command's detail: Command, its output's end, and the note of how much and where; read again while it runs", async () => {
  const cmd = backgroundTask({ id: "task_cmd_e2e", kind: "command", childThreadId: null, title: "Run the e2e suite", command: "make e2e", outputPath: "/out/task_cmd_e2e.log" });
  let reads = 0;
  mockFetch((call) => {
    if (!/\/api\/agents\/tasks\/task_cmd_e2e$/.test(call.url)) return jsonResponse({ error: "not served" }, 500);
    reads++;
    const tail = reads === 1 ? "ok 1\nok 2\nok 3" : "ok 2\nok 3\nok 4";
    return jsonResponse({ task: cmd, brief: "make e2e", reply: tail, stepCount: 0, output: { shownLines: 3, totalLines: 1284 + reads - 1, bytes: 217_088, path: "/out/task_cmd_e2e.log" } });
  });
  fakeClock();
  const host = await render(<TaskSteps task={cmd} />);
  await advanceUntil(() => text(host, "task-output-text") !== null, "its output");
  expect(text(host, "task-steps-title")).toBe("Command · Run the e2e suite");
  expect(text(host, "task-command-text")).toBe("make e2e");
  expect(text(host, "task-output-text")).toBe("ok 1\nok 2\nok 3");
  expect(text(host, "task-output-note")).toBe("Last 3 of 1,284 lines · 212.0 KB · full output: /out/task_cmd_e2e.log");
  expect([host.querySelector('[data-slot="task-steps-toggle"]') === null, host.querySelector('[data-slot="task-brief"]') === null, host.querySelector('[data-slot="task-reply"]') === null]).toEqual([true, true, true]);
  // Read again 2 s later, by the clock: no event says its output grew.
  await advanceUntil(() => text(host, "task-output-text") === "ok 2\nok 3\nok 4", "the read again");
  expect(text(host, "task-output-text")).toBe("ok 2\nok 3\nok 4");
  expect(text(host, "task-output-note")).toBe("Last 3 of 1,285 lines · 212.0 KB · full output: /out/task_cmd_e2e.log");
});

test("a command that printed nothing says so, with no note", async () => {
  const cmd = backgroundTask({ id: "task_cmd_quiet", kind: "command", childThreadId: null, title: "Wait", command: "sleep 30", outputPath: "/out/q.log", status: "finished", exitCode: 0, finishedAt: "2026-10-18T09:01:00.000Z" });
  mockFetch(() => jsonResponse({ task: cmd, brief: "sleep 30", reply: null, stepCount: 0, output: { shownLines: 0, totalLines: 0, bytes: 0, path: "/out/q.log" } }));
  const host = await render(<TaskSteps task={cmd} />);
  await settleUntil(() => text(host, "task-output-empty") !== null, "its empty output");
  expect(text(host, "task-output-empty")).toBe("No output yet.");
  expect(host.querySelector('[data-slot="task-output-note"]') === null).toBe(true);
  expect(text(host, "task-steps-status")).toContain("Exit 0");
});

test("a command's output that can no longer be read says so under what was read, and says nothing once a read works again", async () => {
  const cmd = backgroundTask({ id: "task_cmd_flaky", kind: "command", childThreadId: null, title: "Run the e2e suite", command: "make e2e", outputPath: "/out/f.log" });
  let reads = 0;
  mockFetch(() => {
    reads++;
    if (reads === 2) return jsonResponse({ error: "Service unavailable" }, 503);
    return jsonResponse({ task: cmd, brief: "make e2e", reply: `ok ${reads}`, stepCount: 0, output: { shownLines: 1, totalLines: reads, bytes: 4, path: "/out/f.log" } });
  });
  fakeClock();
  const host = await render(<TaskSteps task={cmd} />);
  await advanceUntil(() => text(host, "task-output-text") === "ok 1", "its output");
  await advanceUntil(() => text(host, "task-output-error") !== null, "the failed read");
  expect(text(host, "task-output-error")).toContain("Couldn't load its output.");
  expect(text(host, "task-output-text")).toBe("ok 1");
  await advanceUntil(() => text(host, "task-output-text") === "ok 3", "the read that works again");
  expect([text(host, "task-output-text"), host.querySelector('[data-slot="task-output-error"]') === null]).toEqual(["ok 3", true]);
});

test("a command that ended while its detail was open, whose last read fails: what was read stays, with the error and Retry", async () => {
  const cmd = backgroundTask({ id: "task_cmd_end", kind: "command", childThreadId: null, title: "Run the e2e suite", command: "make e2e", outputPath: "/out/e.log" });
  act(() => { useBackgroundTasksStore.setState({ byThread: new Map([["thr_m", [cmd]]]) }); });
  let reads = 0;
  mockFetch(() => {
    reads++;
    return reads === 1
      ? jsonResponse({ task: cmd, brief: "make e2e", reply: "running", stepCount: 0, output: { shownLines: 1, totalLines: 1, bytes: 8, path: "/out/e.log" } })
      : jsonResponse({ error: "Service unavailable" }, 503);
  });
  const { host, rerender } = await mountAsync(<TaskSteps task={cmd} />, { path: "/threads/thr_m" });
  await settleUntil(() => text(host, "task-output-text") === "running", "its output");
  // Its end, as the stream tells it.
  const ended = { ...cmd, status: "finished" as const, exitCode: 0, seq: 9, finishedAt: "2026-10-18T09:01:10.000Z" };
  act(() => { useBackgroundTasksStore.getState().apply(ended); });
  rerender(<TaskSteps task={ended} />);
  await settleUntil(() => (host.textContent ?? "").includes("Couldn't load the command."), "the failed last read");
  expect(text(host, "task-output-text")).toBe("running");
  expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Retry")).toBe(true);
});

test("a command killed by a signal shows why, as its task recorded it", async () => {
  const cmd = backgroundTask({ id: "task_cmd_kill", kind: "command", childThreadId: null, title: "Run the e2e suite", command: "make e2e", outputPath: "/out/k.log", status: "failed", exitCode: null, error: "signal SIGKILL", finishedAt: "2026-10-18T09:01:00.000Z" });
  mockFetch(() => jsonResponse({ task: cmd, brief: "make e2e", reply: null, stepCount: 0, output: { shownLines: 0, totalLines: 0, bytes: 0, path: "/out/k.log" } }));
  const host = await render(<TaskSteps task={cmd} />);
  await settleUntil(() => text(host, "task-output-empty") !== null, "its detail");
  expect(text(host, "task-error")).toBe("signal SIGKILL");
  // One that exited says it in its status line alone.
  const exited = { ...cmd, id: "task_cmd_exit", exitCode: 1, error: "exit 1" };
  const again = await render(<TaskSteps task={exited} />);
  await settleUntil(() => text(again, "task-output-empty") !== null, "its detail");
  expect(again.querySelector('[data-slot="task-error"]') === null).toBe(true);
});
