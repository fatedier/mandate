import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ChatMessageList } from "@/routes/window/chat/ChatMessageList";
import { provenanceForWake } from "@/routes/window/chat/chatProvenance";
import { newThreadState, useAgentChatStore, type AgentMessage, type ThreadState } from "@/store/agent-chat";
import { runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";
import { agentMessage } from "../helpers/typed.js";

// A subagent's result lands in the conversation that started it as a card,
// as a worker's report does: not the user's words, and the cause of the
// agent's next turn. The card is drawn from what the result records (its
// metadata); the message's text is what the model reads, and is not drawn.

afterEach(() => {
  runCleanups();
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
});

const REPLY = "Found **two call sites** of retryWake: the runtime's dispatcher and the wake loop's step.";
const MODEL_TEXT = `[Subagent result] “Find the retry call sites”: finished after 4m 12s.\n\n${REPLY}`;

function result(over: { text?: string; metadata?: Record<string, unknown> } = {}): AgentMessage {
  return agentMessage({
    id: "res-1", threadId: "thr_m", seq: 5, role: "user", source: "subagent-result", sourceThreadId: "thr_child_r",
    createdAt: "2026-10-18T09:04:14.000Z",
    content: {
      type: "text",
      text: over.text ?? MODEL_TEXT,
      metadata: over.metadata ?? { taskId: "task_1", outcome: "finished", title: "Find the retry call sites", durationMs: 252_000, reply: REPLY }
    }
  });
}
const answered = agentMessage({
  id: "a-6", threadId: "thr_m", seq: 6, role: "assistant", source: "self", wakeId: "w_res", wakeReason: "subagent-result",
  createdAt: "2026-10-18T09:04:20.000Z", content: { type: "assistant", text: "Both call sites are in the wake path." }
});

async function list(messages: AgentMessage[]) {
  const thread: ThreadState = { ...newThreadState(), threadId: "thr_m", loaded: true, messages, oldestSeqLoaded: messages[0]!.seq };
  const { host } = await mountAsync(<ChatMessageList thread={thread} onLoadOlder={async () => {}} />, { path: "/threads/thr_m" });
  await settle();
  return host;
}
const card = (host: ParentNode) => host.querySelector('[data-slot="subagent-result"]');

test("a result is a card: what it is, its job, how it ended and how long it took; then its reply as Markdown; nothing read for it", async () => {
  const calls = mockFetch(() => jsonResponse({ error: "not served" }, 500));
  const host = await list([result(), answered]);
  expect(card(host)!.querySelector('[data-slot="subagent-result-head"]')!.textContent).toBe("Subagent · Find the retry call sites · Finished · 4m 12s");
  expect(card(host)!.querySelector('[data-slot="subagent-result-reply"] strong')!.textContent).toBe("two call sites");
  // What the model reads is not drawn.
  expect(card(host)!.textContent).not.toContain("[Subagent result]");
  expect(calls).toHaveLength(0);
  // Not the user's words: no bubble and no Copy line under it.
  expect(host.querySelector('[data-slot="user-bubble"]') === null).toBe(true);
  expect(host.querySelector('[data-slot="row-actions"][data-side="end"]') === null).toBe(true);
});

test("the card says what the result records, whatever the model's text says", async () => {
  const host = await list([result({
    text: "[Subagent result] “Find the retry call sites”: finished after 4m 12s.\n\nSomething else entirely.",
    metadata: { taskId: "task_1", outcome: "finished", title: "Find the retry call sites", durationMs: 42_000, reply: "Nothing calls it outside the wake loop." }
  })]);
  expect(card(host)!.querySelector('[data-slot="subagent-result-head"]')!.textContent).toBe("Subagent · Find the retry call sites · Finished · 42s");
  expect(card(host)!.querySelector('[data-slot="subagent-result-reply"]')!.textContent).toBe("Nothing calls it outside the wake loop.");
  expect(card(host)!.textContent).not.toContain("Something else entirely.");
});

test("a failed one says why, as its run recorded it; one that did not fail, or a result from before the reason was kept, says nothing more", async () => {
  const failed = await list([result({ metadata: {
    taskId: "task_1", outcome: "failed", title: "Find the retry call sites", durationMs: 42_000, reply: null, error: "The provider refused the request."
  } })]);
  expect(card(failed)!.querySelector('[data-slot="subagent-result-head"]')!.textContent).toBe("Subagent · Find the retry call sites · Failed · 42s");
  expect(card(failed)!.querySelector('[data-slot="subagent-result-error"]')!.textContent).toBe("The provider refused the request.");
  runCleanups();
  const older = await list([result({ metadata: { taskId: "task_1", outcome: "failed", title: "Find the retry call sites", durationMs: 42_000, reply: null } })]);
  expect(card(older)!.querySelector('[data-slot="subagent-result-error"]') === null).toBe(true);
  runCleanups();
  const finished = await list([result({ metadata: { taskId: "task_1", outcome: "finished", title: "Find the retry call sites", durationMs: 42_000, reply: REPLY, error: "stale" } })]);
  expect(card(finished)!.querySelector('[data-slot="subagent-result-error"]') === null).toBe(true);
});

test("a stopped one with nothing to say: how it ended alone, and nothing read for it", async () => {
  const calls = mockFetch(() => jsonResponse({ error: "not served" }, 500));
  const host = await list([result({
    text: "[Subagent result] “Benchmark notes”: stopped by the user after 0s, before it finished.",
    metadata: { taskId: "task_2", outcome: "stopped", title: "Benchmark notes", durationMs: 0, reply: null }
  })]);
  expect(card(host)!.querySelector('[data-slot="subagent-result-head"]')!.textContent).toBe("Subagent · Benchmark notes · Stopped");
  expect(card(host)!.querySelector('[data-slot="subagent-result-reply"]') === null).toBe(true);
  expect(calls).toHaveLength(0);
});

test("the turn the result woke has no cause line of its own: the card above it is its cause", async () => {
  expect(provenanceForWake("subagent-result", { wakeId: "w_res" })).toBeNull();
  const host = await list([result(), answered]);
  expect(host.textContent).toContain("Both call sites are in the wake path.");
  expect(host.querySelector('[data-slot="provenance-label"]') === null).toBe(true);
});

test("a message that says it is a result but carries none is not drawn, and never as the user's bubble", async () => {
  const host = await list([result({ metadata: { taskId: "task_3" } })]);
  expect(card(host) === null).toBe(true);
  expect(host.querySelector('[data-slot="user-bubble"]') === null).toBe(true);
});

// A run opened while its subagent call waited for its answer loses the call
// when the answer comes (the call becomes its own line). The mark it left
// must not keep the list from following, with nothing open on screen.
test("a run opened while its subagent call waited, then emptied by the answer, does not keep the list from following", async () => {
  mockFetch(({ url }) => (url.endsWith("/tasks") ? jsonResponse({ tasks: [] }) : jsonResponse({ error: "not served" }, 500)));
  const call = (name: string, args: Record<string, unknown>) => agentMessage({
    id: "a-1", threadId: "thr_m", seq: 1, role: "assistant", source: "self", wakeId: "w_p", createdAt: "2026-10-18T09:00:00.000Z",
    content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "c-1", toolName: name, args }] }
  });
  const answer = (name: string, value: unknown) => agentMessage({
    id: "t-2", threadId: "thr_m", seq: 2, role: "tool", source: "self", wakeId: "w_p", createdAt: "2026-10-18T09:00:01.000Z",
    content: { type: "tool_result", toolCallId: "c-1", toolName: name, result: value }
  });
  const next = agentMessage({
    id: "a-3", threadId: "thr_m", seq: 3, role: "assistant", source: "self", wakeId: "w_p", createdAt: "2026-10-18T09:00:02.000Z",
    content: { type: "assistant", text: "Started it; its result comes back here." }
  });
  const run = async (name: string, args: Record<string, unknown>, value: unknown) => {
    const thread = (messages: AgentMessage[]): ThreadState => ({ ...newThreadState(), threadId: "thr_m", loaded: true, messages, oldestSeqLoaded: 1 });
    const view = await mountAsync(<ChatMessageList thread={thread([call(name, args)])} onLoadOlder={async () => {}} />, { path: "/threads/thr_m" });
    await settle();
    try {
      const scroller = view.host.querySelector<HTMLElement>("[class*='overflow-y-auto']")!;
      let contentHeight = 5000;
      Object.defineProperty(scroller, "scrollHeight", { get: () => contentHeight, configurable: true });
      Object.defineProperty(scroller, "clientHeight", { get: () => 500, configurable: true });
      await act(async () => {
        scroller.scrollTop = 4500;
        scroller.dispatchEvent(new window.Event("scroll"));
      });
      await act(async () => { view.host.querySelector<HTMLElement>('[data-slot="tool-run-line"]')!.click(); });
      contentHeight = 5400;
      view.rerender(<ChatMessageList thread={thread([call(name, args), answer(name, value), next])} onLoadOlder={async () => {}} />);
      await settle();
      return view.host.querySelector('[aria-label="Scroll to latest message"]') !== null;
    } finally {
      view.unmount();
    }
  };
  // The control: a run still on screen, opened, pauses following.
  expect(await run("bash", { command: "git log --oneline", description: "List the commits" }, "stdout:\nab12cd3\nexitCode: 0")).toBe(true);
  expect(await run("subagent", { title: "Find the retry call sites", task: "Find them." }, { taskId: "task_9", status: "started", message: "Started." })).toBe(false);
});

