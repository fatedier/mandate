import { expect, test } from "bun:test";
import { AssistantMessage } from "@/routes/window/chat/AssistantMessage";
import type { AgentMessage } from "@/store/agent-chat";
import { mount } from "../helpers/mount.js";

function msg(text: string): AgentMessage {
  return {
    id: "a1", threadId: "t", seq: 1, role: "assistant", source: "user", sourceThreadId: null,
    wakeId: "w1", content: { type: "assistant", text }, createdAt: "2026-09-15T09:13:37.000Z"
  } as AgentMessage;
}

function render(message: AgentMessage) {
  return mount(<AssistantMessage message={message} toolResultsByCallId={new Map()} activeToolCallId={null} />).host;
}

test("an empty reply renders nothing — no orphan timestamp row", () => {
  expect(render(msg("")).childElementCount).toBe(0);
});
