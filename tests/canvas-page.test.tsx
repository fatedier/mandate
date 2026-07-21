import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { CanvasPage } from "../src/client/routes/canvas/CanvasPage.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("CanvasPage links feature-scoped canvases back to their feature", async () => {
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(JSON.stringify({
    canvas: {
      id: "cnv_1",
      title: "Feature report",
      kind: "html",
      html: "<p>ok</p>",
      scope: "worker",
      scopeId: "feat_1",
      projectId: "proj_1",
      projectName: "Mandate",
      projectSlug: "md-mandate",
      featureId: "feat_1",
      featureName: "Canvas browser",
      featureSlug: "canvas_browser",
      threadId: "thread_1",
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    }
  }), { status: 200, headers: { "content-type": "application/json" } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/canvas/cnv_1"]}>
          <Routes>
            <Route path="/canvas/:canvasId" element={<CanvasPage />} />
          </Routes>
        </MemoryRouter>
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("Feature report");
    expect(container.textContent).toContain("Mandate / Canvas browser");
    const link = [...container.getElementsByTagName("a")]
      .find((item) => item.getAttribute("aria-label") === "Open feature: Canvas browser");
    expect(link?.getAttribute("href")).toBe("/projects/md-mandate/features/canvas_browser");
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    (globalThis as any).fetch = realFetch;
  }
});

