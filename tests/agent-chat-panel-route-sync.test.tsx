import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { AgentChatPanel } from "../src/client/routes/window/chat/AgentChatPanel.js";
import { newThreadState, useAgentChatStore } from "../src/client/store/agent-chat.js";
import { useProjectsStore, type Feature, type Project } from "../src/client/store/projects.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeFeature(overrides: Partial<Feature>): Feature {
  return {
    id: "feature-a",
    projectId: "project-1",
    name: "Feature A",
    mode: "shared-cwd",
    branch: null,
    baseRef: null,
    worktreePath: null,
    tmuxWindowName: "feature-a",
    ownership: "app",
    pinnedAt: null,
    createdAt: "2026-05-22T00:00:00Z",
    updatedAt: "2026-05-22T00:00:00Z",
    archivedAt: null,
    tmuxAlive: true,
    tmuxStatus: "alive",
    ...overrides
  };
}

function makeProject(): Project {
  return {
    id: "project-1",
    name: "Mandate",
    workingDir: "/tmp/mandate",
    isGit: true,
    gitRemote: null,
    tmuxSessionName: "md-mandate",
    ownership: "app",
    sortOrder: 0,
    createdAt: "2026-05-22T00:00:00Z",
    updatedAt: "2026-05-22T00:00:00Z",
    archivedAt: null,
    tmuxAlive: true,
    tmuxStatus: "alive",
    features: [
      makeFeature({ id: "feature-a", name: "Feature A", tmuxWindowName: "feature-a" }),
      makeFeature({ id: "feature-b", name: "Feature B", tmuxWindowName: "feature-b" })
    ]
  };
}

function resetChatStore() {
  useAgentChatStore.setState({
    drawerOpen: false,
    drawerScope: null,
    drawerMode: "side",
    threadsByScope: new Map(),
    sideThread: null,
    sideParentScope: null,
    sideActive: false,
    sideTransferNeedsRetargetId: null,
    pendingChatRef: null
  });
}

function resetStores() {
  resetChatStore();
  useProjectsStore.getState().setProjectsState([makeProject()]);
}

beforeEach(() => {
  resetStores();
});

// Also clean up on the way OUT, and leave the stores empty rather than
// re-armed: bun runs every test file in one process, so these zustand stores
// are module state shared with every other file, and whatever the last test
// here leaves set is what the next FILE inherits. The Side test below leaves
// `sideActive: true`, which makes AgentChatPanel render its Side branch — no
// scope tabs at all — in a file that never asked for it; the projects fixture
// leaks the same way. A beforeEach alone cannot see this, because the damage
// lands outside this file.
afterEach(() => {
  resetChatStore();
  useProjectsStore.setState({ projects: [], byId: {}, bySlug: {} });
});

async function renderPanelAt(path: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalFetch = globalThis.fetch;
  const originalGetComputedStyle = globalThis.getComputedStyle;
  (globalThis as { fetch: typeof fetch }).fetch = async () => new Response(JSON.stringify({
    thread: null,
    messages: [],
    hasMore: false,
    contextUsage: null
  }), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.getComputedStyle = (() => ({
    lineHeight: "20px"
  })) as typeof globalThis.getComputedStyle;

  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <AgentChatPanel />
      </MemoryRouter>
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  return {
    container,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      globalThis.fetch = originalFetch;
      globalThis.getComputedStyle = originalGetComputedStyle;
      container.remove();
    }
  };
}

test("AgentChatPanel switches an open feature drawer to the current route feature", async () => {
  useAgentChatStore.getState().openDrawer({ type: "worker", featureId: "feature-a" });

  const { cleanup } = await renderPanelAt("/projects/md-mandate/features/feature-b");
  try {
    expect(useAgentChatStore.getState().drawerScope).toEqual({ type: "worker", featureId: "feature-b" });
  } finally {
    await cleanup();
  }
});

test("AgentChatPanel renders feature chat without legacy secondary tabs", async () => {
  useAgentChatStore.getState().openDrawer({ type: "worker", featureId: "feature-a" });

  const { container, cleanup } = await renderPanelAt("/projects/md-mandate/features/feature-a");
  try {
    expect(container.textContent).toContain("Feature A");
    expect(container.textContent).not.toContain("Main");
  } finally {
    await cleanup();
  }
});

test("AgentChatPanel keeps manager drawer scope on feature routes", async () => {
  useAgentChatStore.getState().openDrawer({ type: "manager" });

  const { cleanup } = await renderPanelAt("/projects/md-mandate/features/feature-b");
  try {
    expect(useAgentChatStore.getState().drawerScope).toEqual({ type: "manager" });
  } finally {
    await cleanup();
  }
});

test("AgentChatPanel renders independent Side controls while keeping its parent scope", async () => {
  useAgentChatStore.setState({
    drawerOpen: true,
    drawerScope: { type: "manager" },
    threadsByScope: new Map().set("manager", {
      ...newThreadState(),
      threadId: "main-thread"
    }),
    sideThread: {
      ...newThreadState(),
      threadId: "side-thread"
    },
    sideParentScope: { type: "manager" },
    sideActive: true
  });

  const { container, cleanup } = await renderPanelAt("/");
  try {
    expect(container.textContent).toContain("Side");
    expect(container.querySelector('[aria-label="Return to main conversation"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Send summary to main conversation"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Close side conversation"]')).toBeTruthy();
  } finally {
    await cleanup();
  }
});
