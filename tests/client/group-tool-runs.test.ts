import { expect, test } from "bun:test";
import { groupToolRuns } from "@/routes/window/chat/group-tool-runs";
import type { AgentMessage } from "@/store/agent-chat";

function step(id: string, opts: { text?: string; tools?: number; wakeId?: string | null; role?: "assistant" | "user"; createdAt?: string } = {}): AgentMessage {
  const role = opts.role ?? "assistant";
  return {
    id,
    threadId: "thr",
    seq: 1,
    role,
    source: "self",
    sourceThreadId: null,
    wakeId: opts.wakeId === undefined ? "wake-1" : opts.wakeId,
    content: role === "user"
      ? { type: "text", text: opts.text ?? "hi" }
      : {
          type: "assistant",
          text: opts.text ?? "",
          toolCalls: Array.from({ length: opts.tools ?? 1 }, (_, i) => ({ toolCallId: `${id}-${i}`, toolName: "bash", args: {} }))
        },
    createdAt: opts.createdAt ?? "2026-09-25T10:00:00.000"
  } as AgentMessage;
}

type Item = { kind: "msg"; message: AgentMessage; runTail?: AgentMessage[] } | { kind: "pending" };
const msg = (m: AgentMessage): Item => ({ kind: "msg", message: m });
const shape = (items: Item[]) =>
  items.map((item) => item.kind === "msg" ? [item.message.id, ...(item.runTail ?? []).map((t) => t.id)] : ["pending"]);

test("tool-only steps join the step before them", () => {
  const items = [msg(step("a", { text: "Looking" })), msg(step("b")), msg(step("c", { tools: 2 }))];
  expect(shape(groupToolRuns(items))).toEqual([["a", "b", "c"]]);
});

test("text, a user message, a pending send or another wake breaks the run", () => {
  const items = [
    msg(step("a")),
    msg(step("b", { text: "Now the edit" })),
    msg(step("c")),
    msg(step("u", { role: "user" })),
    msg(step("d")),
    { kind: "pending" } as Item,
    msg(step("e")),
    msg(step("f", { wakeId: "wake-2" }))
  ];
  expect(shape(groupToolRuns(items))).toEqual([["a"], ["b", "c"], ["u"], ["d"], ["pending"], ["e"], ["f"]]);
});

test("a step that said something and called nothing starts no run", () => {
  const items = [msg(step("a", { text: "Done.", tools: 0 })), msg(step("b"))];
  expect(shape(groupToolRuns(items))).toEqual([["a"], ["b"]]);
});

test("steps with no wake never join", () => {
  const items = [msg(step("a", { wakeId: null })), msg(step("b", { wakeId: null }))];
  expect(shape(groupToolRuns(items))).toEqual([["a"], ["b"]]);
});

test("a step past midnight starts a new run, under its own date", () => {
  const items = [
    msg(step("a", { createdAt: "2026-09-25T23:59:30.000" })),
    msg(step("b", { createdAt: "2026-09-25T23:59:50.000" })),
    msg(step("c", { createdAt: "2026-09-26T00:00:10.000" }))
  ];
  expect(shape(groupToolRuns(items))).toEqual([["a", "b"], ["c"]]);
});
