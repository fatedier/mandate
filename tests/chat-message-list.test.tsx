import { afterEach, beforeEach, expect, jest, test, setSystemTime } from "bun:test";
import { act } from "react";
import { ChatMessageList } from "../src/client/routes/window/chat/ChatMessageList.js";
import { newThreadState, type ThreadState } from "../src/client/store/agent-chat.js";
import { useWorkItemsStore } from "../src/client/store/work-items.js";
import { useProjectsStore } from "../src/client/store/projects.js";
import { featureMessageReplyMetadata } from "../src/shared/feature-message.js";
import { formatDateTimeTitle } from "../src/client/lib/format.js";
import { useReplyActivityStore } from "../src/client/store/reply-activity.js";
import { useInterruptedWakesStore } from "../src/client/store/interrupted-wakes.js";
import { onCleanup, runCleanups } from "./helpers/cleanup.js";
import { mount, mountAsync, settle } from "./helpers/mount.js";
import { clientFeature, clientProject } from "./helpers/client-builders.js";
import type { ToolCall } from "../src/shared/agent-message-types.js";
import type { AgentWakeReason } from "../src/shared/api/agents.js";
import { renderCommandMonitorMessage } from "../src/server/modules/agent/command-monitor-manager.js";
import { fakeClock } from "./helpers/fake-clock.js";
import { fireAnimation, slotAnimating } from "./helpers/motion.js";

// A divider's date leaves out this year: a test that reads one pins "this
// year" to its fixtures'. Only those: other tests need a clock that moves.
const pinThisYear = () => setSystemTime(new Date("2026-10-08T12:00:00"));

beforeEach(() => {
  useWorkItemsStore.setState({
    ...useWorkItemsStore.getInitialState(),
    items: new Map()
  }, true);
});

afterEach(() => {
  // Unmount before the work items the list reads are reset under it.
  runCleanups();
  setSystemTime();
  useWorkItemsStore.setState({
    ...useWorkItemsStore.getInitialState(),
    items: new Map()
  }, true);
});

test("a restart the agent resumed from is a boundary in what it remembers, not a message", async () => {
  const thread = makeThread({
    id: "recovery-1", threadId: "thr-1", seq: 1, role: "user", source: "restart-recovery",
    sourceThreadId: null, wakeId: "wake-recovered",
    createdAt: "2026-09-15T00:00:00Z",
    content: { type: "text", text: "Inspect saved progress before continuing." }
  });
  const view = await renderList(thread);
  const boundary = view.container.querySelector('[data-slot="context-boundary"]')!;
  expect(boundary.textContent).toBe("Mandate restarted · resumed the interrupted turn");
  expect(boundary.querySelectorAll('[data-slot="context-boundary-wave"]')).toHaveLength(2);
  expect(view.container.textContent).not.toContain("Inspect saved progress before continuing.");
});

test("ChatMessageList renders feature conversation messages separately from user input", async () => {
  const thread = makeThread({
    id: "msg-1",
    threadId: "thr-1",
    seq: 1,
    role: "user",
    source: "feature-message",
    sourceThreadId: "feature-thread",
    wakeId: null,
    content: {
      type: "text",
      text: "The parser stays incremental.",
      metadata: featureMessageReplyMetadata({
        featureId: "feat-1",
        featureName: "Parser"
      })
    },
    createdAt: "2026-07-13T00:00:00Z"
  });

  const { container } = await renderList(thread);
  expect(container.textContent).toContain("Worker replied");
  expect(container.textContent).toContain("The parser stays incremental.");
  // The thread's only worker: naming it on every reply says nothing.
  expect(container.textContent).not.toContain("Parser");
});

// A reply names its worker only when the thread has more than one: its live
// workers, and every worker whose reply is in the transcript.
const workerReply = (seq: number, featureId: string, featureName: string) => row({
  role: "user", source: "feature-message", sourceThreadId: `thr-${featureId}`,
  content: { type: "text", text: `${featureName} says done.`, metadata: featureMessageReplyMetadata({ featureId, featureName }) }
});

test("replies from two workers each name their worker", async () => {
  const { container } = await renderList(makeThread([workerReply(1, "feat-1", "Parser"), workerReply(2, "feat-2", "Lexer")]));
  const heads = [...container.querySelectorAll('[data-slot="worker-reply"]')].map((el) => el.firstElementChild?.textContent);
  expect(heads).toStrictEqual(["Worker repliedParser", "Worker repliedLexer"]);
});

test("a thread with two workers names a reply even when only one of them has replied", async () => {
  const at = "2026-08-02T00:00:00Z";
  const feature = (id: string) => clientFeature(id, { createdAt: at, updatedAt: at, ownerThreadId: "thr-1" });
  const project = clientProject("p1", { createdAt: at, updatedAt: at, features: [feature("feat-1"), feature("feat-2")] });
  act(() => useProjectsStore.getState().setProjectsState([project]));
  try {
    const { container } = await renderList(makeThread([workerReply(1, "feat-1", "Parser")]));
    expect(container.querySelector('[data-slot="worker-reply"]')!.firstElementChild!.textContent).toBe("Worker repliedParser");
  } finally {
    act(() => useProjectsStore.getState().setProjectsState([]));
  }
});

test("ChatMessageList does not repeat watch wake provenance on assistant replies", async () => {
  const thread = makeThread({
    id: "msg-1",
    threadId: "thr-1",
    seq: 1,
    role: "assistant",
    source: "self",
    sourceThreadId: null,
    wakeId: "wake-1",
    wakeReason: "watch",
    content: {
      type: "assistant",
      text: "The watched pane is ready."
    },
    createdAt: "2026-05-28T00:30:00Z"
  });

  const { container } = await renderList(thread);
  // The watch event is the cause line; a reply alone has none of its own.
  expect(labels(container)).toEqual([]);
  expect(container.textContent).toContain("The watched pane is ready.");
});

test("ChatMessageList renders watch system events with pane and note detail", async () => {
  const thread = makeThread({
    id: "msg-1",
    threadId: "thr-1",
    seq: 1,
    role: "user",
    source: "watch",
    sourceThreadId: null,
    wakeId: null,
    wakeReason: null,
    content: {
      type: "text",
      text: [
        "[Mandate monitor event]",
        "windowKey: local:md-test:feature",
        "paneId: %413",
        "unchangedFor: 30s",
        "result: settled",
        "note: Verify the docs build after the search index change"
      ].join("\n")
    },
    createdAt: "2026-05-28T00:30:00Z"
  });

  const { container } = await renderList(thread);
  // No reply loaded: the event is a cause line of its own.
  expect(labels(container)).toEqual(["%413 went quiet for 30s"]);
  expect(container.querySelector('[data-slot="provenance-detail"]')!.textContent)
    .toBe("Verify the docs build after the search index change");
});

test("ChatMessageList shows non-watch wake provenance once per wake id", async () => {
  const thread = makeThread([
    {
      id: "msg-1",
      threadId: "thr-1",
      seq: 1,
      role: "assistant",
      source: "self",
      sourceThreadId: null,
      wakeId: "wake-1",
      wakeReason: "work-item-heartbeat",
      content: {
        type: "assistant",
        text: "First update from the scheduled wake."
      },
      createdAt: "2026-05-28T00:30:00Z"
    },
    {
      id: "msg-2",
      threadId: "thr-1",
      seq: 2,
      role: "assistant",
      source: "self",
      sourceThreadId: null,
      wakeId: "wake-1",
      wakeReason: "work-item-heartbeat",
      content: {
        type: "assistant",
        text: "Second update in the same wake."
      },
      createdAt: "2026-05-28T00:31:00Z"
    }
  ]);

  const { container } = await renderList(thread);
  const text = container.textContent ?? "";
  expect(labels(container)).toEqual(["Worker check"]);
  expect(text).toContain("First update from the scheduled wake.");
  expect(text).toContain("Second update in the same wake.");
});

// Rows for the model only draw nothing: not their text, not a date row, not a
// cause line.
const modelOnlyRows: Array<{
  name: string;
  message: Pick<ThreadState["messages"][number], "source" | "wakeReason" | "content">;
  /** The stored text that must not show. */
  hidden: string;
}> = [
  {
    // A routing digest for the model, not an event: nothing, not even a date row.
    name: "a runtime context snapshot is not shown at all",
    message: {
      source: "runtime-context",
      wakeReason: "work-item-heartbeat",
      content: {
        type: "text",
        text: "[runtime_context]\nRAW WORK ITEM SNAPSHOT",
        metadata: { runtimeContextKind: "update" }
      }
    },
    hidden: "RAW WORK ITEM SNAPSHOT"
  },
  {
    name: "a plan reminder is not shown at all",
    message: {
      source: "plan-reminder",
      wakeReason: "watch",
      content: { type: "text", text: "<plan-reminder>\nRAW PLAN REMINDER\n</plan-reminder>" }
    },
    hidden: "RAW PLAN REMINDER"
  }
];

test.each(modelOnlyRows)("$name", async ({ message, hidden }) => {
  const thread = makeThread({
    id: "msg-1",
    threadId: "thr-1",
    seq: 1,
    role: "user",
    sourceThreadId: null,
    wakeId: "wake-1",
    createdAt: "2026-05-28T00:30:00Z",
    ...message
  });

  const { container } = await renderList(thread);
  expect(container.textContent).not.toContain(hidden);
  expect(container.querySelector('[role="separator"]') === null).toBe(true);
  expect(labels(container)).toEqual([]);
});

test("the transcript establishes the container context its narrow rules resolve against", async () => {
  // Every narrow rule inside the transcript is a `@max-[34rem]:` MAX-width
  // rule, so it is the NARROW layout that is opt-in and the wide layout is the
  // unprefixed classes. Delete this class and there is no query container to
  // resolve against, so no narrow rule ever matches: a 900px dock is unaffected
  // and a 320px dock silently renders the wide layout — i.e. the whole of this
  // work no-ops exactly where it was needed, without a single test failing
  // elsewhere. (Before the inversion the failure went the other way, wide
  // everywhere becoming narrow everywhere; that direction no longer applies.)
  // happy-dom evaluates no container queries, so this pins the class only; the
  // layout itself is verified in a browser.
  const thread = makeThread({
    id: "msg-1",
    threadId: "thr-1",
    seq: 1,
    role: "user",
    source: "user",
    sourceThreadId: null,
    wakeId: null,
    content: { type: "text", text: "hello" },
    createdAt: "2026-05-28T00:00:00Z"
  });
  const { container } = await renderList(thread);
  const scroller = container.querySelector("[class*='overflow-y-auto']")!;
  const wrapper = scroller.parentElement!;
  expect(wrapper.className.split(/\s+/)).toContain("@container");
  // The scroller must NOT be the container: `@container` implies
  // `contain: layout inline-size`, and this element owns scroll position.
  expect(scroller.className.split(/\s+/)).not.toContain("@container");
  // Scroll anchoring off — the browser otherwise fires a phantom scroll
  // during any reflow, which unpins a transcript that was following.
  expect(scroller.className.split(/\s+/)).toContain("[overflow-anchor:none]");
});

test("consecutive tool durations start at the preceding completed event", async () => {
  const thread = makeThread([
    assistantMessage(1, "2026-08-02T10:04:00.000", ["call-1", "call-2"]),
    toolResultMessage(2, "call-1", "2026-08-02T10:04:02.000"),
    toolResultMessage(3, "call-2", "2026-08-02T10:04:03.200")
  ]);

  const { container } = await renderList(thread);
  await openRuns(container);
  const durations = [...container.querySelectorAll('[data-slot="tool-duration"]')].map(
    (element) => element.textContent
  );
  expect(durations).toEqual(["2.0s", "1.2s"]);
  expect(durations).not.toContain("3.2s");
  expect(container.querySelector('[data-slot="tool-time"]') === null).toBe(true);
  // A row carries no clock to the second: its time is the divider's, and its
  // own shows on hover to the minute.
  expect(container.textContent?.match(/\d{2}:\d{2}:\d{2}/g) ?? []).toEqual([]);
});

