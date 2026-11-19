import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { act, useState } from "react";
import type { BackgroundTaskDto } from "@shared/api-contracts";
import { AssistantMessage } from "@/routes/window/chat/AssistantMessage";
import { endedOpenKey, peekOpenKey } from "@/routes/window/chat/subagent-lines";
import type { ToolResultSpec } from "@/routes/window/chat/tool-run-summary";
import { useAgentChatStore, type AgentMessage } from "@/store/agent-chat";
import { useBackgroundTasksStore } from "@/store/background-tasks";
import { runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mountAsync, settleUntil } from "../helpers/mount.js";
import { backgroundTask, resetBackgroundTasksStore } from "../helpers/subagent-client.js";
import { agentMessage } from "../helpers/typed.js";

// The commands a turn started in the background, once two or more have
// ended, are one line: how many ended and how. It sits above the turn's own
// line, which stays last, next to what the turn is doing now. Pressed, it
// lists them where it is, the latest to end first.

beforeEach(() => { setSystemTime(new Date("2026-10-18T09:05:00.000Z")); });
afterEach(() => {
  runCleanups();
  setSystemTime();
  document.body.innerHTML = "";
  resetBackgroundTasksStore();
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
});

const background = (n: number) => ({ toolCallId: `c${n}`, toolName: "bash", args: { command: `job-${n}`, description: `Job ${n}`, run_in_background: true } });
const LS = { toolCallId: "c-ls", toolName: "bash", args: { command: "ls", description: "List the build output" } };
const reply = (calls: Array<{ toolCallId: string; toolName: string; args: unknown }>): AgentMessage => agentMessage({
  id: "a-run", threadId: "thr_m", role: "assistant", source: "self", wakeId: "w_run", createdAt: "2026-10-18T09:00:00.000Z",
  content: { type: "assistant", text: "", toolCalls: calls }
});
const results = (n: number): Map<string, ToolResultSpec> => new Map<string, ToolResultSpec>([
  ...Array.from({ length: n }, (_, i): [string, ToolResultSpec] => [`c${i + 1}`, { result: { taskId: `task_${i + 1}`, status: "running" }, createdAt: "2026-10-18T09:00:01.000Z" }]),
  ["c-ls", { result: "stdout:\nbin\nexitCode: 0", createdAt: "2026-10-18T09:00:02.000Z" }]
]);
const command = (n: number, over: Partial<BackgroundTaskDto> = {}) => backgroundTask({
  id: `task_${n}`, kind: "command", childThreadId: null, title: `Job ${n}`, startedAt: "2026-10-18T09:00:01.000Z", ...over
});
const done = (n: number, finishedAt: string, over: Partial<BackgroundTaskDto> = {}) => command(n, { status: "finished", exitCode: 0, finishedAt, ...over });
function hold(...tasks: BackgroundTaskDto[]) {
  act(() => { useBackgroundTasksStore.setState({ byThread: new Map([["thr_m", tasks]]) }); });
}
/** Three ended (one failed, one stopped) and one still running. */
function holdFour() {
  hold(
    done(1, "2026-10-18T09:00:10.000Z"),
    done(2, "2026-10-18T09:00:30.000Z", { status: "failed", exitCode: 1 }),
    done(3, "2026-10-18T09:00:20.000Z", { status: "stopped", stoppedBy: "user", exitCode: null }),
    command(4)
  );
}
const SLOTS = '[data-slot="ended-commands-line"], [data-slot="subagent-line"], [data-slot="tool-run-line"]';
const order = (host: ParentNode) => [...host.querySelectorAll<HTMLElement>(SLOTS)].map((el) => el.dataset.slot ?? "");
const group = (host: ParentNode) => host.querySelector<HTMLElement>('[data-slot="ended-commands-line"]');
const textOf = (el: Element | null | undefined) => el?.textContent ?? null;
const listed = (host: ParentNode) => [...host.querySelectorAll('[data-slot="ended-commands-list"] [data-slot="subagent-line-text"]')].map((el) => el.textContent ?? "");
const singles = (host: ParentNode) => [...host.querySelectorAll('[data-slot="subagent-line"]')]
  .filter((el) => el.closest('[data-slot="ended-commands-list"]') === null)
  .map((el) => el.querySelector('[data-slot="subagent-line-text"]')?.textContent ?? "");

async function render(message: AgentMessage, toolResults: Map<string, ToolResultSpec>, liveRun = false) {
  const { host } = await mountAsync(
    <AssistantMessage message={message} toolResultsByCallId={toolResults} activeToolCallId={null} liveRun={liveRun} />,
    { path: "/threads/thr_m" }
  );
  return host;
}