// A background command's end lands as one line: what it was, how it ended
// and how long it ran; never its output (the line where it started opens it).
test("a command's result is one line: Command, its description, its exit, its time; no output, not the user's words", async () => {
  const calls = mockFetch(() => jsonResponse({ error: "not served" }, 500));
  const ended = agentMessage({
    id: "cmd-1", threadId: "thr_m", seq: 5, role: "user", source: "command-result", createdAt: "2026-10-18T09:04:14.000Z",
    content: {
      type: "text",
      text: "[Background command] “Lint the whole tree”: exited 1 after 3m 09s.\n\nLast 1 of 412 lines (the whole output is in /out/x.log):\n3 issues found",
      metadata: { taskId: "task_lint", title: "Lint the whole tree", outcome: "exited", exitCode: 1, signal: null, durationMs: 189_000, outputLines: 412 }
    }
  });
  const host = await list([ended, { ...answered, wakeReason: "command-result" }]);
  const row = host.querySelector('[data-slot="command-result"]');
  expect(row?.getAttribute("data-outcome")).toBe("exited");
  expect(row!.querySelector('[data-slot="command-result-head"]')!.textContent).toBe("Command · Lint the whole tree · Exit 1 · 3m 09s");
  expect(row!.querySelector('[data-slot="task-mark"]')!.getAttribute("class")).toContain("text-red");
  expect(row!.textContent).not.toContain("3 issues found");
  expect(calls).toHaveLength(0);
  expect(host.querySelector('[data-slot="user-bubble"]') === null).toBe(true);
  expect(host.querySelector('[data-slot="row-actions"][data-side="end"]') === null).toBe(true);
  // Its turn draws no cause line of its own: the result line is the cause.
  expect(provenanceForWake("command-result", { wakeId: "w", createdAt: "2026-10-18T09:04:20.000Z" })).toBeNull();
});