test("a fast non-first tool stays hidden instead of inheriting prior tool time", async () => {
  const thread = makeThread([
    assistantMessage(1, "2026-08-02T10:04:00.000", ["call-1", "call-2"]),
    toolResultMessage(2, "call-1", "2026-08-02T10:04:07.800"),
    toolResultMessage(3, "call-2", "2026-08-02T10:04:08.250")
  ]);

  const { container } = await renderList(thread);
  await openRuns(container);
  const durations = [...container.querySelectorAll('[data-slot="tool-duration"]')].map(
    (element) => element.textContent
  );
  expect(durations).toEqual(["7.8s"]);
  // The second call is not measured from the message: its row stays silent.
  const rows = [...container.querySelectorAll('[data-slot="tool-call"]')];
  expect(rows[1]!.textContent).not.toContain("8.3s");
  // A finished run's line shows no time: its calls' sum read as the turn's.
  expect(container.querySelector('[data-slot="tool-run-duration"]') === null).toBe(true);
});

test("a missing prior result leaves later tool duration unknown", async () => {
  const thread = makeThread([
    assistantMessage(1, "2026-08-02T10:04:00.000", ["call-1", "call-2"]),
    toolResultMessage(3, "call-2", "2026-08-02T10:04:03.000")
  ]);

  const { container } = await renderList(thread);
  await openRuns(container);
  // Opened, so its rows are on the page: the absence below is the duration's.
  expect(container.querySelectorAll('[data-slot="tool-call"]')).toHaveLength(2);
  expect(container.querySelector('[data-slot="tool-duration"]') === null).toBe(true);
});

test("the render window's first row is not taken for a new day while the rows above it wait to be drawn", async () => {
  pinThisYear();
  const rows = Array.from({ length: 30 }, (_, i) =>
    userMessage(i + 1, `2026-08-02T10:${String(i).padStart(2, "0")}:00.000`, `M${String(i + 1).padStart(2, "0")}`));
  const { container } = await renderList(makeThread(rows));
  const seen = () => [...container.querySelectorAll('[role="separator"]')].map((el) => el.getAttribute("aria-label"));
  // Still windowed: the first rows are not drawn yet, and no divider stands in for them.
  expect(container.textContent).not.toContain("M01");
  expect(seen()).toEqual([]);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
  expect(container.textContent).toContain("M01");
  expect(seen()).toEqual(["Aug 2 · 10:00"]);
});

test("the later steps of one wake get no pause divider, however long the work between them", async () => {
  pinThisYear();
  const thread = makeThread([
    userMessage(1, "2026-08-02T10:00:00.000", "Build it"),
    assistantMessage(2, "2026-08-02T10:00:10.000", ["call-1"], "Starting the build", "wake-1"),
    toolResultMessage(3, "call-1", "2026-08-02T10:08:00.000"),
    assistantMessage(4, "2026-08-02T10:08:20.000", [], "The build passed", "wake-1")
  ]);
  const { container } = await renderList(thread);
  expect([...container.querySelectorAll('[role="separator"]')].map((el) => el.getAttribute("aria-label"))).toEqual(["Aug 2 · 10:00"]);
});

test("each day opens with a divider carrying its date and time, and the rows carry no clock", async () => {
  pinThisYear();
  const firstAt = "2026-08-02T23:59:58.000";
  const secondAt = "2026-08-03T00:00:02.000";
  const thread = makeThread([
    userMessage(1, firstAt, "Before midnight"),
    assistantMessage(2, secondAt, [], "After midnight")
  ]);

  const { container } = await renderList(thread);
  const separators = [...container.querySelectorAll('[role="separator"] time')];
  expect(separators.map((element) => [element.textContent, element.getAttribute("datetime")])).toEqual([
    ["Aug 2 · 23:59", firstAt],
    ["Aug 3 · 00:00", secondAt]
  ]);
  // Beside the dividers', a row's own time is on the line under it, and that
  // alone names the full date (it was a hover time in the gap).
  expect(container.querySelectorAll('time:not([data-slot="row-stamp"])')).toHaveLength(2);
  const own = [...container.querySelectorAll('[data-slot="row-stamp"]')].map((time) => [time.getAttribute("title"), time.closest('[data-slot="transcript-row"]')!.textContent]);
  expect(own).toEqual([
    [formatDateTimeTitle(firstAt), expect.stringContaining("Before midnight")],
    [formatDateTimeTitle(secondAt), expect.stringContaining("After midnight")]
  ]);
});

test("a pause of five minutes since the previous row gets a divider with its time; a steady exchange gets none", async () => {
  pinThisYear();
  const thread = makeThread([
    userMessage(1, "2026-08-02T10:00:00.000", "Start"),
    assistantMessage(2, "2026-08-02T10:00:05.000", [], "On it"),
    userMessage(3, "2026-08-02T10:03:00.000", "And this"),
    assistantMessage(4, "2026-08-02T10:06:00.000", [], "Done"),
    userMessage(5, "2026-08-02T10:09:00.000", "Thanks"),
    // Five minutes after "Thanks": a pause, though the exchange began long before.
    userMessage(6, "2026-08-02T10:14:00.000", "Back again"),
    assistantMessage(7, "2026-08-02T10:14:04.000", [], "Hello again")
  ]);

  const { container } = await renderList(thread);
  const separators = [...container.querySelectorAll('[role="separator"]')].map((el) => el.getAttribute("aria-label"));
  expect(separators).toEqual(["Aug 2 · 10:00", "10:14"]);
  const divider = [...container.querySelectorAll('[role="separator"]')][1]!;
  expect(divider.nextElementSibling?.textContent).toContain("Back again");
  expect(container.textContent?.match(/\d{2}:\d{2}:\d{2}/g) ?? []).toEqual([]);
});
test("an assistant step with tools carries no clock in its text; its time is the divider's and its line's", async () => {
  pinThisYear();
  const thread = makeThread([
    assistantMessage(1, "2026-08-02T10:04:00.000", ["call-1", "call-2"]),
    toolResultMessage(2, "call-1", "2026-08-02T10:04:02.000"),
    toolResultMessage(3, "call-2", "2026-08-02T10:04:05.000")
  ]);

  const { container } = await renderList(thread);
  await openRuns(container);
  // Both tools are slow enough to be labelled: the durations are not clocks.
  expect(container.textContent?.match(/\d{2}:\d{2}:\d{2}/g) ?? []).toEqual([]);
  expect([...container.querySelectorAll('[role="separator"]')].map((el) => el.getAttribute("aria-label"))).toEqual(["Aug 2 · 10:04"]);
  expect(container.querySelector('[data-slot="row-stamp"]')!.getAttribute("title")).toBe(formatDateTimeTitle("2026-08-02T10:04:00.000"));
  expect(
    [...container.querySelectorAll('[data-slot="tool-duration"]')].map((el) => el.textContent)
  ).toEqual(["2.0s", "3.0s"]);
});
test("the tool-only steps of one wake read as a single run line", async () => {
  const thread = makeThread([
    assistantMessage(1, "2026-08-02T10:04:00.000", ["call-1"], "Looking around", "wake-1"),
    toolResultMessage(2, "call-1", "2026-08-02T10:04:01.000"),
    assistantMessage(3, "2026-08-02T10:04:02.000", ["call-2", "call-3"], "", "wake-1"),
    toolResultMessage(4, "call-2", "2026-08-02T10:04:03.000"),
    toolResultMessage(5, "call-3", "2026-08-02T10:04:04.000"),
    assistantMessage(6, "2026-08-02T10:04:05.000", ["call-4"], "", "wake-1"),
    toolResultMessage(7, "call-4", "2026-08-02T10:04:06.000")
  ]);
  const { container } = await renderList(thread);
  const lines = [...container.querySelectorAll('[data-slot="tool-run-line"]')];
  expect(lines).toHaveLength(1);
  expect(lines[0]!.textContent).toContain("Used 4 tools");
  // No step prints a clock (the day's divider carries the time).
  expect(container.textContent?.match(/\d{2}:\d{2}:\d{2}/g) ?? []).toEqual([]);
  await openRuns(container);
  expect(container.querySelectorAll('[data-slot="tool-call"]')).toHaveLength(4);
});

test("a pane opened with a name is called by it in every later call's details", async () => {
  const step = (seq: number, toolCallId: string, toolName: string, args: unknown, text = ""): ChatMessage => ({
    id: `assistant-${seq}`, threadId: "thr-1", seq, role: "assistant", source: "self", sourceThreadId: null, wakeId: "wake-1",
    content: { type: "assistant", text, toolCalls: [{ toolCallId, toolName, args }] },
    createdAt: `2026-08-02T10:04:0${seq}.000Z`
  });
  const result = (seq: number, toolCallId: string, toolName: string, value: unknown): ChatMessage => ({
    id: `tool-${seq}`, threadId: "thr-1", seq, role: "tool", source: "self", sourceThreadId: null, wakeId: null,
    content: { type: "tool_result", toolCallId, toolName, result: value },
    createdAt: `2026-08-02T10:04:0${seq}.500Z`
  });
  const thread = makeThread([
    step(1, "c-spawn", "spawn_pane", { name: "dev server", direction: "right" }, "Starting the server"),
    result(2, "c-spawn", "spawn_pane", { paneId: "%12" }),
    step(3, "c-keys", "send_keys", { paneId: "%12", args: ["bun run dev", "Enter"] }, "Sending the command"),
    result(4, "c-keys", "send_keys", { ok: true }),
    step(5, "c-read", "read_pane", { paneId: "%12" }, "Checking it"),
    result(6, "c-read", "read_pane", "ready in 612 ms")
  ]);
  const { container } = await renderList(thread);
  // The run line says it in words too: "Read dev server", not "Read %12".
  const lines = [...container.querySelectorAll('[data-slot="tool-run-line"]')].map((l) => l.textContent);
  expect(lines[2]).toContain("Readdev server");
  await openRuns(container);
  const names = [...container.querySelectorAll('[data-slot="tool-details"] [data-slot="tool-target-name"]')].map((el) => el.textContent);
  // send_keys and read_pane to %12 say which pane: the one spawn_pane named before them.
  expect(names).toEqual(["dev server", "dev server"]);
});

test("a read of a saved output says whose output it is, not the file's random id", async () => {
  const step = (seq: number, toolCallId: string, toolName: string, args: unknown, text = ""): ChatMessage => ({
    id: `assistant-${seq}`, threadId: "thr-1", seq, role: "assistant", source: "self", sourceThreadId: null, wakeId: "wake-1",
    content: { type: "assistant", text, toolCalls: [{ toolCallId, toolName, args }] },
    createdAt: `2026-08-02T10:04:0${seq}.000Z`
  });
  const result = (seq: number, toolCallId: string, toolName: string, value: unknown): ChatMessage => ({
    id: `tool-${seq}`, threadId: "thr-1", seq, role: "tool", source: "self", sourceThreadId: null, wakeId: null,
    content: { type: "tool_result", toolCallId, toolName, result: value },
    createdAt: `2026-08-02T10:04:0${seq}.500Z`
  });
  const path = "/Users/u/.mandate/resources/projects/p1/tool-output/thr_1/4d5e6f7a-8b9c-4d0e-9f1a-3b4c5d6e7f8a.txt";
  const saved = [
    "<persisted-output>",
    "Output too large (80.0KB, 2400 lines). Full output saved to:",
    path,
    "",
    "Use read with this path plus offset/limit to inspect more.",
    "",
    "Preview (first 4.0KB):",
    "package session",
    "</persisted-output>"
  ].join("\n");
  const thread = makeThread([
    step(1, "c-spawn", "spawn_pane", { name: "Sample source" }, "Opening a pane"),
    result(2, "c-spawn", "spawn_pane", { paneId: "%12" }),
    step(3, "c-pane", "read_pane", { paneId: "%12" }, "Reading the source"),
    result(4, "c-pane", "read_pane", saved),
    step(5, "c-file", "read", { path, offset: 401, limit: 400 }, "Reading the next part"),
    result(6, "c-file", "read", "   401\tfunc (c *Cache) Store() {}")
  ]);
  const { container } = await renderList(thread);
  const lines = [...container.querySelectorAll('[data-slot="tool-run-line"]')].map((l) => l.textContent);
  expect(lines[2]).toContain("Read saved output ofSample source");
  expect(lines[2]).not.toContain("4d5e6f7a");
});

