import { expect, test } from "bun:test";
import { ChatMessageList } from "../../src/client/routes/window/chat/ChatMessageList.js";
import { newThreadState, type AgentMessage, type ThreadState } from "../../src/client/store/agent-chat.js";
import { mountAsync, settle } from "../helpers/mount.js";

const at = "2026-09-20T10:00:00Z";
const row = (seq: number, m: Partial<AgentMessage> & Pick<AgentMessage, "role" | "content">): AgentMessage => ({
  id: `m${seq}`, threadId: "thr-old", seq, source: "user", sourceThreadId: null, wakeId: null, createdAt: at, ...m
} as AgentMessage);

test("an old transcript's retired tool call reads as its name, and the reply after it stands", async () => {
  const messages: AgentMessage[] = [
    // (a) a worker's task_complete call and its result, from before tasks were removed
    row(1, {
      role: "assistant", source: "self", wakeId: "w1",
      content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "c1", toolName: "task_complete", args: { taskId: "t1", summary: "done" } }] }
    }),
    row(2, {
      role: "tool", source: "self", wakeId: "w1",
      content: { type: "tool_result", toolCallId: "c1", toolName: "task_complete", result: { ok: true } }
    }),
    row(3, { role: "assistant", source: "self", wakeId: "w1", content: { type: "assistant", text: "Finished the task." } })
  ];
  const thread: ThreadState = { ...newThreadState(), threadId: "thr-old", messages, oldestSeqLoaded: 1 };
  const { host } = await mountAsync(<ChatMessageList thread={thread} onLoadOlder={async () => {}} onRetryFailed={() => {}} />);
  await settle();
  const text = host.textContent ?? "";
  // A retired tool reads as its name and arguments.
  expect(text).toContain("task_complete");
  expect(text).toContain("Finished the task.");
});
