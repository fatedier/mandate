import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { FeatureEventLine } from "../src/client/routes/window/chat/FeatureEventLine.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("FeatureEventLine renders canvas artifacts", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <FeatureEventLine
            content={{
              type: "feature_event",
              kind: "escalation",
              taskId: "task-1",
              featureId: "feat-1",
              workItemId: null,
              label: "Research",
              summary: "Done",
              signal: "blocked",
              artifacts: [{
                type: "canvas",
                canvasId: "cnv-1",
                title: "Research report",
                path: "/canvas/cnv-1",
                role: "report"
              }]
            }}
          />
        </MemoryRouter>
      );
    });

    expect(container.textContent).toContain("Research");
    expect(container.textContent).toContain("Canvas");
    expect(container.textContent).toContain("Research report");
    const labels = [...container.getElementsByTagName("button")].map((button) =>
      button.getAttribute("aria-label")
    );
    expect(labels).toContain("Open canvas: Research report");
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

test("FeatureEventLine renders source snapshot for completion events", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <FeatureEventLine
            content={{
              type: "feature_event",
              kind: "completion",
              taskId: "task-1",
              featureId: "feat-1",
              workItemId: "wi-1",
              source: {
                project: { id: "proj-1", name: "Mandate" },
                feature: { id: "feat-1", name: "Event source display" },
                workItem: { id: "wi-1", title: "Implement source labels" },
                capturedAt: "2026-05-28T00:00:00Z"
              },
              label: "Implement source labels",
              summary: "Done"
            }}
          />
        </MemoryRouter>
      );
    });

    expect(container.textContent).toContain("Mandate / Event source display");
    expect(container.textContent).toContain("Implement source labels");
    expect(container.textContent).toContain("completed");
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});