test("a joined step's first call is timed from that step, not from the call before it", async () => {
  // Between the first result (10:04:01) and the second step (10:04:05) the
  // model was thinking; timing from the result would bill that to the tool.
  const thread = makeThread([
    assistantMessage(1, "2026-08-02T10:04:00.000", ["call-1"], "Checking", "wake-1"),
    toolResultMessage(2, "call-1", "2026-08-02T10:04:01.500"),
    assistantMessage(3, "2026-08-02T10:04:05.000", ["call-2"], "", "wake-1"),
    toolResultMessage(4, "call-2", "2026-08-02T10:04:06.000")
  ]);
  const { container } = await renderList(thread);
  await openRuns(container);
  const durations = [...container.querySelectorAll('[data-slot="tool-duration"]')].map((el) => el.textContent);
  expect(durations).toEqual(["1.5s", "1.0s"]);
});

test("tool steps of one wake across midnight keep the next day's date row", async () => {
  pinThisYear();
  const thread = makeThread([
    assistantMessage(1, "2026-08-02T23:59:50.000", ["call-1"], "", "wake-1"),
    assistantMessage(2, "2026-08-03T00:00:10.000", ["call-2"], "", "wake-1")
  ]);
  const { container } = await renderList(thread);
  const separators = [...container.querySelectorAll('[role="separator"]')];
  expect(separators.map((el) => el.getAttribute("aria-label"))).toEqual(["Aug 2 · 23:59", "Aug 3 · 00:00"]);
  expect(container.querySelectorAll('[data-slot="tool-run-line"]')).toHaveLength(2);
});

test("a plan reminder in the middle of a wake does not split its tool run", async () => {
  const thread = makeThread([
    assistantMessage(1, "2026-08-02T10:04:00.000", ["call-1"], "", "wake-1"),
    {
      id: "reminder-2", threadId: "thr-1", seq: 2, role: "user", source: "plan-reminder", sourceThreadId: null,
      wakeId: "wake-1", content: { type: "text", text: "<plan-reminder>\nNo plan yet.\n</plan-reminder>" },
      createdAt: "2026-08-02T10:04:01.000Z"
    } as ChatMessage,
    assistantMessage(3, "2026-08-02T10:04:02.000", ["call-3"], "", "wake-1")
  ]);
  const { container } = await renderList(thread);
  expect(container.querySelectorAll('[data-slot="tool-run"]')).toHaveLength(1);
  expect(container.textContent).not.toContain("plan-reminder");
});

test("a run left open on a desktop stops pausing the transcript once the pane is phone-sized", async () => {
  // Open anything and the transcript stops following new messages, so what is
  // open is not scrolled away. On a phone nothing opens in place, so a run left
  // open from a wider window must not keep that pause with nothing on screen.
  // The pause is observable as the "Scroll to latest" button a message
  // arriving during it brings up. happy-dom lays nothing out, so the scroller
  // is given heights by hand: it starts scrolled to the end, and the new
  // message adds 400px. Followed, the scroller moves to the new end; paused, it
  // is left 400px short and says so.
  type HappyWindow = { happyDOM: { setViewport: (size: { width: number }) => void } };
  const wide = window.innerWidth;
  const first = assistantMessage(1, "2026-08-02T10:04:00.000", ["call-1", "call-2"], "Checking", "wake-1");
  const later = userMessage(2, "2026-08-02T10:05:00.000", "And now?");
  const run = async (narrowAfterOpening: boolean) => {
    const list = (messages: ChatMessage[]) =>
      <ChatMessageList thread={makeThread(messages)} onLoadOlder={async () => {}} onRetryFailed={() => {}} />;
    const view = await mountAsync(list([first]));
    await settle();
    const container = view.host;
    const draw = async (messages: ChatMessage[]) => { view.rerender(list(messages)); await settle(); };
    try {
      const scroller = container.querySelector<HTMLElement>("[class*='overflow-y-auto']")!;
      let contentHeight = 5000;
      Object.defineProperty(scroller, "scrollHeight", { get: () => contentHeight, configurable: true });
      Object.defineProperty(scroller, "clientHeight", { get: () => 500, configurable: true });
      await act(async () => {
        scroller.scrollTop = 4500;
        scroller.dispatchEvent(new window.Event("scroll"));
      });
      await openRuns(container);
      if (narrowAfterOpening) {
        await act(async () => { (window as unknown as HappyWindow).happyDOM.setViewport({ width: 390 }); });
      }
      contentHeight = 5400;
      await draw([first, later]);
      return container.querySelector('[aria-label="Scroll to latest message"]') !== null;
    } finally {
      view.unmount();
      (window as unknown as HappyWindow).happyDOM.setViewport({ width: wide });
    }
  };
  // The control: on a desktop, an open run does hold the pause.
  expect(await run(false)).toBe(true);
  expect(await run(true)).toBe(false);
});

test("a mark whose run has left the transcript does not pause following", async () => {
  // Marks are cleared on a thread switch, not when messages go (retention,
  // compression): the pause is read from runs on screen, so an orphaned mark
  // cannot hold it.
  const opened = assistantMessage(1, "2026-08-02T10:04:00.000", ["call-1"], "Checking", "wake-1");
  const replacement = userMessage(2, "2026-08-02T10:05:00.000", "Fresh start");
  const next = userMessage(3, "2026-08-02T10:06:00.000", "And now?");
  const list = (messages: ChatMessage[]) =>
    <ChatMessageList thread={makeThread(messages)} onLoadOlder={async () => {}} onRetryFailed={() => {}} />;
  const view = await mountAsync(list([opened]));
  await settle();
  const container = view.host;
  const draw = async (messages: ChatMessage[]) => { view.rerender(list(messages)); await settle(); };
  const scroller = container.querySelector<HTMLElement>("[class*='overflow-y-auto']")!;
  let contentHeight = 5000;
  Object.defineProperty(scroller, "scrollHeight", { get: () => contentHeight, configurable: true });
  Object.defineProperty(scroller, "clientHeight", { get: () => 500, configurable: true });
  await act(async () => {
    scroller.scrollTop = 4500;
    scroller.dispatchEvent(new window.Event("scroll"));
  });
  await openRuns(container);
  await draw([replacement]);
  contentHeight = 5400;
  await draw([replacement, next]);
  expect(container.querySelector('[aria-label="Scroll to latest message"]') === null).toBe(true);
});

type ChatMessage = ThreadState["messages"][number];

function assistantMessage(
  seq: number,
  createdAt: string,
  toolCallIds: string[],
  text = "Using tools",
  wakeId: string | null = null
): ChatMessage {
  return {
    id: `assistant-${seq}`,
    threadId: "thr-1",
    seq,
    role: "assistant",
    source: "self",
    sourceThreadId: null,
    wakeId,
    content: {
      type: "assistant",
      text,
      toolCalls: toolCallIds.map((toolCallId, index) => ({
        toolCallId,
        toolName: `tool_${index + 1}`,
        args: { value: index + 1 }
      }))
    },
    createdAt
  };
}

function toolResultMessage(seq: number, toolCallId: string, createdAt: string): ChatMessage {
  return {
    id: `tool-${seq}`,
    threadId: "thr-1",
    seq,
    role: "tool",
    source: "self",
    sourceThreadId: null,
    wakeId: null,
    content: {
      type: "tool_result",
      toolCallId,
      toolName: toolCallId,
      result: "ok"
    },
    createdAt
  };
}

function userMessage(seq: number, createdAt: string, text: string): ChatMessage {
  return {
    id: `user-${seq}`,
    threadId: "thr-1",
    seq,
    role: "user",
    source: "user",
    sourceThreadId: null,
    wakeId: null,
    content: { type: "text", text },
    createdAt
  };
}

/** The cause lines on the page, by their label. */
function labels(container: ParentNode): Array<string | null> {
  return [...container.querySelectorAll('[data-slot="provenance-label"]')].map((el) => el.textContent);
}

function makeThread(
  message: ThreadState["messages"][number] | ThreadState["messages"][number][]
): ThreadState {
  const messages = Array.isArray(message) ? message : [message];
  return {
    ...newThreadState(),
    threadId: "thr-1",
    messages,
    oldestSeqLoaded: messages[0]?.seq ?? 1
  };
}

/** Tool runs render collapsed; open every one so its calls are on the page. */
async function openRuns(container: HTMLElement) {
  await act(async () => {
    for (const line of container.querySelectorAll<HTMLButtonElement>('[data-slot="tool-run-line"]')) line.click();
  });
}

/** renderList on a fake clock, for the working line's own timers: mounted at
 *  once (settle waits on a real timer), and the clock is the test's to move. */
function renderListOnFakeClock(thread: ThreadState) {
  fakeClock();
  const { host, unmount } = mount(
    <ChatMessageList
      thread={thread}
      onLoadOlder={async () => {}}
      onRetryFailed={() => {}}
      onOpenWorker={() => {}}
    />
  );
  return { container: host, unmount };
}

async function renderList(thread: ThreadState) {
  const { host, unmount } = await mountAsync(
    <ChatMessageList
      thread={thread}
      onLoadOlder={async () => {}}
      onRetryFailed={() => {}}
      onOpenWorker={() => {}}
    />
  );
  await settle();
  return { container: host, unmount };
}

// ── why the agent spoke ─────────────────────────────────────────────────

type Row = ThreadState["messages"][number];
let rowSeq = 0;
function row(fields: Partial<Row> & Pick<Row, "role" | "source" | "content">): Row {
  rowSeq += 1;
  return {
    id: `row-${rowSeq}`, threadId: "thr-1", seq: rowSeq, sourceThreadId: null, wakeId: null,
    createdAt: `2026-08-02T10:${String(rowSeq).padStart(2, "0")}:00.000Z`,
    ...fields
  } as Row;
}
const watchEvent = (extra: string[] = []) => row({
  role: "user", source: "watch",
  content: { type: "text", text: ["[Mandate monitor event]", "monitorId: ww_1", "paneId: %12", "unchangedFor: 30s", "result: settled", "note: Wait for the server to settle", ...extra].join("\n") }
});
const reply = (text: string, wakeId: string, wakeReason: AgentWakeReason, toolCalls: ToolCall[] = []) => row({
  role: "assistant", source: "self", wakeId, wakeReason,
  content: { type: "assistant", text, toolCalls }
});

test("a watch that fired and the reply it caused are one cause line over the reply", async () => {
  const trigger = watchEvent();
  const thread = makeThread([
    trigger,
    // The wake's runtime snapshot lands between them, carrying the wake's id as
    // the server writes it; it is not drawn, and does not part them.
    row({ role: "user", source: "runtime-context", wakeId: "wake-9", wakeReason: "watch", content: { type: "text", text: "[runtime_context]\ndigest", metadata: { runtimeContextKind: "update" } } }),
    reply("The server is up.", "wake-9", "watch")
  ]);
  const { container } = await renderList(thread);
  expect(labels(container)).toEqual(["%12 went quiet for 30s"]);
  // Its hover time is the event's: the row opens with the event.
  expect(container.querySelector('[data-slot="row-time"]')!.getAttribute("title")).toBe(formatDateTimeTitle(trigger.createdAt));
  expect(container.textContent).toContain("The server is up.");
});

test("an alarm and its reply are one cause line, not an alarm row and a second line on the reply", async () => {
  const thread = makeThread([
    row({ role: "user", source: "alarm", content: { type: "text", text: "[Mandate alarm fired]\nalarmId: alm-1\nnote: Recheck CI" } }),
    reply("CI is green now.", "wake-a", "alarm")
  ]);
  const { container } = await renderList(thread);
  expect(labels(container)).toEqual(["Alarm"]);
  expect(container.textContent).toContain("CI is green now.");
});

test("a trigger is only joined to a reply of its own kind of wake", async () => {
  // The user's reply is not the watch's: both stay, each as itself.
  const thread = makeThread([watchEvent(), reply("Answering you instead.", "wake-u", "user")]);
  const { container } = await renderList(thread);
  expect(labels(container)).toEqual(["%12 went quiet for 30s"]);
  expect(container.textContent).toContain("Answering you instead.");
});

