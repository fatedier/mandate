import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { AssistantMessage } from "../src/client/routes/window/chat/AssistantMessage.js";
import type { AgentMessage } from "../src/client/store/agent-chat.js";
import type { ToolResultSpec } from "../src/client/routes/window/chat/ToolCallCard.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("AssistantMessage renders canvas references from canvas_publish tool results", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const message: AgentMessage = {
    id: "msg-1",
    threadId: "thread-1",
    seq: 1,
    role: "assistant",
    source: "manager",
    sourceThreadId: null,
    wakeId: "wake-1",
    content: {
      type: "assistant",
      text: "I made a canvas.",
      toolCalls: [
        {
          toolCallId: "call-1",
          toolName: "canvas_publish",
          args: { canvasId: "canvas-1" }
        }
      ]
    },
    createdAt: new Date().toISOString()
  };
  const toolResultsByCallId = new Map<string, ToolResultSpec>([
    [
      "call-1",
      {
        result: {
          ok: true,
          canvasId: "canvas-1",
          title: "Implementation plan",
          path: "/canvas/canvas-1"
        }
      }
    ]
  ]);

  try {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AssistantMessage
            message={message}
            toolResultsByCallId={toolResultsByCallId}
            activeToolCallId={null}
          />
        </MemoryRouter>
      );
    });

    expect(container.textContent).toContain("Canvas");
    expect(container.textContent).toContain("Implementation plan");
    const labels = [...container.getElementsByTagName("button")].map((button) =>
      button.getAttribute("aria-label")
    );
    expect(labels).toContain("Open canvas: Implementation plan");
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

test("AssistantMessage does not render canvas references from canvas_create or canvas_update", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const now = new Date().toISOString();
  const message: AgentMessage = {
    id: "msg-2",
    threadId: "thread-1",
    seq: 2,
    role: "assistant",
    source: "manager",
    sourceThreadId: null,
    wakeId: "wake-1",
    content: {
      type: "assistant",
      text: "I prepared a canvas.",
      toolCalls: [
        {
          toolCallId: "call-create",
          toolName: "canvas_create",
          args: { title: "Draft canvas" }
        },
        {
          toolCallId: "call-update",
          toolName: "canvas_update",
          args: { canvasId: "canvas-1", title: "Draft canvas renamed" }
        }
      ]
    },
    createdAt: now
  };
  const toolResultsByCallId = new Map<string, ToolResultSpec>([
    [
      "call-create",
      {
        result: {
          ok: true,
          canvasId: "canvas-1",
          title: "Draft canvas",
          path: "/canvas/canvas-1"
        }
      }
    ],
    [
      "call-update",
      {
        result: {
          ok: true,
          canvasId: "canvas-1",
          title: "Draft canvas renamed",
          path: "/canvas/canvas-1"
        }
      }
    ]
  ]);

  try {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AssistantMessage
            message={message}
            toolResultsByCallId={toolResultsByCallId}
            activeToolCallId={null}
          />
        </MemoryRouter>
      );
    });

    expect(container.textContent).not.toContain("Canvas");
    const labels = [...container.getElementsByTagName("button")].map((button) =>
      button.getAttribute("aria-label")
    );
    expect(labels).not.toContain("Open canvas: Draft canvas");
    expect(labels).not.toContain("Open canvas: Draft canvas renamed");
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});
