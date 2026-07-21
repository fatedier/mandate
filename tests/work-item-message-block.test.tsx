import { expect, test, beforeEach, afterEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { WorkItemMessageBlock } from "../src/client/routes/window/chat/WorkItemMessageBlock.js";
import { useWorkItemsStore } from "../src/client/store/work-items.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function seedItem(over: Partial<{
  id: string;
  title: string;
  summary: string | null;
  needsUser: "review" | "input" | null;
}> = {}) {
  const item = {
    id: over.id ?? "wi-1",
    title: over.title ?? "Auth migration: A or B?",
    summary: over.summary ?? "snapshot body",
    needsUser: over.needsUser ?? "input",
    featureId: "feat-1",
    projectId: "proj-1",
    phase: "working" as const,
    phaseDetail: null,
    canvasId: null,
    lastActivityAt: "2026-05-15T00:00:00Z",
    summaryUpdatedAt: null,
    summaryUpdatedBy: null,
    createdAt: "2026-05-15T00:00:00Z",
    updatedAt: "2026-05-15T00:00:00Z",
  };
  useWorkItemsStore.getState().upsert(item as any);
  return item;
}

beforeEach(() => {
  useWorkItemsStore.setState({
    ...useWorkItemsStore.getInitialState(),
    items: new Map(),
    paginationByStatus: new Map()
  }, true);
});

afterEach(() => {
  useWorkItemsStore.setState({
    ...useWorkItemsStore.getInitialState(),
    items: new Map(),
    paginationByStatus: new Map()
  }, true);
});

test("renders work item title and body from store, button calls onOpen", () => {
  seedItem();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let opened: string | null = null;
  act(() => {
    root.render(
      <WorkItemMessageBlock
        itemId="wi-1"
        fallbackTitle="fallback title"
        fallbackBody="fallback body"
        onOpen={(id) => {
          opened = id;
        }}
      />
    );
  });
  // Live item from store takes precedence over fallback.
  expect(container.textContent).toContain("Auth migration");
  expect(container.textContent).toContain("snapshot body");
  expect(container.textContent).not.toContain("fallback title");

  const btn = container.getElementsByTagName("button")[0] ?? null;
  expect(btn).not.toBeNull();
  act(() => {
    btn!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  expect(opened).toBe("wi-1");

  act(() => {
    root.unmount();
  });
  container.remove();
});

test("renders fallback title when item is not in store yet", () => {
  // Don't seed — store is empty after beforeEach.
  // The component will trigger a fetchDetail which the test-setup network guard
  // will normally block. Override fetchDetail in the store to a no-op for this test.
  useWorkItemsStore.setState({ fetchDetail: async () => {} } as any);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <WorkItemMessageBlock
        itemId="wi-not-loaded"
        fallbackTitle="fallback title"
        fallbackBody="fallback body"
        onOpen={() => {}}
      />
    );
  });
  expect(container.textContent).toContain("fallback title");
  expect(container.textContent).toContain("fallback body");
  expect(container.textContent).toContain("loading live state");

  act(() => {
    root.unmount();
  });
  container.remove();
});

test("item with needsUser=review renders review badge", () => {
  seedItem({ id: "wi-2", needsUser: "review", title: "Review task" });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <WorkItemMessageBlock
        itemId="wi-2"
        fallbackTitle="ignored"
        onOpen={() => {}}
      />
    );
  });
  expect(container.textContent).toContain("Review task");
  // review badge dot should be present (aria-label contains "review")
  const spans = Array.from(container.getElementsByTagName("span"));
  const badge = spans.find((s) => (s.getAttribute("aria-label") ?? "").includes("review"));
  expect(badge).toBeDefined();

  act(() => {
    root.unmount();
  });
  container.remove();
});