test("a watch names its pane as the thread named it", async () => {
  const thread = makeThread([
    row({ role: "assistant", source: "self", wakeId: "w0", wakeReason: "user", content: { type: "assistant", text: "Opening a pane.", toolCalls: [{ toolCallId: "c-spawn", toolName: "spawn_pane", args: { name: "dev server" } }] } }),
    row({ role: "tool", source: "self", content: { type: "tool_result", toolCallId: "c-spawn", toolName: "spawn_pane", result: { paneId: "%12" } } }),
    row({ role: "assistant", source: "self", wakeId: "w0", wakeReason: "user", content: { type: "assistant", text: "Watching it.", toolCalls: [{ toolCallId: "c-watch", toolName: "monitor", args: { pane: { paneId: "%12" }, note: "x" } }] } }),
    row({ role: "tool", source: "self", content: { type: "tool_result", toolCallId: "c-watch", toolName: "monitor", result: { status: "registered", monitorId: "ww_1", kind: "pane" } } }),
    row({ role: "user", source: "watch", content: { type: "text", text: ["[Mandate monitor event]", "monitorId: ww_1", "kind: pane", "paneId: %12", "unchangedFor: 30s", "result: settled"].join("\n") } }),
    reply("Ready.", "wake-9", "watch")
  ]);
  const { container } = await renderList(thread);
  expect(labels(container)).toEqual(["dev server went quiet for 30s"]);
});

// The event carries the pane's name from when the monitor was registered, so
// a page that has not loaded the call that named the pane still reads it
// ("%112 went quiet" until the user scrolled up far enough).
test("a monitor event names its pane by the name it carries, with no naming call loaded", async () => {
  const thread = makeThread({
    id: "msg-m", threadId: "thr-1", seq: 1, role: "user", source: "watch", sourceThreadId: null, wakeId: null, wakeReason: null,
    content: {
      type: "text",
      text: ["[Mandate monitor event]", "monitorId: ww_9", "kind: pane", "windowKey: md-project-1:pr_56", "paneId: %112", "paneName: Codex PR56", "unchangedFor: 30s", "result: settled"].join("\n")
    },
    createdAt: "2026-10-09T05:24:00Z"
  });
  const { container } = await renderList(thread);
  expect(labels(container)).toEqual(["Codex PR56 went quiet for 30s"]);
});

// The event names how long the screen stayed unchanged (unchangedFor, a duration).
test("a monitor event says how long its pane went quiet", async () => {
  const event = (field: string) => makeThread({
    id: "msg-u", threadId: "thr-1", seq: 1, role: "user", source: "watch", sourceThreadId: null, wakeId: null, wakeReason: null,
    content: { type: "text", text: ["[Mandate monitor event]", "monitorId: ww_9", "kind: pane", "paneId: %112", "paneName: Codex PR56", field, "result: settled"].join("\n") },
    createdAt: "2026-10-09T05:24:00Z"
  });
  const now = await renderList(event("unchangedFor: 4m"));
  expect(labels(now.container)).toEqual(["Codex PR56 went quiet for 4m"]);
});

test("a watch that timed out, or whose pane is gone, says so", async () => {
  const cases: Array<[string, string]> = [["result: timeout", "Monitor on %12 timed out"], ["result: target_missing", "%12 is gone"]];
  for (const [result, expected] of cases) {
    const trigger = watchEvent();
    (trigger.content as { text: string }).text = (trigger.content as { text: string }).text.replace("result: settled", result);
    const { container, unmount } = await renderList(makeThread([trigger]));
    expect(labels(container)).toEqual([expected]);
    unmount();
  }
});

const monitorEvent = (lines: string[]) => row({
  role: "user", source: "monitor",
  content: { type: "text", text: ["[Mandate monitor event]", "monitorId: mon_1", "kind: command", ...lines].join("\n") }
});

test("a command monitor's wake is a cause line: what it watched and what happened, then the note", async () => {
  const cases: Array<[string[], string]> = [
    [["command: gh pr checks 123", "description: CI checks on PR 123", "result: succeeded"], "CI checks on PR 123 · succeeded"],
    [["command: gh api repos/o/r/issues/1/comments --jq '.[].id'", "description: New review comments", "result: changed"], "New review comments · changed"],
    [["command: gh pr checks 123", "description: CI checks on PR 123", "result: timeout"], "CI checks on PR 123 · timed out"],
    [["command: gh pr checks 123", "description: CI checks on PR 123", "result: failing"], "CI checks on PR 123 · failed 5 runs in a row"],
    // Without a description, the command, in code type.
    [["command: gh pr checks 123", "result: succeeded"], "gh pr checks 123 · succeeded"]
  ];
  for (const [lines, expected] of cases) {
    const { container, unmount } = await renderList(makeThread([monitorEvent([...lines, "note: Merge when green"]), reply("On it.", "wake-m", "monitor")]));
    expect(labels(container)).toEqual([expected]);
    expect(container.querySelector('[data-slot="provenance-detail"]')!.textContent).toBe("Merge when green");
    const code = container.querySelector('[data-slot="provenance-label"] code');
    expect([expected, code?.textContent ?? null]).toEqual([expected, lines.some((l) => l.startsWith("description:")) ? null : "gh pr checks 123"]);
    unmount();
  }
});

test("a pane monitor's wake reads as a watch's did, and its timeout names the monitor", async () => {
  const paneMonitor = (result: string) => row({
    role: "user", source: "watch",
    content: { type: "text", text: ["[Mandate monitor event]", "monitorId: ww_1", "kind: pane", "paneId: %12", "unchangedFor: 30s", result, "note: Wait for the server to settle"].join("\n") }
  });
  const cases: Array<[string, string]> = [["result: settled", "%12 went quiet for 30s"], ["result: timeout", "Monitor on %12 timed out"], ["result: target_missing", "%12 is gone"]];
  for (const [result, expected] of cases) {
    const { container, unmount } = await renderList(makeThread([paneMonitor(result)]));
    expect(labels(container)).toEqual([expected]);
    unmount();
  }
});

test("a pane monitor names its pane as the thread named it", async () => {
  const thread = makeThread([
    row({ role: "assistant", source: "self", wakeId: "w0", wakeReason: "user", content: { type: "assistant", text: "Opening a pane.", toolCalls: [{ toolCallId: "c-spawn", toolName: "spawn_pane", args: { name: "dev server" } }] } }),
    row({ role: "tool", source: "self", content: { type: "tool_result", toolCallId: "c-spawn", toolName: "spawn_pane", result: { paneId: "%12" } } }),
    row({ role: "assistant", source: "self", wakeId: "w0", wakeReason: "user", content: { type: "assistant", text: "Watching it.", toolCalls: [{ toolCallId: "c-mon", toolName: "monitor", args: { pane: { paneId: "%12", unchangedFor: "30s" }, note: "x" } }] } }),
    row({ role: "tool", source: "self", content: { type: "tool_result", toolCallId: "c-mon", toolName: "monitor", result: { status: "registered", monitorId: "ww_1", kind: "pane" } } }),
    row({ role: "user", source: "watch", content: { type: "text", text: ["[Mandate monitor event]", "monitorId: ww_1", "kind: pane", "paneId: %12", "unchangedFor: 30s", "result: settled", "note: x"].join("\n") } }),
    reply("Ready.", "wake-9", "watch")
  ]);
  const { container } = await renderList(thread);
  expect(labels(container)).toEqual(["dev server went quiet for 30s"]);
});

test("a pane monitor's event goes by its own monitorId, whatever its note says, and names the pane the monitor of that id did", async () => {
  const thread = makeThread([
    row({ role: "assistant", source: "self", wakeId: "w0", wakeReason: "user", content: { type: "assistant", text: "Opening a pane.", toolCalls: [{ toolCallId: "c-spawn", toolName: "spawn_pane", args: { name: "dev server" } }] } }),
    row({ role: "tool", source: "self", content: { type: "tool_result", toolCallId: "c-spawn", toolName: "spawn_pane", result: { paneId: "%12" } } }),
    row({ role: "assistant", source: "self", wakeId: "w0", wakeReason: "user", content: { type: "assistant", text: "Watching it.", toolCalls: [{ toolCallId: "c-watch", toolName: "monitor", args: { pane: { paneId: "%12" }, note: "x" } }] } }),
    row({ role: "tool", source: "self", content: { type: "tool_result", toolCallId: "c-watch", toolName: "monitor", result: { status: "registered", monitorId: "ww_1", kind: "pane" } } }),
    // A note that spans lines, with a line that looks like a field.
    row({ role: "user", source: "watch", content: { type: "text", text: ["[Mandate monitor event]", "monitorId: ww_1", "kind: pane", "paneId: %12", "unchangedFor: 30s", "result: timeout", "note: Wait for it", "monitorId: ww_9", "result: settled"].join("\n") } }),
    reply("Still going.", "wake-9", "watch")
  ]);
  const { container } = await renderList(thread);
  expect(labels(container)).toEqual(["Monitor on dev server timed out"]);
});

test("a command monitor's event, as the server writes it, reads right whatever its command holds", async () => {
  const text = renderCommandMonitorMessage(
    { id: "mon_1", command: "cat <<'EOF'\nresult: succeeded\nEOF", every_ms: 300_000, wake_when: "succeeds", note: "merge it\nresult: changed", description: null },
    "timeout", { output: "" }
  );
  const { container } = await renderList(makeThread([row({ role: "user", source: "monitor", content: { type: "text", text } }), reply("Giving up on it.", "wake-m", "monitor")]));
  expect(labels(container)).toEqual(["cat <<'EOF'\\nresult: succeeded\\nEOF · timed out"]);
  expect(container.querySelector('[data-slot="provenance-detail"]')!.textContent).toBe("merge it result: changed");
});

test("a wake that said nothing and called nothing is not shown, whatever woke it", async () => {
  const thread = makeThread([
    reply("", "wake-h1", "work-item-heartbeat"),
    reply("", "wake-h2", "work-item-heartbeat"),
    reply("Something to say.", "wake-h3", "work-item-heartbeat")
  ]);
  const { container } = await renderList(thread);
  expect(labels(container)).toEqual(["Worker check"]);
  expect(container.textContent).toContain("Something to say.");
});

test("a trigger whose wake said nothing stays, as a cause line of its own", async () => {
  const thread = makeThread([watchEvent(), reply("", "wake-9", "watch")]);
  const { container } = await renderList(thread);
  expect(labels(container)).toEqual(["%12 went quiet for 30s"]);
});

// The boundary says how large the context was when it was compacted: a
// measured figure, the one the gate compared with the threshold. It used to
// say what the compaction saved instead, which needs the size afterwards,
// could only be estimated and read high. A row with no measured size counts
// its messages alone.
// The count is what this compaction compacted itself (`compactedCount`), not
// the conversation's running total (`replacedCount`, 1,900 here, which takes
// in every earlier summary's).
test("a compaction is a boundary that counts what it compacted itself, says the size it was compacted at, and opens its summary", async () => {
  const summary = (extra: object = {}) => row({
    role: "user", source: "compression",
    content: { type: "summary", summary: "The gist so far.", replacedRange: [1, 1900], replacedCount: 1900, compactedCount: 327, retained: [], ...extra }
  });
  const read = async (extra: object) => {
    const { container, unmount } = await renderList(makeThread([summary(extra)]));
    const boundary = container.querySelector('[data-slot="context-boundary"]')!;
    const said = [boundary.textContent, boundary.querySelector("button")!.textContent];
    unmount();
    return said;
  };
  expect(await read({ tokensBefore: 250_400 })).toEqual(["Compacted 327 earlier messages at 250.4k tokens · View summary", "View summary"]);
  expect(await read({})).toEqual(["Compacted 327 earlier messages · View summary", "View summary"]);
  expect(await read({ compactedCount: 1 })).toEqual(["Compacted 1 earlier message · View summary", "View summary"]);
  // The sizes an unmigrated row still carries are not that figure.
  const leftover: object = { contextEstimate: { before: 350_000, after: 14_400 } };
  expect(await read(leftover)).toEqual(["Compacted 327 earlier messages · View summary", "View summary"]);
  // A row with no count of its own says no number rather than the running total.
  expect(await read({ compactedCount: undefined, tokensBefore: 250_400 })).toEqual(["Compacted at 250.4k tokens · View summary", "View summary"]);
  expect(await read({ compactedCount: undefined })).toEqual(["Compacted earlier messages · View summary", "View summary"]);
});

