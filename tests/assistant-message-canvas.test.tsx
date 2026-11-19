import { expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { AssistantMessage } from "../src/client/routes/window/chat/AssistantMessage.js";
import { CanvasReferenceLink } from "../src/client/routes/window/chat/CanvasReferenceLink.js";
import type { AgentMessage } from "../src/client/store/agent-chat.js";
import type { ToolResultSpec } from "../src/client/routes/window/chat/tool-run-summary.js";
import { mountAsync } from "./helpers/mount.js";

test("AssistantMessage renders canvas references from canvas_publish tool results", async () => {
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

  const { host: container } = await mountAsync(
    <MemoryRouter>
      <AssistantMessage
        message={message}
        toolResultsByCallId={toolResultsByCallId}
        activeToolCallId={null}
      />
    </MemoryRouter>
  );

  const labels = [...container.getElementsByTagName("button")].map((button) =>
    button.getAttribute("aria-label")
  );
  expect(labels).toContain("Open canvas: Implementation plan");
  // One line: the title that opens it, no card around it.
  const link = container.querySelector<HTMLElement>('[data-slot="published-canvas"]')!;
  expect(link.getAttribute("aria-label")).toBe("Open canvas: Implementation plan");
  expect(link.textContent).toBe("Implementation plan");
  expect(container.textContent).not.toContain("Canvas");
});

test("AssistantMessage does not render canvas references from canvas_create or canvas_update", async () => {
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

  const { host: container } = await mountAsync(
    <MemoryRouter>
      <AssistantMessage
        message={message}
        toolResultsByCallId={toolResultsByCallId}
        activeToolCallId={null}
      />
    </MemoryRouter>
  );

  expect(container.textContent).not.toContain("Canvas");
  const labels = [...container.getElementsByTagName("button")].map((button) =>
    button.getAttribute("aria-label")
  );
  expect(labels).not.toContain("Open canvas: Draft canvas");
  expect(labels).not.toContain("Open canvas: Draft canvas renamed");
});

test("CanvasReferenceLink opens canvas with the current page as modal background", async () => {
  let capturedState: unknown = null;

  function CanvasRouteProbe() {
    capturedState = useLocation().state;
    return <div>canvas route</div>;
  }

  const { host: container } = await mountAsync(
    <MemoryRouter initialEntries={["/projects/md/workers/main"]}>
      <Routes>
        <Route
          path="/projects/:projectSlug/workers/:workerSlug"
          element={<CanvasReferenceLink title="Plan" path="/canvas/cnv_1" />}
        />
        <Route path="/canvas/:canvasId" element={<CanvasRouteProbe />} />
      </Routes>
    </MemoryRouter>
  );

  const button = container.getElementsByTagName("button")[0];
  await act(async () => {
    button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });

  expect(container.textContent).toContain("canvas route");
  expect(capturedState).toMatchObject({
    backgroundLocation: {
      pathname: "/projects/md/workers/main"
    }
  });
});

test("AssistantMessage renders a canvas reference from the canvas tool's publish, not from its create", async () => {
  const message: AgentMessage = {
    id: "msg-3",
    threadId: "thread-1",
    seq: 3,
    role: "assistant",
    source: "manager",
    sourceThreadId: null,
    wakeId: "wake-1",
    content: {
      type: "assistant",
      text: "I made two canvases.",
      toolCalls: [
        { toolCallId: "call-create", toolName: "canvas", args: { action: "create", title: "Draft canvas" } },
        { toolCallId: "call-publish", toolName: "canvas", args: { action: "publish", canvasId: "canvas-2" } }
      ]
    },
    createdAt: new Date().toISOString()
  };
  const toolResultsByCallId = new Map<string, ToolResultSpec>([
    ["call-create", { result: { ok: true, canvasId: "canvas-1", title: "Draft canvas", path: "/canvas/canvas-1" } }],
    ["call-publish", { result: { ok: true, canvasId: "canvas-2", title: "Implementation plan", path: "/canvas/canvas-2" } }]
  ]);

  const { host: container } = await mountAsync(
    <MemoryRouter>
      <AssistantMessage message={message} toolResultsByCallId={toolResultsByCallId} activeToolCallId={null} />
    </MemoryRouter>
  );

  const labels = [...container.getElementsByTagName("button")].map((button) => button.getAttribute("aria-label"));
  expect(labels).toContain("Open canvas: Implementation plan");
  expect(labels).not.toContain("Open canvas: Draft canvas");
});
