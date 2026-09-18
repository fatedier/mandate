import { expect, test, beforeEach, afterEach } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useWorkItemsStore } from "../src/client/store/work-items.js";
import { FeatureWorkItemDashboard } from "../src/client/routes/window/FeatureWorkItemDashboard.js";
import type { WorkItemDto } from "../src/shared/api/work-items.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeItem(overrides: Partial<WorkItemDto> = {}): WorkItemDto {
  return {
    id: "wi-1", featureId: "feat-1", projectId: "proj-1", title: "Login",
    summary: "Conclusion.", needsUser: null, phase: "working", phaseDetail: null,
    canvasId: null, summaryUpdatedAt: null, summaryUpdatedBy: null,
    lastActivityAt: "2026-08-03T00:00:00.000Z",
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    ...overrides
  };
}

function resetStore(items: WorkItemDto[] = []) {
  useWorkItemsStore.setState({
    ...useWorkItemsStore.getInitialState(),
    items: new Map(items.map((i) => [i.id, i])),
    paginationByStatus: new Map()
  }, true);
}

async function render(featureId: string) {
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

const originalFetch = globalThis.fetch;
let requested: string[] = [];

/** Answer as the real route does: a list envelope holding at most the one
 *  item bound to the requested feature. */
function serveWorkItems(byFeature: Map<string, WorkItemDto>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requested.push(url);
    const featureId = new URL(url, "http://localhost").searchParams.get("featureId") ?? "";
    const item = byFeature.get(featureId);
    return new Response(JSON.stringify({ items: item ? [item] : [], nextCursor: null }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => { resetStore(); requested = []; });
afterEach(() => { globalThis.fetch = originalFetch; resetStore(); });

test("a pane whose item is not in the store asks for it by featureId", async () => {
  const item = makeItem({ featureId: "feat-late", summary: "Fetched on demand." });
  serveWorkItems(new Map([["feat-late", item]]));

  const { container, unmount } = await render("feat-late");
  try {
    expect(requested.length).toBe(1);
    expect(requested[0]).toContain("featureId=feat-late");
    expect(container.textContent).toContain("Fetched on demand.");
  } finally {
    await unmount();
  }
});

test("the pane does not flash 'no work item' before the lookup answers", async () => {
  let release: (() => void) | null = null;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const item = makeItem({ featureId: "feat-slow", summary: "Arrived late." });
  globalThis.fetch = (async () => {
    await pending;
    return new Response(JSON.stringify({ items: [item], nextCursor: null }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;

  const { container, unmount } = await render("feat-slow");
  try {
    expect(container.textContent).not.toContain("no work item");
    await act(async () => { release!(); await pending; });
    expect(container.textContent).toContain("Arrived late.");
  } finally {
    await unmount();
  }
});

test("once the lookup comes back empty, the pane says there is no work item", async () => {
  serveWorkItems(new Map());
  const { container, unmount } = await render("feat-none");
  try {
    expect(container.textContent).toContain("no work item for this feature");
  } finally {
    await unmount();
  }
});

test("an item already in the store is used without a request", async () => {
  resetStore([makeItem({ featureId: "feat-1", summary: "Already here." })]);
  serveWorkItems(new Map());

  const { container, unmount } = await render("feat-1");
  try {
    expect(requested.length).toBe(0);
    expect(container.textContent).toContain("Already here.");
  } finally {
    await unmount();
  }
});

test("another feature's item in the store does not satisfy this pane", async () => {
  resetStore([makeItem({ id: "wi-other", featureId: "feat-other", summary: "Not mine." })]);
  const mine = makeItem({ id: "wi-mine", featureId: "feat-mine", summary: "Mine." });
  serveWorkItems(new Map([["feat-mine", mine]]));

  const { container, unmount } = await render("feat-mine");
  try {
    expect(requested[0]).toContain("featureId=feat-mine");
    expect(container.textContent).toContain("Mine.");
    expect(container.textContent).not.toContain("Not mine.");
    // Both are now held, keyed by id — the fetch added, it did not replace.
    expect(useWorkItemsStore.getState().items.size).toBe(2);
  } finally {
    await unmount();
  }
});

test("an item arriving over SSE after the empty lookup replaces the placeholder", async () => {
  serveWorkItems(new Map());
  const { container, unmount } = await render("feat-later");
  try {
    expect(container.textContent).toContain("no work item for this feature");

    await act(async () => {
      // What the workItemCreated listener does with the server's payload.
      useWorkItemsStore.getState().upsert(
        makeItem({ id: "wi-created", featureId: "feat-later", summary: "Created just now." })
      );
    });

    expect(container.textContent).toContain("Created just now.");
    expect(container.textContent).not.toContain("no work item");
  } finally {
    await unmount();
  }
});

test("switching to another feature looks that one up and does not carry the old answer over", async () => {
  const mine = makeItem({ id: "wi-second", featureId: "feat-second", summary: "Second feature." });
  serveWorkItems(new Map([["feat-second", mine]]));

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<FeatureWorkItemDashboard featureId="feat-first" />); });
    expect(container.textContent).toContain("no work item for this feature");

    await act(async () => { root.render(<FeatureWorkItemDashboard featureId="feat-second" />); });

    expect(requested).toEqual([
      expect.stringContaining("featureId=feat-first"),
      expect.stringContaining("featureId=feat-second")
    ]);
    expect(container.textContent).toContain("Second feature.");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a failed lookup does not reject into the console or wedge the pane", async () => {
  globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  const { container, unmount } = await render("feat-offline");
  try {
    expect(container.textContent).toContain("no work item for this feature");
  } finally {
    await unmount();
  }
});