test("a compaction's summary dialog counts what that compaction compacted", async () => {
  const open = async (extra: object) => {
    const summary = row({
      role: "user", source: "compression",
      content: { type: "summary", summary: "The gist so far.", replacedRange: [1, 1900], replacedCount: 1900, retained: [], ...extra }
    });
    const { container, unmount } = await renderList(makeThread([summary]));
    await act(async () => { (container.querySelector('[data-slot="context-boundary"] button') as HTMLButtonElement).click(); });
    await settle();
    const said = document.body.querySelector('[role="dialog"] p')?.textContent ?? "";
    unmount();
    return said;
  };
  expect(await open({ compactedCount: 327 })).toStartWith("Compacted 327 earlier messages for future replies.");
  expect(await open({})).toStartWith("Compacted earlier messages for future replies.");
});

test("a compaction's summary opens drawn as the model wrote it in Markdown", async () => {
  const summary = row({
    role: "user", source: "compression",
    content: {
      type: "summary",
      summary: "## Where things stand\n\n| Run | Result |\n|---|---|\n| E4 | **resolver passed** |\n\n**注意：**这一步还没做。",
      replacedRange: [1, 40], replacedCount: 40,
      retained: []
    }
  });
  const { container } = await renderList(makeThread([summary]));
  const view = container.querySelector('[data-slot="context-boundary"] button') as HTMLButtonElement;
  await act(async () => { view.click(); });
  await settle();
  const dialog = document.body.querySelector('[role="dialog"]')!;
  // The chat's heading levels: a summary's ## sits under the dialog's own title.
  expect(dialog.querySelector("h4")?.textContent).toBe("Where things stand");
  expect(dialog.querySelector("table td strong")?.textContent).toBe("resolver passed");
  // A full-width colon before Han text still closes the emphasis.
  expect([...dialog.querySelectorAll("strong")].map((s) => s.textContent)).toContain("注意：");
  expect(dialog.textContent).not.toContain("##");
  expect(dialog.textContent).not.toContain("|---|");
});

test("a date row is placed by the cause line, which is drawn first", async () => {
  pinThisYear();
  const trigger = watchEvent();
  trigger.createdAt = "2026-08-02T23:59:50.000Z";
  const late = reply("Past midnight.", "wake-9", "watch");
  late.createdAt = "2026-08-03T00:00:20.000Z";
  const { container } = await renderList(makeThread([trigger, late]));
  const separators = [...container.querySelectorAll('[role="separator"]')].map((el) => el.getAttribute("aria-label"));
  expect(separators).toEqual(["Aug 2 · 23:59"]);
});

test("an alarm that fires while an alarm's wake is already talking stays a line of its own", async () => {
  const alarm = (note: string) => row({ role: "user", source: "alarm", content: { type: "text", text: `[Mandate alarm fired]\nnote: ${note}` } });
  const thread = makeThread([
    alarm("First check"),
    reply("Working on the first.", "wake-a", "alarm"),
    alarm("Second check"),
    // The same wake, still going: not the second alarm's reply.
    reply("Still on the first.", "wake-a", "alarm")
  ]);
  const { container } = await renderList(thread);
  expect(labels(container)).toEqual(["Alarm", "Alarm"]);
  const details = [...container.querySelectorAll('[data-slot="provenance-detail"]')].map((el) => el.textContent);
  expect(details).toEqual(["First check", "Second check"]);
});

function bashCall(id: string, description: string) {
  return { toolCallId: id, toolName: "bash", args: { command: `echo ${id}`, description } };
}

function toolResult(id: string, wakeId: string, seq: number): ThreadState["messages"][number] {
  return {
    id: `res-${id}`, threadId: "thr-1", seq, role: "tool", source: "self", sourceThreadId: null, wakeId,
    createdAt: "2026-09-29T10:00:05Z",
    content: { type: "tool_result", toolCallId: id, toolName: "bash", result: "stdout:\nok\nexitCode: 0" }
  };
}

/** A turn that ran one command and is on its second, and an older turn
 *  whose last call never came back. */
function turnOnSecondCall(): ThreadState {
  const thread = makeThread([
    {
      id: "old", threadId: "thr-1", seq: 1, role: "assistant", source: "self", sourceThreadId: null, wakeId: "w0",
      createdAt: "2026-09-29T09:00:00Z",
      content: { type: "assistant", toolCalls: [bashCall("lost", "An old call that never came back")] }
    },
    {
      id: "a1", threadId: "thr-1", seq: 2, role: "assistant", source: "self", sourceThreadId: null, wakeId: "w1",
      createdAt: "2026-09-29T10:00:00Z",
      content: { type: "assistant", toolCalls: [bashCall("first", "Build the app"), bashCall("second", "Run the unit tests")] }
    },
    toolResult("first", "w1", 3)
  ]);
  return thread;
}

/** The marks of the calls listed in opened runs (a live run's line has a mark of its own). */
const callStates = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-slot="tool-call"] [data-slot="call-status"]')].map((mark) => mark.getAttribute("data-status"));

test("while a turn runs, the first call it has not answered is the one running", async () => {
  const view = await renderList({ ...turnOnSecondCall(), wakePhase: { wakeId: "w1", phase: "thinking" } });
  const lines = [...view.container.querySelectorAll('[data-slot="tool-run-line"]')].map((line) => line.textContent);
  expect(lines[1]).toContain("Running");
  expect(lines[1]).toContain("Run the unit tests");
  // The older turn's lost call is not running: that turn is over.
  expect(lines[0]).not.toContain("Running");
  // The live run's line wears the running call's mark.
  const live = view.container.querySelectorAll('[data-slot="tool-run-line"]')[1]!;
  expect(live.querySelector('[data-slot="call-status"]')?.getAttribute("data-status")).toBe("running");
  // Opened, the older one-call run shows its details, not a list of marks.
  await openRuns(view.container);
  expect(callStates(view.container)).toEqual(["ok", "running"]);
});

test("once the turn is over, an unanswered call no longer reads as running", async () => {
  const view = await renderList({ ...turnOnSecondCall(), wakePhase: { wakeId: "w1", phase: "idle" } });
  expect(view.container.textContent).not.toContain("Running");
  await openRuns(view.container);
  expect(callStates(view.container)).toEqual(["ok", "pending"]);
});

const workingLineOf = (container: HTMLElement) => container.querySelector('[data-slot="working-indicator"]');
const slotText = (container: HTMLElement, slot: string) =>
  container.querySelector(`[data-slot="working-indicator"] [data-slot="${slot}"]`)?.textContent ?? null;

test("a working turn shows one line: a mark, what it is doing, and how long the turn has run", async () => {
  const startedAt = new Date(Date.now() - 65_000).toISOString();
  const view = await renderList({ ...makeThread([]), wakePhase: { wakeId: "w1", phase: "thinking", startedAt } });
  const line = workingLineOf(view.container)!;
  expect(line.getAttribute("role")).toBe("status");
  expect(slotText(view.container, "working-verb")).toBe("Working…");
  expect(slotText(view.container, "working-clock")).toMatch(/^1m 0[56]s$/);
  const glyph = line.querySelector('[data-slot="working-glyph"]')!;
  expect(glyph.getAttribute("aria-hidden")).toBe("true");
  // The clock is read by the eye, not announced every second.
  expect(line.querySelector('[data-slot="working-clock"]')!.getAttribute("aria-hidden")).toBe("true");
});

test("the clock ticks while the turn runs", async () => {
  const view = renderListOnFakeClock({ ...makeThread([]), wakePhase: { wakeId: "w1", phase: "thinking", startedAt: new Date(Date.now() - 3_000).toISOString() } });
  const before = slotText(view.container, "working-clock");
  act(() => { jest.advanceTimersByTime(1_100); });
  const after = slotText(view.container, "working-clock");
  expect([before, after === before]).toEqual([before, false]);
});

test("while the turn's reply moves the working line steps aside, keeping its place; once its text has stopped, the line is back", async () => {
  const thread = { ...makeThread([]), wakePhase: { wakeId: "w1", phase: "thinking" as const }, streamingAssistant: { wakeId: "w1", totalText: "I'll run the tests." } };
  useReplyActivityStore.setState({ byWake: new Map([["w1", Date.now()]]) });
  const moving = await renderList(thread);
  // Out of sight and out of the reader's way, but where it was: the chat does
  // not move by its height each time the reply starts and stops.
  const aside = workingLineOf(moving.container)!;
  expect([aside.getAttribute("data-state"), aside.classList.contains("invisible"), moving.container.textContent?.includes("I'll run the tests.")]).toEqual(["aside", true, true]);
  moving.unmount();
  // A preamble, then a long tool call being written: the text stopped five seconds ago.
  useReplyActivityStore.setState({ byWake: new Map([["w1", Date.now() - 5_000]]) });
  const stopped = await renderList(thread);
  try {
    expect([slotText(stopped.container, "working-verb"), workingLineOf(stopped.container)!.getAttribute("data-state")]).toEqual(["Working…", "shown"]);
  } finally { stopped.unmount(); useReplyActivityStore.setState({ byWake: new Map() }); }
});

test("the working line fades in as a turn starts and out as it ends; opened mid-turn, it is just there", async () => {
  slotAnimating("shown", (el) => (el.className.includes("animate-out") ? "exit" : "none"));
  const list = (thread: ThreadState) => <ChatMessageList thread={thread} onLoadOlder={async () => {}} onRetryFailed={() => {}} onOpenWorker={() => {}} />;
  const idle = makeThread([]);
  const running: ThreadState = { ...idle, wakePhase: { wakeId: "w1", phase: "thinking" } };
  const fading = (host: HTMLElement) => workingLineOf(host)?.closest('[data-slot="shown"]')?.className.split(/\s+/).filter((c) => c === "animate-in" || c === "animate-out") ?? null;
  const midTurn = await mountAsync(list(running));
  expect(fading(midTurn.host)).toEqual([]);
  midTurn.unmount();
  const { host, rerender } = await mountAsync(list(idle));
  expect(workingLineOf(host) === null).toBe(true);
  await act(async () => { rerender(list(running)); });
  expect(fading(host)).toEqual(["animate-in"]);
  // The turn ends: the line fades out as it was, then is gone.
  await act(async () => { rerender(list(idle)); });
  expect([fading(host), slotText(host, "working-verb")]).toEqual([["animate-out"], "Working…"]);
  fireAnimation(host.querySelector('[data-slot="shown"]')!, "animationend", "exit");
  await settle();
  expect(workingLineOf(host) === null).toBe(true);
});

test("a running compaction is the same line, named for what it does", async () => {
  const view = await renderList({
    ...makeThread([]),
    compressionPhase: { compressionId: "c1", startedAt: new Date(Date.now() - 4_000).toISOString() }
  });
  expect(slotText(view.container, "working-verb")).toBe("Compacting context…");
  expect(view.container.querySelectorAll('[data-slot="working-indicator"]')).toHaveLength(1);
});

test("the mark turns through its frames, and holds still when motion is reduced", async () => {
  const frames = async () => {
    const seen = new Set<string>();
    const view = renderListOnFakeClock({ ...makeThread([]), wakePhase: { wakeId: "w1", phase: "thinking" } });
    for (let i = 0; i < 5; i += 1) {
      seen.add(slotText(view.container, "working-glyph") ?? "");
      act(() => { jest.advanceTimersByTime(130); });
    }
    view.unmount();
    return seen;
  };
  expect((await frames()).size).toBeGreaterThan(2);
  const realMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion: reduce"), media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false
  })) as typeof window.matchMedia;
  try {
    expect([...(await frames())]).toEqual(["✻"]);
  } finally { window.matchMedia = realMatchMedia; }
});

function timedReply(id: string, seq: number, wakeId: string, createdAt: string, wakeStartedAt: string, text: string): ThreadState["messages"][number] {
  return {
    id, threadId: "thr-1", seq, role: "assistant", source: "self", sourceThreadId: null, wakeId, wakeStartedAt, createdAt,
    content: { type: "assistant", text }
  };
}

function ask(id: string, seq: number, createdAt: string, text: string): ThreadState["messages"][number] {
  return { id, threadId: "thr-1", seq, role: "user", source: "user", sourceThreadId: null, wakeId: null, createdAt, content: { type: "text", text } };
}