test("ended commands are one line above the turn's own line, which stays last; one still running keeps its own line", async () => {
  holdFour();
  const calls = mockFetch(() => jsonResponse({ error: "not served" }, 500));
  const host = await render(reply([background(1), background(2), background(3), background(4), LS]), results(4), true);
  await settleUntil(() => group(host) !== null, "the folded line");
  expect(order(host)).toEqual(["ended-commands-line", "subagent-line", "tool-run-line"]);
  expect(textOf(host.querySelector('[data-slot="ended-commands-text"]'))).toBe("3 commands ended · 1 failed · 1 stopped");
  // Failed is red; the rest is not.
  const clauses = [...host.querySelectorAll<HTMLElement>('[data-slot="ended-commands-clause"]')].map((el) => [el.textContent, el.classList.contains("text-destructive")]);
  expect(clauses).toEqual([[" · 1 failed", true], [" · 1 stopped", false]]);
  expect(singles(host)).toEqual(["Command · Job 4 · Running"]);
  // Folded: the ended ones are not drawn one by one.
  expect(group(host)!.getAttribute("aria-expanded")).toBe("false");
  expect(listed(host)).toEqual([]);
  expect(textOf(host.querySelector('[data-slot="tool-run-line"]'))).toContain("List the build output");
  expect(calls).toHaveLength(0);
});

test("pressed, it lists them where it is, the latest to end first, each without the word Command; pressed again, it folds", async () => {
  holdFour();
  mockFetch(() => jsonResponse({ error: "not served" }, 500));
  const host = await render(reply([background(1), background(2), background(3), background(4), LS]), results(4));
  await settleUntil(() => group(host) !== null, "the folded line");
  await act(async () => { group(host)!.click(); });
  expect(group(host)!.getAttribute("aria-expanded")).toBe("true");
  expect(listed(host)).toEqual(["Job 2 · Exit 1", "Job 3 · Stopped", "Job 1 · Exit 0"]);
  // Each still opens its own steps, as its line did.
  const rows = [...host.querySelectorAll<HTMLElement>('[data-slot="ended-commands-list"] [data-slot="subagent-line"]')];
  expect(rows.map((row) => row.tagName)).toEqual(["BUTTON", "BUTTON", "BUTTON"]);
  expect(order(host).at(-1)).toBe("tool-run-line");
  await act(async () => { group(host)!.click(); });
  await settleUntil(() => listed(host).length === 0, "the fold shut");
  expect(group(host)!.getAttribute("aria-expanded")).toBe("false");
});

test("one ended command keeps its own line, as it reads today", async () => {
  // Between two still running: it keeps the place it started in.
  hold(command(1), done(2, "2026-10-18T09:00:10.000Z"), command(3));
  mockFetch(() => jsonResponse({ error: "not served" }, 500));
  const host = await render(reply([background(1), background(2), background(3), LS]), results(3));
  await settleUntil(() => singles(host).length === 3, "its lines");
  expect(group(host) === null).toBe(true);
  expect(singles(host)).toEqual(["Command · Job 1 · Running", "Command · Job 2 · Exit 0", "Command · Job 3 · Running"]);
  expect(order(host)).toEqual(["subagent-line", "subagent-line", "subagent-line", "tool-run-line"]);
});

test("a command that ends while the line is open joins it at the top; the list keeps the line open by the mark it holds", async () => {
  holdFour();
  mockFetch(() => jsonResponse({ error: "not served" }, 500));
  const marks: Array<[string, boolean]> = [];
  function Listed() {
    const [open, setOpen] = useState<Set<string>>(() => new Set());
    return (
      <AssistantMessage
        message={reply([background(1), background(2), background(3), background(4), LS])}
        toolResultsByCallId={results(4)}
        activeToolCallId={null}
        expandedToolIds={open}
        onToolExpandedChange={(id, next) => {
          marks.push([id, next]);
          setOpen((current) => {
            const copy = new Set(current);
            if (next) copy.add(id);
            else copy.delete(id);
            return copy;
          });
        }}
      />
    );
  }
  const { host } = await mountAsync(<Listed />, { path: "/threads/thr_m" });
  await settleUntil(() => group(host) !== null, "the folded line");
  await act(async () => { group(host)!.click(); });
  // Opened by the mark of the latest to end.
  expect(marks).toStrictEqual([[endedOpenKey("c2"), true]]);
  hold(
    done(1, "2026-10-18T09:00:10.000Z"),
    done(2, "2026-10-18T09:00:30.000Z", { status: "failed", exitCode: 1 }),
    done(3, "2026-10-18T09:00:20.000Z", { status: "stopped", stoppedBy: "user", exitCode: null }),
    done(4, "2026-10-18T09:00:40.000Z", { seq: 4 })
  );
  await settleUntil(() => listed(host).length === 4, "the fourth in the open line");
  expect(listed(host)).toEqual(["Job 4 · Exit 0", "Job 2 · Exit 1", "Job 3 · Stopped", "Job 1 · Exit 0"]);
  expect(textOf(host.querySelector('[data-slot="ended-commands-text"]'))).toBe("4 commands ended · 1 failed · 1 stopped");
  expect(singles(host)).toEqual([]);
  // Folding it takes the mark it held.
  marks.length = 0;
  await act(async () => { group(host)!.click(); });
  expect(marks).toStrictEqual([[endedOpenKey("c2"), false]]);
  await settleUntil(() => listed(host).length === 0, "the fold shut");
});

