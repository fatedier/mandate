import { afterEach, expect, test } from "bun:test";
import { ChatMessageList } from "../../src/client/routes/window/chat/ChatMessageList.js";
import { newThreadState, useAgentChatStore, type AgentMessage, type ThreadState } from "../../src/client/store/agent-chat.js";
import { runCleanups } from "../helpers/cleanup.js";
import { mountAsync, settle } from "../helpers/mount.js";

// Quick commands: the run's line named a call only while it ran, a frame
// for a quick one, so a turn read "Ran N commands" and "Working…" and
// nothing of what it did; and the working line left for each call and came
// back, moving the whole chat by its height twice a call. While the running
// turn is on a run, its line now names the latest call, and the working line
// stays: one clock, the turn's, and a height that holds.

afterEach(() => {
  runCleanups();
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
});

const at = (second: number) => `2026-10-17T09:00:${String(second).padStart(2, "0")}.000Z`;
const base = { threadId: "t1", sourceThreadId: null } as const;
const user = (seq: number, text: string): AgentMessage =>
  ({ ...base, id: `u${seq}`, seq, role: "user", source: "user", wakeId: null, createdAt: at(seq), content: { type: "text", text } } as AgentMessage);
const step = (seq: number, wakeId: string, text: string, call?: { id: string; description: string }): AgentMessage => ({
  ...base, id: `a${seq}`, seq, role: "assistant", source: "self", wakeId, createdAt: at(seq),
  content: { type: "assistant", text, toolCalls: call ? [{ toolCallId: call.id, toolName: "bash", args: { command: "true", description: call.description } }] : [] }
} as AgentMessage);
const result = (seq: number, wakeId: string, callId: string): AgentMessage => ({
  ...base, id: `t${seq}`, seq, role: "tool", source: "self", wakeId, createdAt: at(seq),
  content: { type: "tool_result", toolCallId: callId, toolName: "bash", result: { exitCode: 0, stdout: "ok" } }
} as AgentMessage);

/** Three quick commands of wake w1; the third has no result yet when `running`. */
function turn(running: boolean): AgentMessage[] {
  return [
    user(1, "Clean up the docker leftovers"),
    step(2, "w1", "", { id: "c1", description: "List e2e containers" }),
    result(3, "w1", "c1"),
    step(4, "w1", "", { id: "c2", description: "Find the e2e image" }),
    result(5, "w1", "c2"),
    step(6, "w1", "", { id: "c3", description: "Remove stopped containers" }),
    ...(running ? [] : [result(7, "w1", "c3")])
  ];
}

const thinking = (messages: AgentMessage[], over: Partial<ThreadState> = {}): ThreadState => ({
  ...newThreadState(), threadId: "t1", loaded: true, messages, oldestSeqLoaded: 1,
  wakePhase: { wakeId: "w1", phase: "thinking", startedAt: at(1) }, ...over
});

async function draw(state: ThreadState) {
  const { host } = await mountAsync(<ChatMessageList thread={state} onLoadOlder={async () => {}} onRetryFailed={() => {}} />);
  await settle();
  return host;
}
const lines = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[data-slot="tool-run-line"]')];
const has = (host: Element, selector: string) => host.querySelector(selector) !== null;

test("while a call runs, the run's line names it with a spinner and the working line stays, the only clock", async () => {
  const host = await draw(thinking(turn(true)));
  const [line] = lines(host);
  expect(line!.textContent).toContain("RunningRemove stopped containers");
  expect(line!.textContent).toContain("· 3 calls");
  expect(has(line!, '[data-slot="call-status"][data-status="running"]')).toBe(true);
  // One clock: the turn's, on the working line, which no longer steps aside.
  expect(has(line!, '[data-slot="tool-run-duration"]')).toBe(false);
  expect(has(host, '[data-slot="working-indicator"]')).toBe(true);
  expect(host.querySelector('[data-slot="working-clock"]')!.textContent).toMatch(/^\d/);
});

test("once the latest call is done, the line keeps naming it, with its kind's mark, until the next call", async () => {
  // A step's stream with no text yet is not the reply.
  const host = await draw(thinking(turn(false), { streamingAssistant: { wakeId: "w1", totalText: "" } }));
  const [line] = lines(host);
  expect(line!.textContent).toContain("RanRemove stopped containers");
  expect(line!.textContent).toContain("· 3 calls");
  expect(line!.textContent).not.toContain("Ran 3 commands");
  expect(has(line!, '[data-slot="call-status"][data-status="ok"][data-kind="terminal"]')).toBe(true);
  expect(has(host, '[data-slot="working-indicator"]')).toBe(true);
});

// A step that wrote nothing (empty, or reasoning only) while the turn goes
// on is drawn as nothing: it is not where the turn is.
test("a step the turn drew nothing for leaves the line on the run", async () => {
  const host = await draw(thinking([...turn(false), step(8, "w1", "")]));
  const [line] = lines(host);
  expect(line!.textContent).toContain("RanRemove stopped containers");
  expect(line!.textContent).toContain("· 3 calls");
});

test("a run the turn has moved past reads as its tally: the turn's reply streaming, the turn over, or text after it", async () => {
  // The reply streams: the run is done.
  const streaming = await draw(thinking(turn(false), { streamingAssistant: { wakeId: "w1", totalText: "Removed them." } as ThreadState["streamingAssistant"] }));
  expect(lines(streaming)[0]!.textContent).toContain("Ran 3 commands");
  // The turn is over.
  const over = await draw(thinking(turn(false), { wakePhase: { wakeId: null, phase: "idle" } as ThreadState["wakePhase"] }));
  expect(lines(over)[0]!.textContent).toContain("Ran 3 commands");
  // Its reply is stored, the turn not yet over.
  const replied = await draw(thinking([...turn(false), step(8, "w1", "Removed them.")]));
  expect(lines(replied)[0]!.textContent).toContain("Ran 3 commands");
  // The turn wrote, then ran more: the first run is done, the second is live.
  const more = await draw(thinking([
    ...turn(false),
    step(8, "w1", "Two left.", { id: "c4", description: "Remove the e2e image" }),
    result(9, "w1", "c4"),
    step(10, "w1", "", { id: "c5", description: "Confirm nothing is left" }),
    result(11, "w1", "c5")
  ]));
  const [first, second] = lines(more);
  expect(first!.textContent).toContain("Ran 3 commands");
  expect(second!.textContent).toContain("RanConfirm nothing is left");
  expect(second!.textContent).toContain("· 2 calls");
});

test("a run of another, finished turn reads as its tally while this turn runs", async () => {
  const earlier = turn(false).map((m) => (m.wakeId ? { ...m, wakeId: "w0" } : m));
  const host = await draw(thinking([...earlier, user(20, "And the volumes?")], { wakePhase: { wakeId: "w1", phase: "thinking", startedAt: at(20) } }));
  expect(lines(host)[0]!.textContent).toContain("Ran 3 commands");
});