test("the mark stops turning when reduced motion is switched on mid-turn", async () => {
  const REDUCE = "(prefers-reduced-motion: reduce)";
  const listeners = new Set<(event: { matches: boolean }) => void>();
  let reduce = false;
  const realMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    get matches() { return query === REDUCE && reduce; },
    media: query, onchange: null,
    addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => { if (query === REDUCE) listeners.add(listener); },
    removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => { listeners.delete(listener); },
    addListener() {}, removeListener() {}, dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
  const view = renderListOnFakeClock({ ...makeThread([]), wakePhase: { wakeId: "w1", phase: "thinking" } });
  try {
    act(() => {
      reduce = true;
      for (const listener of listeners) listener({ matches: true });
    });
    const seen = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      seen.add(slotText(view.container, "working-glyph") ?? "");
      act(() => { jest.advanceTimersByTime(130); });
    }
    expect([...seen]).toEqual(["✻"]);
  } finally {
    view.unmount();
    window.matchMedia = realMatchMedia;
  }
});

// ── a message's action line ────────────────────────────────
// The user's message and each turn's last reply have a line of their own
// under them, in the row: a Copy and the row's time. A reply's Copy takes
// everything the agent said in its turn; a long turn's time also says how
// long it worked. Only the most recent reply's line always shows. Hover,
// keyboard focus and the touch rule are CSS that happy-dom does not apply, so
// the classes are pinned here and e2e/message-copy.test.ts checks what is drawn.

/** Runs with a clipboard that records what is written to it. */
async function withClipboard(run: (writes: string[]) => Promise<void>) {
  const writes: string[] = [];
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const secure = Object.getOwnPropertyDescriptor(window, "isSecureContext");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { writes.push(text); } } });
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  try {
    await run(writes);
  } finally {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    if (secure) Object.defineProperty(window, "isSecureContext", secure);
  }
}

const classesOf = (el: Element) => el.className.split(/\s+/).filter(Boolean);
const actionLines = (container: ParentNode) => [...container.querySelectorAll<HTMLElement>('[data-slot="row-actions"]')];
/** An action line as the reader meets it: its side, whether it shows at rest, what it says, whether it can copy. */
const lineOf = (line: HTMLElement) => ({
  side: line.dataset.side,
  shown: !classesOf(line).includes("opacity-0"),
  says: line.textContent,
  copies: line.querySelector('button[aria-label="Copy message"]') !== null
});
// One rule for the line and for a long turn's duration on it: the row is
// hovered, or keyboard focus is somewhere in the row.
const HOVER_LINE = ["opacity-0", "group-hover/row:opacity-100", "group-has-[:focus-visible]/row:opacity-100", "pointer-coarse:opacity-100"];

async function copyEach(container: ParentNode) {
  for (const button of container.querySelectorAll<HTMLElement>('[data-slot="row-actions"] button[aria-label="Copy message"]')) {
    await act(async () => { button.click(); });
  }
}

// Ends in a newline, as replies do: copied as written, not trimmed.
const REPLY_MARKDOWN = "Found it:\n\n- one\n- **two**\n\n```ts\nawait readToStart(page);\n```\n";

// With a mouse the line stands 4px under its message; a touch screen keeps
// 10px for Copy's touch area (at 10 above and 16 below a hidden line left a
// 50px hole between turns). The 8px to the row after it
// is the stylesheet's, by the row's slot, so the row itself carries no margin;
// both distances are measured in e2e/message-copy.
test("an action line stands closer to its message with a mouse, and its row carries no margin of its own", async () => {
  const { container } = await renderList(makeThread([
    userMessage(1, "2026-10-10T01:00:00.000Z", "Why does the test fail?"),
    assistantMessage(2, "2026-10-10T01:00:01.000Z", ["call-1"], "", "wake-1"),
    toolResultMessage(3, "call-1", "2026-10-10T01:00:02.000Z"),
    assistantMessage(4, "2026-10-10T01:02:05.000Z", [], "Found it.", "wake-1")
  ]));
  const spacing = (el: Element) => classesOf(el).filter((c) => /(^|:)-?m[tb]-/.test(c)).sort();
  const lines = actionLines(container);
  expect(lines.length).toBe(2);
  for (const line of lines) expect(spacing(line)).toEqual(["-mt-3", "pointer-coarse:-mt-1.5"]);
  for (const row of container.querySelectorAll('[data-slot="transcript-row"]')) expect(spacing(row)).toEqual([]);
});

test("the user's message and a turn's last reply each have a line under them; the reply's Copy takes all the turn said", async () => {
  const { container } = await renderList(makeThread([
    userMessage(1, "2026-10-10T01:00:00.000Z", "  Why does the  test fail?\nIt did twice."),
    assistantMessage(2, "2026-10-10T01:00:01.000Z", ["call-1"], "Looking at it.", "wake-1"),
    toolResultMessage(3, "call-1", "2026-10-10T01:00:02.000Z"),
    // A step that only called tools joins the run above and says nothing.
    assistantMessage(4, "2026-10-10T01:00:03.000Z", ["call-2"], "", "wake-1"),
    toolResultMessage(5, "call-2", "2026-10-10T01:00:04.000Z"),
    assistantMessage(6, "2026-10-10T01:02:05.000Z", [], REPLY_MARKDOWN, "wake-1")
  ]));
  // One under the bubble, one under the turn's last reply; none under what it said on the way.
  expect(actionLines(container).map(lineOf)).toEqual([
    { side: "end", shown: false, says: "01:00", copies: true },
    { side: "start", shown: true, says: "01:02", copies: true }
  ]);
  const [mine, reply] = actionLines(container);
  expect(mine!.closest('[data-slot="transcript-row"]')!.textContent).toContain("Why does the");
  expect(reply!.closest('[data-slot="transcript-row"]')!.textContent).toContain("Found it:");
  // In the row, the height kept whether or not it shows (its gaps: the test above).
  for (const line of [mine!, reply!]) {
    expect(line.parentElement!.getAttribute("data-slot")).toBe("transcript-row");
    expect(classesOf(line)).toContain("h-6");
  }
  // The time names the full date; nothing else on the row does.
  expect([...container.querySelectorAll('[data-slot="row-stamp"]')].map((stamp) => stamp.getAttribute("title")))
    .toEqual(["Oct 10, 2026, 01:00:00", "Oct 10, 2026, 01:02:05"]);
  // As typed and as written: the leading spaces and the reply's last newline are kept.
  await withClipboard(async (writes) => {
    await copyEach(container);
    expect(writes).toStrictEqual(["  Why does the  test fail?\nIt did twice.", `Looking at it.\n\n${REPLY_MARKDOWN}`]);
  });
  expect([...container.querySelectorAll('[data-slot="row-actions"] button[aria-label]')].map((b) => b.getAttribute("aria-label"))).toEqual(["Copied", "Copied"]);
});

test("only the most recent reply's line always shows; older replies' and the user's show on hover or focus, and on a touch screen", async () => {
  const { container } = await renderList(makeThread([
    ask("u1", 1, "2026-10-10T01:00:00.000Z", "First"),
    timedReply("a1", 2, "w1", "2026-10-10T01:00:10.000Z", "2026-10-10T01:00:00.500Z", "One."),
    ask("u2", 3, "2026-10-10T01:01:00.000Z", "Second"),
    timedReply("a2", 4, "w2", "2026-10-10T01:01:10.000Z", "2026-10-10T01:01:00.500Z", "Two.")
  ]));
  const lines = actionLines(container);
  expect(lines.map((line) => [lineOf(line).side, lineOf(line).shown])).toEqual([["end", false], ["start", false], ["end", false], ["start", true]]);
  for (const line of lines.slice(0, 3)) for (const c of HOVER_LINE) expect(classesOf(line)).toContain(c);
  // Each reply copies its own turn.
  await withClipboard(async (writes) => {
    await copyEach(container);
    expect(writes).toStrictEqual(["First", "One.", "Second", "Two."]);
  });
});

test("a turn still running has no line yet, and the reply before it keeps showing", async () => {
  const { container } = await renderList({
    ...makeThread([
      ask("u1", 1, "2026-10-10T01:00:00.000Z", "First"),
      timedReply("a1", 2, "w1", "2026-10-10T01:00:10.000Z", "2026-10-10T01:00:00.500Z", "One."),
      ask("u2", 3, "2026-10-10T01:01:00.000Z", "Second"),
      timedReply("a2", 4, "w2", "2026-10-10T01:03:10.000Z", "2026-10-10T01:01:00.500Z", "Still going.")
    ]),
    wakePhase: { wakeId: "w2", phase: "thinking" }
  });
  expect(container.textContent).toContain("Still going.");
  expect(actionLines(container).map((line) => [lineOf(line).side, lineOf(line).shown, lineOf(line).says])).toEqual([
    ["end", false, "01:00"], ["start", true, "01:00"], ["end", false, "01:01"]
  ]);
});

test("a long turn's reply says how long it worked after its time: on hover or focus, and always on a touch screen", async () => {
  const { container } = await renderList(makeThread([
    ask("u1", 1, "2026-09-29T10:00:00.000Z", "Run the tests"),
    timedReply("a1", 2, "w1", "2026-09-29T10:01:00.000Z", "2026-09-29T10:00:00.500Z", "Running them."),
    timedReply("a2", 3, "w1", "2026-09-29T10:01:20.500Z", "2026-09-29T10:00:00.500Z", "All pass."),
    ask("u2", 4, "2026-09-29T10:02:00.000Z", "Thanks"),
    timedReply("a3", 5, "w2", "2026-09-29T10:02:59.000Z", "2026-09-29T10:02:00.500Z", "Anytime.")
  ]));
  // No line of its own any more: the duration follows the reply's time.
  expect(container.querySelector('[data-slot="worked-for"]') === null).toBe(true);
  expect(actionLines(container).map((line) => lineOf(line).says)).toEqual(["10:00", "10:01 · Worked for 1m 20s", "10:02", "10:02"]);
  const long = actionLines(container)[1]!;
  const worked = long.querySelector('[data-slot="row-worked"]')!;
  // Hidden until the row is hovered or holds keyboard focus, as an older
  // reply's line is: were the two rules different, a duration could be "shown"
  // inside a line that is not. A touch screen can do neither, so
  // there it simply shows.
  for (const c of HOVER_LINE) expect(classesOf(worked)).toContain(c);
  // Nothing to press for it: the line's only control is Copy.
  expect([...long.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))).toEqual(["Copy message"]);
  // A turn under a minute: the time alone.
  const short = actionLines(container)[3]!;
  expect([short.querySelector('[data-slot="row-stamp"]')!.tagName, short.querySelector('[data-slot="row-worked"]') === null]).toEqual(["TIME", true]);
});

test("a message still being sent has its line too", async () => {
  const { container } = await renderList({
    ...makeThread([]),
    pendingUserMessages: new Map([["l1", { localId: "l1", content: "and this one", status: "sending", createdAt: "2026-10-10T01:00:00.000Z" }]])
  });
  expect(actionLines(container).map(lineOf)).toEqual([{ side: "end", shown: false, says: "01:00", copies: true }]);
  await withClipboard(async (writes) => {
    await copyEach(container);
    expect(writes).toStrictEqual(["and this one"]);
  });
});

test("what is neither the user's words, a reply's text nor a finished turn's last row has no line", async () => {
  const { container } = await renderList({
    ...makeThread([
      // A worker's reply, and a watch event the agent has not answered.
      workerReply(0, "feat-1", "Parser"),
      watchEvent(),
      // A step that only called tools, in the turn still under way (a finished
      // turn that said nothing has a line: see "a turn that ends without a reply").
      row({ role: "assistant", source: "self", wakeId: "w1", content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "t9", toolName: "bash", args: { command: "ls" } }] } }),
      row({ role: "user", source: "compression", content: { type: "summary", summary: "The gist so far.", replacedRange: [1, 4], replacedCount: 4, retained: [] } })
    ]),
    wakePhase: { wakeId: "w1", phase: "thinking" },
    streamingAssistant: { wakeId: "w1", totalText: "Still typing" }
  });
  expect(container.textContent).toContain("Still typing");
  expect(container.querySelectorAll('[data-slot="tool-run-line"]')).toHaveLength(1);
  expect(actionLines(container)).toHaveLength(0);
});

