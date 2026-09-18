import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssistantMessage } from "@/routes/window/chat/AssistantMessage";
import type { AgentMessage } from "@/store/agent-chat";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

function msg(text: string): AgentMessage {
  return {
    id: "a1", threadId: "t", seq: 1, role: "assistant", source: "user", sourceThreadId: null,
    wakeId: "w1", content: { type: "assistant", text }, createdAt: "2026-09-15T09:13:37.000Z"
  } as AgentMessage;
}

function render(message: AgentMessage) {
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<AssistantMessage message={message} toolResultsByCallId={new Map()} activeToolCallId={null} />);
  });
  return host!;
}

test("an empty reply renders nothing — no orphan timestamp row", () => {
  expect(render(msg("")).childElementCount).toBe(0);
});

test("a reply with text still renders", () => {
  expect(render(msg("Done.")).textContent).toContain("Done.");
});
