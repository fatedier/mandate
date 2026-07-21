import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { CanvasReferenceCard } from "../src/client/routes/window/chat/CanvasReferenceCard.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("CanvasReferenceCard opens canvas with the current page as modal background", async () => {
  let capturedState: unknown = null;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  function CanvasRouteProbe() {
    capturedState = useLocation().state;
    return <div>canvas route</div>;
  }

  try {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/projects/md/features/main"]}>
          <Routes>
            <Route
              path="/projects/:projectSlug/features/:featureSlug"
              element={<CanvasReferenceCard title="Plan" path="/canvas/cnv_1" />}
            />
            <Route path="/canvas/:canvasId" element={<CanvasRouteProbe />} />
          </Routes>
        </MemoryRouter>
      );
    });

    const button = container.getElementsByTagName("button")[0];
    await act(async () => {
      button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("canvas route");
    expect(capturedState).toMatchObject({
      backgroundLocation: {
        pathname: "/projects/md/features/main"
      }
    });
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});