// While older messages remain, a turn is whole only if the loaded messages
// reach back to when it began: everything it said came after that.
test("a turn whose start is not loaded offers no Copy: half a turn is never copied", async () => {
  const said = [
    timedReply("a1", 7, "w1", "2026-10-10T01:00:10.000Z", "2026-10-10T01:00:00.500Z", "…and the second half."),
    timedReply("a2", 8, "w1", "2026-10-10T01:00:20.000Z", "2026-10-10T01:00:00.500Z", "Done.")
  ];
  const copies = async (messages: ThreadState["messages"], hasMoreOlder: boolean) => {
    const view = await renderList({ ...makeThread(messages), hasMoreOlder });
    const lines = actionLines(view.container).filter((line) => line.dataset.side === "start").map(lineOf);
    view.unmount();
    return lines;
  };
  // The first loaded message is the turn's own: what it said before may be missing.
  expect(await copies(said, true)).toEqual([{ side: "start", shown: true, says: "01:00", copies: false }]);
  // So it may when the first loaded message is an alarm that fired mid-turn, in no turn itself.
  const alarm = row({ id: "al", seq: 6, role: "user", source: "alarm", createdAt: "2026-10-10T01:00:05.000Z", content: { type: "text", text: "[Mandate alarm]\nnote: check the build" } });
  expect((await copies([alarm, ...said], true)).map((line) => line.copies)).toEqual([false]);
  // Loaded back to the message that began it: whole, though older messages remain.
  const began = ask("u0", 5, "2026-10-10T01:00:00.000Z", "Go");
  expect((await copies([began, ...said], true)).map((line) => line.copies)).toEqual([true]);
  // Nothing older to load: whole.
  const whole = await renderList({ ...makeThread(said), hasMoreOlder: false });
  await withClipboard(async (writes) => {
    await copyEach(whole.container);
    expect(writes).toStrictEqual(["…and the second half.\n\nDone."]);
  });
});

test("a reply outside any turn copies itself", async () => {
  const { container } = await renderList(makeThread([
    assistantMessage(1, "2026-10-10T01:00:00.000Z", [], "One."),
    assistantMessage(2, "2026-10-10T01:00:30.000Z", [], "Two.")
  ]));
  expect(actionLines(container).map((line) => lineOf(line).shown)).toEqual([false, true]);
  await withClipboard(async (writes) => {
    await copyEach(container);
    expect(writes).toStrictEqual(["One.", "Two."]);
  });
});

test("a reply is not drawn afresh when its turn ends and its line appears", async () => {
  const messages = [
    ask("u1", 1, "2026-10-10T01:00:00.000Z", "Go"),
    timedReply("a1", 2, "w1", "2026-10-10T01:00:10.000Z", "2026-10-10T01:00:00.500Z", "Done.")
  ];
  const list = (thread: ThreadState) => <ChatMessageList thread={thread} onLoadOlder={async () => {}} onRetryFailed={() => {}} onOpenWorker={() => {}} />;
  const running: ThreadState = { ...makeThread(messages), wakePhase: { wakeId: "w1", phase: "thinking" } };
  const { host, rerender } = await mountAsync(list(running));
  await settle();
  const said = () => [...host.querySelectorAll("p")].find((p) => p.textContent === "Done.")!;
  const before = said();
  expect(actionLines(host).map((line) => lineOf(line).side)).toStrictEqual(["end"]);
  rerender(list({ ...running, wakePhase: { wakeId: null, phase: "idle" } }));
  await settle();
  expect(actionLines(host).map((line) => lineOf(line).side)).toStrictEqual(["end", "start"]);
  // The same node: a frame that only came with the line would have remounted the row.
  expect(said() === before).toBe(true);
});

// ── the manager's messages in a worker's chat ───────
// Every bubble in a worker's chat was its manager's, drawn as
// the user's own. They now say whose they are, and a long one is folded.

function fromManager(seq: number, createdAt: string, text: string): ChatMessage {
  return { ...userMessage(seq, createdAt, text), id: `manager-${seq}`, source: "manager" };
}
const LONG_TASK = `Task: sort this week's export records.\n${"Check each record's source and time. ".repeat(60)}`;
const bubbles = (container: ParentNode) => [...container.querySelectorAll<HTMLElement>('[data-slot="transcript-row"]')]
  .filter((row) => row.querySelector('[data-slot="user-bubble"]'))
  .map((row) => ({
    sender: row.querySelector('[data-slot="sender-label"]')?.textContent ?? null,
    fold: row.querySelector('[data-slot="bubble-fold"]')?.textContent ?? null,
    clamped: classesOf(row.querySelector('[data-slot="bubble-text"]')!).includes("line-clamp-8")
  }));

test("the manager's messages are labelled Manager; the user's own are not, and only the manager's long one folds", async () => {
  const { container } = await renderList(makeThread([
    fromManager(1, "2026-10-09T15:54:00.000Z", LONG_TASK),
    timedReply("r1", 2, "w1", "2026-10-09T15:56:00.000Z", "2026-10-09T15:54:01.000Z", "Checked."),
    fromManager(3, "2026-10-09T16:20:00.000Z", "Please check only the first section of this report."),
    timedReply("r2", 4, "w2", "2026-10-09T16:21:00.000Z", "2026-10-09T16:20:01.000Z", "Corrected."),
    userMessage(5, "2026-10-09T16:24:00.000Z", LONG_TASK)
  ]));
  expect(LONG_TASK.length).toBeGreaterThan(600);
  expect(bubbles(container)).toEqual([
    { sender: "Manager", fold: "Show more", clamped: true },
    { sender: "Manager", fold: null, clamped: false },
    { sender: null, fold: null, clamped: false }
  ]);
});

test("Show more opens a folded message in place and Show less folds it again; Copy takes all of it either way", async () => {
  await withClipboard(async (writes) => {
    const { container } = await renderList(makeThread([
      fromManager(1, "2026-10-09T15:54:00.000Z", LONG_TASK),
      timedReply("r1", 2, "w1", "2026-10-09T15:56:00.000Z", "2026-10-09T15:54:01.000Z", "Checked.")
    ]));
    // The line's one button: for 1.5s after a copy its label reads Copied.
    const copyTask = async () => {
      await act(async () => { container.querySelector<HTMLElement>('[data-slot="row-actions"][data-side="end"] button')!.click(); });
    };
    await copyTask();
    await act(async () => { container.querySelector<HTMLElement>('[data-slot="bubble-fold"]')!.click(); });
    expect(bubbles(container)[0]).toEqual({ sender: "Manager", fold: "Show less", clamped: false });
    await copyTask();
    await act(async () => { container.querySelector<HTMLElement>('[data-slot="bubble-fold"]')!.click(); });
    expect(bubbles(container)[0]).toEqual({ sender: "Manager", fold: "Show more", clamped: true });
    expect(writes).toStrictEqual([LONG_TASK, LONG_TASK]);
  });
});

test("another conversation opens with its long messages folded again", async () => {
  const first = makeThread([fromManager(1, "2026-10-09T15:54:00.000Z", LONG_TASK)]);
  const { host, rerender } = await mountAsync(
    <ChatMessageList thread={first} onLoadOlder={async () => {}} onRetryFailed={() => {}} onOpenWorker={() => {}} />
  );
  await settle();
  await act(async () => { host.querySelector<HTMLElement>('[data-slot="bubble-fold"]')!.click(); });
  expect(bubbles(host)[0]!.clamped).toBe(false);
  // The same message id in another thread: what was opened belonged to the first.
  const second = { ...first, threadId: "thr-2", messages: first.messages.map((m) => ({ ...m, threadId: "thr-2" })) };
  await act(async () => { rerender(<ChatMessageList thread={second} onLoadOlder={async () => {}} onRetryFailed={() => {}} onOpenWorker={() => {}} />); });
  await settle();
  expect(bubbles(host)[0]!.clamped).toBe(true);
});

// ── a turn that ends without a reply ────────────────────────────────────
// The agent tidied up and had nothing to add. The last thing such a turn drew
// was a folded run of tool calls, which is also what a turn still working
// looks like. Its last row now has a line of its own: under the sentence the
// agent closed with, the time; with no such sentence, that it finished.

type NamedCall = [id: string, name: string, args?: Record<string, unknown>];
function called(seq: number, wakeId: string, createdAt: string, calls: NamedCall[], wakeStartedAt: string, text = ""): Row {
  return {
    id: `step-${seq}`, threadId: "thr-1", seq, role: "assistant", source: "self", sourceThreadId: null, wakeId, wakeStartedAt, createdAt,
    content: { type: "assistant", text, toolCalls: calls.map(([toolCallId, toolName, args]) => ({ toolCallId, toolName, args: args ?? {} })) }
  };
}
function answered(seq: number, wakeId: string, toolCallId: string, toolName: string, createdAt: string): Row {
  return {
    id: `answer-${seq}`, threadId: "thr-1", seq, role: "tool", source: "self", sourceThreadId: null, wakeId, createdAt,
    content: { type: "tool_result", toolCallId, toolName, result: { ok: true } }
  };
}
const CLOSING = "The rewrite is finished and nothing is waiting on a worker.";
/** A question and its answer, then a turn that tidies up and says nothing. `last` is what its final call is. */
function afterTidyingUp(last: NamedCall | null, endsAt = "2026-10-10T01:06:10.000Z"): Row[] {
  const began = "2026-10-10T01:06:00.000Z";
  return [
    ask("q1", 1, "2026-10-10T01:00:00.000Z", "Post the comment as written."),
    timedReply("r1", 2, "wake-0", "2026-10-10T01:01:00.000Z", "2026-10-10T01:00:01.000Z", "Posted as written."),
    called(3, "wake-1", "2026-10-10T01:06:01.000Z", [["c1", "read_plan"]], began),
    answered(4, "wake-1", "c1", "read_plan", "2026-10-10T01:06:02.000Z"),
    called(5, "wake-1", "2026-10-10T01:06:03.000Z", [["c2", "dismiss_work_item"], ["c3", "memory_update"]], began),
    answered(6, "wake-1", "c2", "dismiss_work_item", "2026-10-10T01:06:04.000Z"),
    answered(7, "wake-1", "c3", "memory_update", "2026-10-10T01:06:05.000Z"),
    ...(last ? [called(8, "wake-1", "2026-10-10T01:06:06.000Z", [last], began), answered(9, "wake-1", last[0], last[1], "2026-10-10T01:06:07.000Z")] : []),
    called(10, "wake-1", endsAt, [], began)
  ];
}
/** The stopped turns the page has heard of, set as an event sets them. */
const hearStopped = (wakeIds: string[]) => act(async () => { useInterruptedWakesStore.setState({ ids: new Set(wakeIds) }); });
const settledLines = (container: ParentNode) => [...container.querySelectorAll('[data-slot="turn-settled"]')].map((el) => el.textContent);
const runLines = (container: ParentNode) => [...container.querySelectorAll('[data-slot="tool-run-line"]')].map((el) => el.textContent);

test("a turn that closed its follow-up and said nothing ends with the sentence it gave; the call leaves the run", async () => {
  const { container } = await renderList(makeThread(afterTidyingUp(["c4", "end_sweep", { reason: CLOSING }])));
  expect(settledLines(container)).toEqual([CLOSING]);
  // Three calls are left in the run, where there were four.
  expect(runLines(container)).toEqual(["Read a plan, used 2 tools"]);
  // The sentence is the row's last thing, after its run.
  const row = container.querySelector('[data-slot="turn-settled"]')!.closest('[data-slot="transcript-row"]')!;
  const order = [...row.querySelectorAll('[data-slot="tool-run-line"], [data-slot="turn-settled"], [data-slot="row-actions"]')].map((el) => (el as HTMLElement).dataset.slot);
  expect(order).toStrictEqual(["tool-run-line", "turn-settled", "row-actions"]);
  expect(actionLines(container).map(lineOf)).toEqual([
    { side: "end", shown: false, says: "01:00", copies: true },
    // The last reply keeps its line in sight: the turn after it said nothing.
    { side: "start", shown: true, says: "01:01", copies: true },
    // Under the sentence only the time: the sentence says the rest.
    { side: "start", shown: true, says: "01:06", copies: false }
  ]);
  await openRuns(container);
  const calls = [...container.querySelectorAll('[data-slot="tool-call"]')].map((el) => el.textContent ?? "");
  expect(calls).toHaveLength(3);
  expect(calls.filter((text) => text.includes("Ended the sweep"))).toEqual([]);
});