// A command's result that lands while the turn that started it goes on draws
// no line of its own: the line where it started already shows how it ended.
// One that wakes a later turn, or that nothing has answered yet, keeps it.
test("a command's result that lands in the turn that started it draws no line; one that wakes a later turn does", async () => {
  mockFetch(() => jsonResponse({ error: "not served" }, 500));
  const start = (wakeId: string) => [
    agentMessage({
      id: "s-1", threadId: "thr_m", seq: 1, role: "assistant", source: "self", wakeId, createdAt: "2026-10-21T14:17:17.000Z",
      content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "c-1", toolName: "bash", args: { command: "curl -s localhost", description: "Send two requests", run_in_background: true } }] }
    }),
    agentMessage({
      id: "s-2", threadId: "thr_m", seq: 2, role: "tool", source: "self", wakeId, createdAt: "2026-10-21T14:17:17.500Z",
      content: { type: "tool_result", toolCallId: "c-1", toolName: "bash", result: { taskId: "task_bg", status: "running", message: "Running in the background as task_bg." } }
    })
  ];
  const landed = agentMessage({
    id: "r-1", threadId: "thr_m", seq: 3, role: "user", source: "command-result", createdAt: "2026-10-21T14:17:27.000Z",
    content: {
      type: "text",
      text: "[Background command] “Send two requests”: exited 0 after 9s.",
      metadata: { taskId: "task_bg", title: "Send two requests", outcome: "exited", exitCode: 0, signal: null, durationMs: 9_000, outputLines: 12 }
    }
  });
  const after = (wakeId: string) => agentMessage({
    id: "n-1", threadId: "thr_m", seq: 4, role: "assistant", source: "self", wakeId, createdAt: "2026-10-21T14:17:45.000Z",
    content: { type: "assistant", text: "Both requests came back 200." }
  });
  const resultLine = (host: ParentNode) => host.querySelector('[data-slot="command-result"]') !== null;

  const sameTurn = await list([...start("w_a"), landed, after("w_a")]);
  expect(sameTurn.textContent).toContain("Both requests came back 200.");
  expect(resultLine(sameTurn)).toBe(false);
  expect(resultLine(await list([...start("w_a"), landed, { ...after("w_b"), wakeReason: "command-result" }]))).toBe(true);
  expect(resultLine(await list([...start("w_a"), landed]))).toBe(true);
  // Mail that lands with it (here the turn's runtime context) does not decide.
  const context = agentMessage({ id: "x-1", threadId: "thr_m", seq: 4, role: "user", source: "runtime-context", createdAt: "2026-10-21T14:17:28.000Z", content: { type: "text", text: "[runtime_context]" } });
  expect(resultLine(await list([...start("w_a"), landed, context, { ...after("w_a"), seq: 5 }]))).toBe(false);
  // Older messages not loaded yet: without the call that started it there is no
  // start line on the page, so the result keeps its line.
  expect(resultLine(await list([start("w_a")[1]!, landed, after("w_a")]))).toBe(true);
});
