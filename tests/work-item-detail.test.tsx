import { expect, test, beforeEach } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useWorkItemsStore } from "../src/client/store/work-items.js";
import { WorkItemDetailBody } from "../src/client/routes/window/chat/work-items/WorkItemDetailBody.js";
import type { WorkItemDto } from "../src/shared/api/work-items.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeItem(over: Partial<WorkItemDto> = {}): WorkItemDto {
  return {
    id: "wi-1",
    title: "Test Title",
    summary: "Test body content",
    needsUser: "input",
    phase: "working",
    phaseDetail: null,
    canvasId: null,
    featureId: "feat-1",
    projectId: "proj-1",
    lastActivityAt: "2026-05-15T00:00:00Z",
    summaryUpdatedAt: null,
    summaryUpdatedBy: null,
    createdAt: "2026-05-15T00:00:00Z",
    updatedAt: "2026-05-15T00:00:00Z",
    ...over
  };
}

beforeEach(() => {
  useWorkItemsStore.setState({
    ...useWorkItemsStore.getInitialState(),
    items: new Map(),
    paginationByStatus: new Map()
  }, true);
});

// ── WorkItemDetailBody direct tests ──────────────────────────────────────────

test("WorkItemDetailBody renders needsUser badge", async () => {
  const item = makeItem({ needsUser: "input" });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <WorkItemDetailBody
          item={item}
          showHeader
        />
      );
    });
    const text = (container.textContent ?? "").toLowerCase();
    expect(text).toContain("input");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("WorkItemDetailBody renders phase chip", async () => {
  const item = makeItem({ phase: "verifying" });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <WorkItemDetailBody
          item={item}
          showHeader
        />
      );
    });
    expect(container.textContent).toContain("verifying");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("WorkItemDetailBody renders phaseDetail when set", async () => {
  const item = makeItem({ phaseDetail: "writing unit tests" });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <WorkItemDetailBody
          item={item}
          showHeader
        />
      );
    });
    expect(container.textContent).toContain("writing unit tests");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("WorkItemDetailBody omits phaseDetail when null", async () => {
  const item = makeItem({ phaseDetail: null });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <WorkItemDetailBody
          item={item}
          showHeader
        />
      );
    });
    // When phaseDetail is null the italic span is absent; check by scanning spans
    const spans = Array.from(container.getElementsByTagName("span"));
    const phaseDetailSpan = spans.find((s) => s.className.includes("italic"));
    expect(phaseDetailSpan).toBeUndefined();
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("WorkItemDetailBody renders body markdown", async () => {
  const item = makeItem({ summary: "This is the **body** content" });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <WorkItemDetailBody
          item={item}
        />
      );
    });
    expect(container.textContent).toContain("body");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