test("a turn that said nothing and gave no closing sentence says that it finished, and when", async () => {
  const { container } = await renderList(makeThread(afterTidyingUp(null)));
  expect(settledLines(container)).toEqual([]);
  expect(runLines(container)).toEqual(["Read a plan, used 2 tools"]);
  expect(actionLines(container).map(lineOf)).toEqual([
    { side: "end", shown: false, says: "01:00", copies: true },
    { side: "start", shown: true, says: "01:01", copies: true },
    { side: "start", shown: true, says: "Finished without a reply · 01:06", copies: false }
  ]);
  const last = actionLines(container)[2]!;
  expect(last.closest('[data-slot="transcript-row"]')!.querySelector('[data-slot="tool-run-line"]')).not.toBe(null);
  expect(last.querySelector("time")!.getAttribute("title")).toBe(formatDateTimeTitle("2026-10-10T01:06:10.000Z"));
});

test("a turn that drew nothing after a worker's reply says under that reply that it finished, and when", async () => {
  // The manager read the reply and had nothing to add: its turn left one
  // empty step, which draws nothing, so the reply is where the page says so.
  const reply: Row = {
    id: "reply-3", threadId: "thr-1", seq: 3, role: "user", source: "feature-message", sourceThreadId: "thr-feat-1", wakeId: null,
    createdAt: "2026-10-10T01:05:00.000Z",
    content: { type: "text", text: "Single-file checks are done; all 38 pass.", metadata: featureMessageReplyMetadata({ featureId: "feat-1", featureName: "legacy-compat" }) }
  };
  const { container } = await renderList(makeThread([
    ask("q1", 1, "2026-10-10T01:00:00.000Z", "Port the legacy compatibility cases."),
    timedReply("r1", 2, "wake-0", "2026-10-10T01:01:00.000Z", "2026-10-10T01:00:01.000Z", "Started a worker on it."),
    reply,
    // Woken by mail: the reply.
    { ...called(4, "wake-1", "2026-10-10T01:05:09.000Z", [], "2026-10-10T01:05:01.000Z"), wakeReason: "user" }
  ]));
  expect(actionLines(container).map(lineOf)).toEqual([
    { side: "end", shown: false, says: "01:00", copies: true },
    { side: "start", shown: true, says: "01:01", copies: true },
    { side: "start", shown: true, says: "Finished without a reply · 01:05", copies: false }
  ]);
  const last = actionLines(container)[2]!;
  expect(last.closest('[data-slot="transcript-row"]')!.querySelector('[data-slot="worker-reply"]')).not.toBe(null);
  expect(last.querySelector("time")!.getAttribute("title")).toBe(formatDateTimeTitle("2026-10-10T01:05:09.000Z"));
  // A turn heard live: what woke it is known from its start, not its messages.
  const live = makeThread([reply, called(4, "wake-1", "2026-10-10T01:05:09.000Z", [], "2026-10-10T01:05:01.000Z")]);
  live.wakeReasonsById = new Map([["wake-1", "user"]]);
  const heard = await renderList(live);
  expect(actionLines(heard.container).map(lineOf)).toEqual([{ side: "start", shown: true, says: "Finished without a reply · 01:05", copies: false }]);
});

test("a turn a person stopped before it replied says it was interrupted, whether its messages say so or the page heard", async () => {
  // Registered before any list is mounted, so it runs after they are gone.
  onCleanup(() => useInterruptedWakesStore.setState({ ids: new Set() }));
  const interrupted = [
    { side: "end", shown: false, says: "01:00", copies: true },
    { side: "start", shown: true, says: "01:01", copies: true },
    { side: "start", shown: true, says: "Interrupted · 01:06", copies: false }
  ];
  // Read after the stop: each of the turn's messages says so.
  const read = await renderList(makeThread(afterTidyingUp(null).map((m) => (m.wakeId === "wake-1" ? { ...m, wakeInterrupted: true } : m))));
  expect(read.container.querySelectorAll('[data-slot="row-actions"]')).toHaveLength(3);
  expect(actionLines(read.container).map(lineOf)).toEqual(interrupted);
  // Stopped while the page was open: its messages were read before it ended, and the page heard.
  await hearStopped(["wake-1"]);
  const heard = await renderList(makeThread(afterTidyingUp(null)));
  expect(actionLines(heard.container).map(lineOf)).toEqual(interrupted);
  // A stop of some other turn leaves this one finished.
  await hearStopped(["wake-0"]);
  const other = await renderList(makeThread(afterTidyingUp(null)));
  expect(actionLines(other.container).map(lineOf)[2]).toEqual({ side: "start", shown: true, says: "Finished without a reply · 01:06", copies: false });
});

test("a stopped turn that had closed its follow-up shows no closing sentence: the call is back in its run", async () => {
  onCleanup(() => useInterruptedWakesStore.setState({ ids: new Set() }));
  await hearStopped(["wake-1"]);
  const { container } = await renderList(makeThread(afterTidyingUp(["c4", "end_sweep", { reason: CLOSING }])));
  expect(settledLines(container)).toEqual([]);
  expect(runLines(container)).toEqual(["Read a plan, used 3 tools"]);
  expect(lineOf(actionLines(container)[2]!)).toEqual({ side: "start", shown: true, says: "Interrupted · 01:06", copies: false });
});

test("a silent turn that worked over a minute says how long, as a reply's line does", async () => {
  const { container } = await renderList(makeThread(afterTidyingUp(null, "2026-10-10T01:09:12.000Z")));
  const last = actionLines(container)[2]!;
  expect(last.textContent).toBe("Finished without a reply · 01:09 · Worked for 3m 12s");
  expect(classesOf(last.querySelector('[data-slot="row-worked"]')!)).toEqual(expect.arrayContaining(HOVER_LINE));
});

test("once a later turn has replied, an earlier silent turn's line shows only while its row is hovered", async () => {
  const { container } = await renderList(makeThread([
    ...afterTidyingUp(null),
    ask("q2", 11, "2026-10-10T01:20:00.000Z", "And the changelog?"),
    timedReply("r2", 12, "wake-2", "2026-10-10T01:20:30.000Z", "2026-10-10T01:20:01.000Z", "Updated too.")
  ]));
  const lines = actionLines(container);
  expect(lines.map(lineOf).filter((line) => line.side === "start")).toEqual([
    { side: "start", shown: false, says: "01:01", copies: true },
    { side: "start", shown: false, says: "Finished without a reply · 01:06", copies: false },
    { side: "start", shown: true, says: "01:20", copies: true }
  ]);
  const silent = lines.find((line) => line.textContent?.startsWith("Finished"))!;
  expect(classesOf(silent)).toEqual(expect.arrayContaining(HOVER_LINE));
});

test("a turn still running has no such line, nor has one that replied after closing its follow-up", async () => {
  const running = makeThread(afterTidyingUp(null).slice(0, -1));
  running.wakePhase = { phase: "thinking", wakeId: "wake-1" } as ThreadState["wakePhase"];
  const live = await renderList(running);
  expect(actionLines(live.container).map(lineOf).map((line) => line.says)).toEqual(["01:00", "01:01"]);
  live.unmount();

  const replied = afterTidyingUp(["c4", "end_sweep", { reason: CLOSING }]);
  replied[replied.length - 1] = called(10, "wake-1", "2026-10-10T01:06:10.000Z", [], "2026-10-10T01:06:00.000Z", "All of it is settled.");
  const { container } = await renderList(makeThread(replied));
  // The reply is the conclusion: no closing line, and the call stays in its run.
  expect(settledLines(container)).toEqual([]);
  expect(runLines(container)).toEqual(["Read a plan, used 3 tools"]);
  expect(actionLines(container).map(lineOf).map((line) => [line.says, line.copies])).toEqual([["01:00", true], ["01:01", true], ["01:06", true]]);
  await openRuns(container);
  expect([...container.querySelectorAll('[data-slot="tool-call"]')].filter((el) => el.textContent?.includes("Ended the sweep"))).toHaveLength(1);
});

test("when closing its follow-up is all a turn did, the sentence stands alone", async () => {
  const began = "2026-10-10T01:06:00.000Z";
  const { container } = await renderList(makeThread([
    ask("q1", 1, "2026-10-10T01:00:00.000Z", "Post the comment as written."),
    timedReply("r1", 2, "wake-0", "2026-10-10T01:01:00.000Z", "2026-10-10T01:00:01.000Z", "Posted as written."),
    called(3, "wake-1", "2026-10-10T01:06:01.000Z", [["c1", "end_sweep", { reason: CLOSING }]], began),
    answered(4, "wake-1", "c1", "end_sweep", "2026-10-10T01:06:02.000Z"),
    called(5, "wake-1", "2026-10-10T01:06:03.000Z", [], began)
  ]));
  expect(runLines(container)).toEqual([]);
  expect(settledLines(container)).toEqual([CLOSING]);
  expect(lineOf(actionLines(container)[2]!)).toEqual({ side: "start", shown: true, says: "01:06", copies: false });
});

test("a turn still writing has no ending, though its phase has not caught up: the closing call stays in its run", async () => {
  // After a reconnect the stream can be back before the phase is.
  const began = "2026-10-10T01:06:00.000Z";
  const { container } = await renderList({
    ...makeThread([
      called(1, "wake-1", "2026-10-10T01:06:01.000Z", [["c1", "end_sweep", { reason: CLOSING }]], began),
      answered(2, "wake-1", "c1", "end_sweep", "2026-10-10T01:06:02.000Z")
    ]),
    streamingAssistant: { wakeId: "wake-1", totalText: "I also need to check the docs." }
  });
  expect(container.textContent).toContain("I also need to check the docs.");
  expect(settledLines(container)).toEqual([]);
  expect(runLines(container).map((text) => text?.startsWith("Ended the sweep"))).toEqual([true]);
  expect(actionLines(container)).toHaveLength(0);
});

test("a run that left the page as its turn's closing sentence no longer pauses following", async () => {
  // A run open on screen pauses following (see "a run left open on a desktop…").
  // Here the open run is the closing call alone: when the turn ends, the call
  // becomes the turn's last line and the run is gone, so nothing is open.
  const began = "2026-10-10T01:06:00.000Z";
  onCleanup(() => useInterruptedWakesStore.setState({ ids: new Set() }));
  const run = async (name: string, stopped = false) => {
    useInterruptedWakesStore.setState({ ids: new Set() });
    const live: Row[] = [
      called(1, "wake-1", "2026-10-10T01:06:01.000Z", [["c1", name, { reason: CLOSING }]], began),
      answered(2, "wake-1", "c1", name, "2026-10-10T01:06:02.000Z")
    ];
    const ended: Row[] = [...live, called(3, "wake-1", "2026-10-10T01:06:03.000Z", [], began)];
    const next = ask("q9", 4, "2026-10-10T01:07:00.000Z", "Next task.");
    const list = (thread: ThreadState) => <ChatMessageList thread={thread} onLoadOlder={async () => {}} onRetryFailed={() => {}} />;
    const working = { ...makeThread(live), wakePhase: { phase: "thinking", wakeId: "wake-1" } as ThreadState["wakePhase"] };
    const view = await mountAsync(list(working));
    await settle();
    const container = view.host;
    const draw = async (thread: ThreadState) => { view.rerender(list(thread)); await settle(); };
    try {
      const scroller = container.querySelector<HTMLElement>("[class*='overflow-y-auto']")!;
      let contentHeight = 5000;
      Object.defineProperty(scroller, "scrollHeight", { get: () => contentHeight, configurable: true });
      Object.defineProperty(scroller, "clientHeight", { get: () => 500, configurable: true });
      await act(async () => {
        scroller.scrollTop = 4500;
        scroller.dispatchEvent(new window.Event("scroll"));
      });
      expect(runLines(container)).toHaveLength(1);
      await openRuns(container);
      // The page hears of a stop as the turn ends.
      if (stopped) await act(async () => { useInterruptedWakesStore.getState().ended("wake-1", "canceled"); });
      await draw(makeThread(ended));
      const runsLeft = runLines(container).length;
      contentHeight = 5400;
      await draw(makeThread([...ended, next]));
      return { runsLeft, paused: container.querySelector('[aria-label="Scroll to latest message"]') !== null };
    } finally {
      view.unmount();
    }
  };
  // The control: any other call keeps its run, and an open run holds the pause.
  expect(await run("read_plan")).toEqual({ runsLeft: 1, paused: true });
  expect(await run("end_sweep")).toEqual({ runsLeft: 0, paused: false });
  // A person stopped the turn: its closing call stays a call in its run, and that run, open, holds the pause.
  expect(await run("end_sweep", true)).toEqual({ runsLeft: 1, paused: true });
});
