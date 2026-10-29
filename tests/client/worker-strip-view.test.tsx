import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import type { BackgroundTaskDto } from "@shared/api-contracts";
import { WorkerStrip } from "../../src/client/routes/window/chat/WorkerStrip.js";
import type { WorkerStripRow } from "../../src/client/routes/window/chat/worker-strip.js";
import { useAgentChatStore } from "../../src/client/store/agent-chat.js";
import { useBackgroundTasksStore } from "../../src/client/store/background-tasks.js";
import { fakePhoneWidth } from "../fake-phone-width";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle, settleUntil } from "../helpers/mount.js";
import { backgroundTask, resetBackgroundTasksStore, subagentPage } from "../helpers/subagent-client.js";

// The strip above a manager thread's composer, as the reader meets it: one
// worker at work is its own row, what it is on and for how long; two or more
// are one line, the first of them and how many more are at work and waiting,
// which opens in place to a row each. A row opens its worker.

beforeEach(() => { setSystemTime(new Date("2026-10-14T10:12:41.000Z")); });
afterEach(() => {
  runCleanups();
  setSystemTime();
  // A task's steps and the list portal into document.body.
  document.body.innerHTML = "";
  resetBackgroundTasksStore();
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
});

const rows: WorkerStripRow[] = [
  { featureId: "f1", name: "legacy-compat", kind: "running", step: "Run the full validation", since: "2026-10-14T10:00:00.000Z" },
  { featureId: "f2", name: "evict-order", kind: "running", step: null, since: null },
  { featureId: "f3", name: "docs-sweep", kind: "waiting", wait: { kind: "command", lead: "Monitoring", label: "gh run list", mono: true }, since: "2026-10-14T10:04:29.000Z" },
  { featureId: "f4", name: "flaky-ci", kind: "waiting", wait: { kind: "pane", lead: "Watching", label: "codex", mono: false }, since: "2026-10-14T10:05:00.000Z" },
  { featureId: "f5", name: "bench-cache", kind: "waiting", wait: { kind: "pane", lead: "Watching", label: "bench", mono: false }, since: "2026-10-14T10:06:00.000Z" }
];

async function render(shown: WorkerStripRow[], compact = false) {
  const opened: string[] = [];
  const { host } = await mountAsync(
    <WorkerStrip rows={shown} compact={compact} onOpen={(featureId) => opened.push(featureId)} />
  );
  await settle();
  return { host, opened };
}
const lines = (host: ParentNode) => [...host.querySelectorAll<HTMLElement>('[data-slot="worker-strip-row"]')].map((row) => [
  row.getAttribute("data-kind"),
  row.querySelector('[data-slot="worker-strip-text"]')?.textContent,
  row.querySelector('[data-slot="worker-strip-clock"]')?.textContent ?? null
]);
const click = (el: HTMLElement) => act(async () => { el.click(); });

const slotText = (host: ParentNode, name: string) => host.querySelector(`[data-slot="${name}"]`)?.textContent ?? null;

test("one worker at work is its own row: who, what it is on, and for how long", async () => {
  const { host, opened } = await render(rows.slice(2, 3));
  expect(lines(host)).toEqual([["waiting", "docs-sweep · Monitoring gh run list", "8m 12s"]]);
  expect(host.querySelector('[data-slot="worker-strip-more"], [data-slot="worker-strip-fold"]') === null).toBe(true);
  await click(host.querySelector<HTMLElement>('[data-slot="worker-strip-row"]')!);
  expect(opened).toStrictEqual(["f3"]);
});

test("several are one line: the longest running one, and how many more are at work and waiting", async () => {
  const { host, opened } = await render(rows);
  expect(lines(host)).toEqual([["running", "legacy-compat · Run the full validation…", "12m 41s"]]);
  expect(host.querySelector('[data-slot="worker-strip-row"] [data-slot="working-glyph"]')).not.toBe(null);
  const more = host.querySelector<HTMLElement>('[data-slot="worker-strip-more"]')!;
  expect(more.textContent).toBe("· 1 more at work, 3 waiting");
  expect(more.getAttribute("aria-expanded")).toBe("false");
  // The line names its worker and opens it.
  await click(host.querySelector<HTMLElement>('[data-slot="worker-strip-row"]')!);
  expect(opened).toStrictEqual(["f1"]);
  runCleanups();

  // None running: the longest waiting one leads, and the rest are more waiting.
  const waiting = await render(rows.slice(2));
  expect(lines(waiting.host)).toEqual([["waiting", "docs-sweep · Monitoring gh run list", "8m 12s"]]);
  expect(slotText(waiting.host, "worker-strip-more")).toBe("· 2 more waiting");
  runCleanups();

  // All running.
  expect(slotText((await render(rows.slice(0, 2))).host, "worker-strip-more")).toBe("· 1 more at work");
});