test("a command whose steps are open stays its own line though it ends; once they close, it joins the folded line", async () => {
  hold(done(1, "2026-10-18T09:00:10.000Z"), command(2), done(3, "2026-10-18T09:00:20.000Z"), command(4));
  mockFetch(() => jsonResponse({ error: "not served" }, 500));
  const host = await render(reply([background(1), background(2), background(3), background(4), LS]), results(4));
  await settleUntil(() => group(host) !== null, "the folded line");
  const lineOf = (title: string) => [...host.querySelectorAll<HTMLElement>('[data-slot="subagent-line"]')].find((el) => el.textContent?.includes(title)) ?? null;
  // Its steps opened from its own line while it runs.
  await act(async () => { lineOf("Job 2")!.click(); });
  await settleUntil(() => document.querySelector('[data-slot="task-steps-popover"]') !== null, "its steps");
  hold(done(1, "2026-10-18T09:00:10.000Z"), done(2, "2026-10-18T09:00:40.000Z", { seq: 4 }), done(3, "2026-10-18T09:00:20.000Z"), command(4));
  await settleUntil(() => singles(host).some((text) => text.includes("Job 2 · Exit 0")), "its line saying how it ended");
  // Ended, it stays where the reader opened it, its steps still open.
  expect(document.querySelector('[data-slot="task-steps-popover"]') !== null).toBe(true);
  expect(textOf(host.querySelector('[data-slot="ended-commands-text"]'))).toBe("2 commands ended");
  // Closed, it joins the fold.
  await act(async () => { lineOf("Job 2")!.click(); });
  await settleUntil(() => textOf(host.querySelector('[data-slot="ended-commands-text"]')) === "3 commands ended", "it folded in");
  expect(singles(host)).toEqual(["Command · Job 4 · Running"]);
});

test("the list holds which lines have their steps open, and a line gone while open lets go of its mark", async () => {
  hold(done(1, "2026-10-18T09:00:10.000Z"), command(2), done(3, "2026-10-18T09:00:20.000Z"));
  mockFetch(() => jsonResponse({ error: "not served" }, 500));
  const marks: Array<[string, boolean]> = [];
  function Listed({ shown }: { shown: boolean }) {
    const [open, setOpen] = useState<Set<string>>(() => new Set());
    return shown ? (
      <AssistantMessage
        message={reply([background(1), background(2), background(3), LS])}
        toolResultsByCallId={results(3)}
        activeToolCallId={null}
        expandedToolIds={open}
        onToolExpandedChange={(id, next) => {
          marks.push([id, next]);
          setOpen((current) => {
            const copy = new Set(current);
            if (next) copy.add(id);
            else copy.delete(id);
            return copy;
          });
        }}
      />
    ) : null;
  }
  const { host, rerender } = await mountAsync(<Listed shown />, { path: "/threads/thr_m" });
  await settleUntil(() => group(host) !== null, "the folded line");
  const lineOf = (title: string) => [...host.querySelectorAll<HTMLElement>('[data-slot="subagent-line"]')].find((el) => el.textContent?.includes(title)) ?? null;
  await act(async () => { lineOf("Job 2")!.click(); });
  await settleUntil(() => document.querySelector('[data-slot="task-steps-popover"]') !== null, "its steps");
  expect(marks).toStrictEqual([[peekOpenKey("c2"), true]]);
  // The row leaves the page with the steps open: the mark goes with it.
  rerender(<Listed shown={false} />);
  await settleUntil(() => marks.length === 2, "the mark let go");
  expect(marks).toStrictEqual([[peekOpenKey("c2"), true], [peekOpenKey("c2"), false]]);
});
