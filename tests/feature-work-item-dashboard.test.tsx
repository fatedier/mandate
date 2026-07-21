import { expect, test, beforeEach, afterEach } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useWorkItemsStore } from "../src/client/store/work-items.js";
import { FeatureWorkItemDashboard } from "../src/client/routes/window/FeatureWorkItemDashboard.js";
import type { WorkItemDto } from "../src/shared/api/work-items.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeItem(overrides: Partial<WorkItemDto> = {}): WorkItemDto {
  return {
    id: "wi-1",
    featureId: "feat-1",
    projectId: "proj-1",
    title: "Login",
    summary: null,
    needsUser: null,
    phase: "design",
    phaseDetail: null,
    canvasId: null,
    lastActivityAt: "2026-05-18T00:00:00.000Z",
    summaryUpdatedAt: null,
    summaryUpdatedBy: null,
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z",
    ...overrides
  };
}

function resetStore(items: WorkItemDto[]) {
  useWorkItemsStore.setState({
    ...useWorkItemsStore.getInitialState(),
    items: new Map(items.map((i) => [i.id, i])),
    paginationByStatus: new Map()
  }, true);
}

async function renderComponent(featureId: string): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<FeatureWorkItemDashboard featureId={featureId} />);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  };
}

beforeEach(() => {
  resetStore([]);
});

afterEach(() => {
  resetStore([]);
});

test("renders 'no work item' placeholder when feature has no bound item", async () => {
  resetStore([]);
  const { container, unmount } = await renderComponent("feat-unknown");
  try {
    expect(container.textContent).toContain("no work item");
  } finally {
    await unmount();
  }
});

test("renders 'still discussing — no progress yet' for empty design-phase item", async () => {
  resetStore([makeItem({ phase: "design", summary: null, phaseDetail: null })]);
  const { container, unmount } = await renderComponent("feat-1");
  try {
    expect(container.textContent).toContain("still discussing");
  } finally {
    await unmount();
  }
});

test("renders detail body when item has content", async () => {
  // FeatureWorkItemDashboard delegates phase / phaseDetail / needsUser to
  // the page header now (WindowPage), so the body only renders summary.
  // Just check that the summary content shows up.
  resetStore([makeItem({ phase: "working", phaseDetail: "dispatching codex", summary: "## Plan" })]);
  const { container, unmount } = await renderComponent("feat-1");
  try {
    expect(container.textContent).toContain("Plan");
  } finally {
    await unmount();
  }
});