test("the line opens in place to a row each, running first, and closes again; focus follows the control", async () => {
  const { host, opened } = await render(rows);
  await click(host.querySelector<HTMLElement>('[data-slot="worker-strip-more"]')!);
  const fold = host.querySelector<HTMLElement>('[data-slot="worker-strip-fold"]')!;
  expect(fold.textContent).toBe("2 at work, 3 waiting");
  expect(fold.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement === fold).toBe(true);
  expect(lines(host)).toEqual([
    ["running", "legacy-compat · Run the full validation…", "12m 41s"],
    // No step in progress, and no start known: no clock to show.
    ["running", "evict-order · Working…", null],
    ["waiting", "docs-sweep · Monitoring gh run list", "8m 12s"],
    ["waiting", "flaky-ci · Watching codex", "7m 41s"],
    ["waiting", "bench-cache · Watching bench", "6m 41s"]
  ]);
  // A running row turns; a waiting one is still, its command set in mono.
  const shown = [...host.querySelectorAll<HTMLElement>('[data-slot="worker-strip-row"]')];
  expect(shown[1]!.querySelector('[data-slot="working-glyph"]')).not.toBe(null);
  expect(shown[2]!.querySelector('[data-slot="working-glyph"], .text-shimmer') === null).toBe(true);
  expect(shown[2]!.querySelector(".font-mono")?.textContent).toBe("gh run list");
  expect(host.querySelector('[data-slot="worker-strip-more"]') === null).toBe(true);
  await click(shown[1]!);
  expect(opened).toStrictEqual(["f2"]);
  await click(fold);
  expect(lines(host).length).toBe(1);
  expect(document.activeElement === host.querySelector('[data-slot="worker-strip-more"]')).toBe(true);
});

test("down to one worker the fold is gone, and two again start folded", async () => {
  const props = { compact: false, onOpen: () => {} };
  const mounted = await mountAsync(<WorkerStrip rows={rows.slice(0, 2)} {...props} />);
  await settle();
  await click(mounted.host.querySelector<HTMLElement>('[data-slot="worker-strip-more"]')!);
  expect(lines(mounted.host).length).toBe(2);
  mounted.rerender(<WorkerStrip rows={rows.slice(0, 1)} {...props} />);
  await settle();
  expect(lines(mounted.host)).toEqual([["running", "legacy-compat · Run the full validation…", "12m 41s"]]);
  expect(mounted.host.querySelector('[data-slot="worker-strip-fold"]') === null).toBe(true);
  mounted.rerender(<WorkerStrip rows={rows.slice(0, 2)} {...props} />);
  await settle();
  expect(lines(mounted.host).length).toBe(1);
  expect(slotText(mounted.host, "worker-strip-more")).toBe("· 1 more at work");
});

test("when the fold goes away with focus in it, focus goes to the row that stays; focus taken elsewhere is left there", async () => {
  const props = { compact: false, onOpen: () => {} };
  const two = rows.slice(0, 2);
  const one = rows.slice(0, 1);
  const lone = (host: ParentNode) => host.querySelector<HTMLElement>('[data-slot="worker-strip-row"]')!;

  // Opened, on the first row; the other worker ends.
  const opened = await mountAsync(<WorkerStrip rows={two} {...props} />);
  await settle();
  await click(opened.host.querySelector<HTMLElement>('[data-slot="worker-strip-more"]')!);
  act(() => { lone(opened.host).focus(); });
  opened.rerender(<WorkerStrip rows={one} {...props} />);
  await settle();
  expect(document.activeElement === lone(opened.host)).toBe(true);
  runCleanups();

  // Folded, on the count.
  const folded = await mountAsync(<WorkerStrip rows={two} {...props} />);
  await settle();
  act(() => { folded.host.querySelector<HTMLElement>('[data-slot="worker-strip-more"]')!.focus(); });
  folded.rerender(<WorkerStrip rows={one} {...props} />);
  await settle();
  expect(document.activeElement === lone(folded.host)).toBe(true);
  runCleanups();

  // Folded, on the row itself: the same row stays, focus on it.
  const kept = await mountAsync(<WorkerStrip rows={two} {...props} />);
  await settle();
  const row = lone(kept.host);
  act(() => { row.focus(); });
  kept.rerender(<WorkerStrip rows={one} {...props} />);
  await settle();
  expect(lone(kept.host) === row).toBe(true);
  expect(document.activeElement === row).toBe(true);
  runCleanups();

  // Focus the reader took elsewhere is not taken back.
  const away = await mountAsync(<WorkerStrip rows={two} {...props} />);
  await settle();
  act(() => { away.host.querySelector<HTMLElement>('[data-slot="worker-strip-more"]')!.focus(); });
  const outside = document.createElement("button");
  document.body.appendChild(outside);
  act(() => { outside.focus(); });
  away.rerender(<WorkerStrip rows={one} {...props} />);
  await settle();
  expect(document.activeElement === outside).toBe(true);
});

test("on a phone the folded line names its first worker and its clock, the count needing the rest; opened, each row says what it is on", async () => {
  const { host } = await render(rows, true);
  expect(lines(host)).toEqual([["running", "legacy-compat", "12m 41s"]]);
  expect(slotText(host, "worker-strip-more")).toBe("· 1 more at work, 3 waiting");
  await click(host.querySelector<HTMLElement>('[data-slot="worker-strip-more"]')!);
  expect(lines(host).slice(0, 3).map(([, text]) => text)).toStrictEqual(["legacy-compat · Run the full validation…", "evict-order · Working…", "docs-sweep · Monitoring gh run list"]);
  runCleanups();
  // One worker alone keeps its whole row.
  expect(lines((await render(rows.slice(0, 1), true)).host)).toEqual([["running", "legacy-compat · Run the full validation…", "12m 41s"]]);
});

// A conversation's background tasks (subagents, today), in any conversation:
// one is its own row with Stop; two or more fold into one row that opens
// the Background tasks list.
const runningTask = backgroundTask({ childThreadId: "thr_child_v1", startedAt: "2026-10-14T10:11:29.000Z" });
function serveChild(threadId: string) {
  return mockFetch(({ url }) => (url.includes(`/api/agents/threads/${threadId}`) ? jsonResponse(subagentPage(threadId, "on")) : jsonResponse({ error: "not served" }, 500)));
}
async function renderTasks(tasks: BackgroundTaskDto[], options: { compact?: boolean; workers?: WorkerStripRow[] } = {}) {
  const peeks: Array<[string, boolean]> = [];
  const { host } = await mountAsync(
    <WorkerStrip
      rows={options.workers ?? []}
      tasks={tasks}
      threadId="thr_m"
      compact={options.compact ?? false}
      onOpen={() => {}}
      onTaskPeek={(id, open) => peeks.push([id, open])}
    />,
    { path: "/threads/thr_m" }
  );
  await settle();
  return { host, peeks };
}
const taskLines = (host: ParentNode, slot: string) => [...host.querySelectorAll(`[data-slot="${slot}"]`)].map((row) => [
  row.querySelector('[data-slot="worker-strip-text"]')?.textContent ?? null,
  row.querySelector('[data-slot="worker-strip-clock"]')?.textContent ?? null
]);

test("one subagent at work is its own row: what it is, its job, the step it is on, how long it has run, and Stop", async () => {
  serveChild("thr_child_v1");
  const { host } = await renderTasks([runningTask]);
  await settleUntil(() => (host.querySelector('[data-slot="task-strip-open"]')?.textContent ?? "").includes("Reading"), "the step it is on");
  expect(taskLines(host, "task-strip-open")).toEqual([["Subagent · 0.72 release notes · Reading release-0.72.md…", "1m 12s"]]);
  expect(host.querySelector('[data-slot="task-strip-row"] [data-slot="task-stop"]')!.getAttribute("aria-label")).toBe("Stop 0.72 release notes");
  expect(host.querySelector('[data-slot="task-strip-group"]') === null).toBe(true);
});

test("a queued one waits its turn: Queued, no clock, and Stop", async () => {
  const { host } = await renderTasks([backgroundTask({ status: "queued", startedAt: null })]);
  expect(taskLines(host, "task-strip-open")).toEqual([["Subagent · 0.72 release notes · Queued", null]]);
  expect(host.querySelector('[data-slot="task-stop"]') !== null).toBe(true);
});

test("two or more fold into one row: how many, their jobs, the longest one's clock; it opens the Background tasks list above it", async () => {
  const tasks = [
    backgroundTask({ id: "t1", title: "Upgrade guide", childThreadId: "thr_child_g1", startedAt: "2026-10-14T10:10:11.000Z" }),
    backgroundTask({ id: "t2", title: "API changes", childThreadId: "thr_child_g2", startedAt: "2026-10-14T10:12:00.000Z" }),
    backgroundTask({ id: "t3", title: "Benchmarks", status: "queued", startedAt: null })
  ];
  act(() => { useBackgroundTasksStore.setState({ byThread: new Map([["thr_m", tasks]]) }); });
  const { host } = await renderTasks(tasks);
  expect(host.querySelectorAll('[data-slot="task-strip-row"]').length).toBe(0);
  expect(taskLines(host, "task-strip-group")).toEqual([["3 subagents · Upgrade guide, API changes, Benchmarks", "2m 30s"]]);
  await act(async () => { host.querySelector<HTMLElement>('[data-slot="task-strip-group"]')!.click(); });
  expect(document.querySelector('[data-slot="background-tasks-popover"]')?.getAttribute("aria-label")).toBe("Background tasks");
});

test("workers keep their rows, and the subagents' row comes after them", async () => {
  const { host } = await renderTasks([backgroundTask({ status: "queued", startedAt: null })], { workers: rows.slice(0, 1) });
  const strip = host.querySelector('[data-slot="worker-strip"]')!;
  // The worker's line (its row in the line it folds into), then the task's.
  expect([...strip.children].map((el) => el.getAttribute("data-slot"))).toEqual(["worker-strip-lead", "task-strip-row"]);
  expect(strip.querySelector('[data-slot="worker-strip-lead"] [data-slot="worker-strip-row"]')).not.toBe(null);
});

test("Stop on the row stops that task", async () => {
  const calls = mockFetch(({ url }) => (url.endsWith("/stop")
    ? jsonResponse({ task: backgroundTask({ status: "stopped", stoppedBy: "user", startedAt: null, finishedAt: "2026-10-14T10:12:41.000Z" }) })
    : jsonResponse({ error: "not served" }, 500)));
  const { host } = await renderTasks([backgroundTask({ status: "queued", startedAt: null })]);
  await act(async () => { host.querySelector<HTMLElement>('[data-slot="task-stop"]')!.click(); });
  await settle();
  expect(calls.map((c) => `${c.method} ${c.url}`)).toStrictEqual(["POST /api/agents/tasks/task_1/stop"]);
});

test("a row's steps opening and closing are told, so the strip can hold that task while they are open", async () => {
  serveChild("thr_child_v1");
  const { host, peeks } = await renderTasks([runningTask]);
  await act(async () => { host.querySelector<HTMLElement>('[data-slot="task-strip-open"]')!.click(); });
  expect(document.querySelector('[data-slot="task-steps-popover"]') !== null).toBe(true);
  act(() => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(peeks).toStrictEqual([["task_1", true], ["task_1", false]]);
});

test("on a phone a running row names its job and its clock, not its step, and reads nothing for a step", async () => {
  onCleanup(fakePhoneWidth(390));
  const calls = mockFetch(() => jsonResponse({ error: "not served" }, 500));
  const { host } = await renderTasks([runningTask], { compact: true });
  expect(taskLines(host, "task-strip-open")).toEqual([["Subagent · 0.72 release notes", "1m 12s"]]);
  expect(calls).toHaveLength(0);
});

test("on a phone the folded row opens the list in the sheet", async () => {
  onCleanup(fakePhoneWidth(390));
  const tasks = [backgroundTask({ id: "t1", title: "Upgrade guide" }), backgroundTask({ id: "t2", title: "API changes" })];
  act(() => { useBackgroundTasksStore.setState({ byThread: new Map([["thr_m", tasks]]) }); });
  const { host } = await renderTasks(tasks, { compact: true });
  await act(async () => { host.querySelector<HTMLElement>('[data-slot="task-strip-group"]')!.click(); });
  expect(document.querySelector('[data-slot="background-tasks-sheet"] [data-slot="bottom-sheet-body"]') !== null).toBe(true);
});

// The strip can go while what is open on it stays: the composer it sits on
// gives way to voice. What was held for it must not outlive it.
test("a strip unmounted while a row's steps or the folded row's list are open tells that they closed", async () => {
  serveChild("thr_child_u1");
  const one = await renderTasks([backgroundTask({ id: "t1", childThreadId: "thr_child_u1" })]);
  await act(async () => { one.host.querySelector<HTMLElement>('[data-slot="task-strip-open"]')!.click(); });
  expect(one.peeks.at(-1)).toEqual(["t1", true]);
  runCleanups();
  expect(one.peeks.at(-1)).toEqual(["t1", false]);

  const lists: Array<[readonly string[], boolean]> = [];
  const tasks = [
    backgroundTask({ id: "t2", title: "Upgrade guide", childThreadId: "thr_child_u2" }),
    backgroundTask({ id: "t3", title: "API changes", childThreadId: "thr_child_u3" })
  ];
  act(() => { useBackgroundTasksStore.setState({ byThread: new Map([["thr_m", tasks]]) }); });
  mockFetch(() => jsonResponse({ thread: { id: "thr_child_u2" }, messages: [], hasMore: false }));
  const { host } = await mountAsync(
    <WorkerStrip rows={[]} tasks={tasks} threadId="thr_m" compact={false} onListOpen={(ids, open) => lists.push([ids, open])} />,
    { path: "/threads/thr_m" }
  );
  await act(async () => { host.querySelector<HTMLElement>('[data-slot="task-strip-group"]')!.click(); });
  expect(lists.at(-1)).toEqual([["t2", "t3"], true]);
  runCleanups();
  expect(lists.at(-1)?.[1]).toBe(false);
});
