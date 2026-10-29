import { afterEach, expect, jest, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { WindowPage } from "@/routes/window/WindowPage";
import { PaneHeaderSlotsProvider, PaneHeaderTitleSlot } from "@/shell/pane-header-slots";
import { TopBar } from "@/shell/TopBar";
import { fakePhoneWidth } from "../fake-phone-width";
import { useProjectsStore } from "@/store/projects";
import { useSnapshotStore } from "@/store/snapshot";
import { useAgentChatStore } from "@/store/agent-chat";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";
import { clientFeature, clientProject } from "../helpers/client-builders.js";
import { realClock } from "../helpers/fake-clock.js";

const at = "2026-09-27T00:00:00.000Z";
afterEach(() => {
  // Unmount before the stores the page reads are reset under it.
  runCleanups();
  act(() => {
    useProjectsStore.getState().setProjectsState([]);
    useSnapshotStore.setState({ snapshot: null });
    useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
  });
});

const w1 = clientFeature("w1", { tmuxAlive: false });
const project = clientProject("p1", { features: [w1] });

test("a worker whose tmux window is gone still has its chat; the Terminal tab offers the restore", async () => {
  mockFetch(({ url }) => {
    if (url.includes("/canvases")) return Response.json({ canvases: [] });
    return Response.json({ thread: null, messages: [], hasMore: false });
  });
  act(() => {
    useProjectsStore.getState().setProjectsState([project]);
    // The session is there; the worker's window is not.
    useSnapshotStore.setState({ snapshot: { sessions: [{ sessionName: "project-1", windows: [] }], counts: {} } });
  });
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={["/projects/project-1/features/w1?tab=chat"]}>
      <PaneHeaderSlotsProvider>
        <Routes><Route path="/projects/:projectSlug/features/:featureSlug" element={<WindowPage />} /></Routes>
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  await settle();
  expect(host.querySelector("textarea")?.getAttribute("placeholder")).toBe("Message the worker…");
  const terminal = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent?.startsWith("Terminal"))!;
  await act(async () => { terminal.click(); await new Promise((r) => setTimeout(r, 0)); });
  expect(host.textContent).toContain("tmux window is missing");
});

test("a worker link waits for the projects before calling the worker missing, then offers the way home", async () => {
  // A cold load used to say "Worker not found" until the projects arrived.
  act(() => {
    useProjectsStore.getState().setProjectsState([]);
    useProjectsStore.setState({ loaded: false });
  });
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={["/projects/project-1/features/w9"]}>
      <PaneHeaderSlotsProvider>
        <Routes><Route path="/projects/:projectSlug/features/:featureSlug" element={<WindowPage />} /></Routes>
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  expect(host.textContent).toContain("Loading…");
  expect(host.textContent).not.toContain("not found");
  act(() => useProjectsStore.getState().setProjectsState([project]));
  await settle();
  expect(host.querySelector('[data-slot="state-message"] h1')?.textContent).toBe("Worker not found");
  // As far below the bar as "Thread not found" is; it sat against it.
  expect(host.querySelector('[data-slot="state-message"]')!.parentElement!.className.split(" ")).toContain("pt-6");
  expect(host.textContent).toContain("It was archived, or the link is wrong.");
  const back = host.querySelector<HTMLAnchorElement>('[data-slot="state-message"] a')!;
  expect(back.textContent).toBe("Back to Home");
  expect(back.getAttribute("href")).toBe("/home");
});

test("a worker link whose projects never arrive says so after a while, and can retry", async () => {
  // The events stream reconnects when the projects can't be read; if they
  // never can, waiting quietly forever would look like a hang.
  act(() => {
    useProjectsStore.getState().setProjectsState([]);
    useProjectsStore.setState({ loaded: false });
  });
  jest.useFakeTimers();
  try {
    const { host } = await mountAsync(
      <MemoryRouter initialEntries={["/projects/project-1/features/w1"]}>
        <PaneHeaderSlotsProvider>
          <Routes><Route path="/projects/:projectSlug/features/:featureSlug" element={<WindowPage />} /></Routes>
        </PaneHeaderSlotsProvider>
      </MemoryRouter>
    );
    act(() => { jest.advanceTimersByTime(9_000); });
    expect(host.textContent).toContain("Loading…");
    act(() => { jest.advanceTimersByTime(1_000); });
    expect(host.querySelector('[data-slot="state-message"] h1')?.textContent).toBe("Couldn't load this worker");
    expect([...host.querySelectorAll('[data-slot="state-message"] button')].map((b) => b.textContent)).toEqual(["Retry"]);
    // Arriving late, the projects still win.
    act(() => useProjectsStore.getState().setProjectsState([project]));
    expect(host.querySelector('[data-slot="state-message"]') === null).toBe(true);
  } finally {
    realClock();
  }
});

// What a worker asks is its plan's question, with no flag on its work item.
test("a worker waiting for an answer shows its question on Chat even when its plan was never loaded", async () => {
  const { useWorkItemsStore } = await import("@/store/work-items");
  const { useFeaturePlansStore } = await import("@/store/feature-plans");
  const { emptyPlan } = await import("@shared/api/plans");
  mockFetch(({ url }) => {
    if (url.includes("/canvases")) return Response.json({ canvases: [] });
    if (url.includes("/plan")) return Response.json({ plan: { ...emptyPlan("w1"), openQuestions: ["Keep the old flag as an alias?"], updatedAt: at } });
    return Response.json({ thread: null, messages: [], hasMore: false });
  });
  act(() => {
    useFeaturePlansStore.setState({ plans: new Map() });
    useProjectsStore.getState().setProjectsState([project]);
    useSnapshotStore.setState({ snapshot: { sessions: [{ sessionName: "project-1", windows: [] }], counts: {} } });
    useWorkItemsStore.getState().upsert({
      id: "wi-w1", featureId: "w1", projectId: "p1", title: "w1",
      lastActivityAt: at, createdAt: at, updatedAt: at, failedAt: null, failedMessage: null, failedKind: null
    });
  });
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={["/projects/project-1/features/w1?tab=chat"]}>
      <PaneHeaderSlotsProvider>
        <Routes><Route path="/projects/:projectSlug/features/:featureSlug" element={<WindowPage />} /></Routes>
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  await settle();
  expect(host.textContent).toContain("Keep the old flag as an alias?");
  act(() => {
    useWorkItemsStore.setState({ items: new Map() });
    useFeaturePlansStore.setState({ plans: new Map() });
  });
});

test("a worker whose work item missed the startup list still shows its question on Chat", async () => {
  const { useWorkItemsStore } = await import("@/store/work-items");
  const { useFeaturePlansStore } = await import("@/store/feature-plans");
  const { emptyPlan } = await import("@shared/api/plans");
  const item = {
    id: "wi-w1", featureId: "w1", projectId: "p1", title: "w1", phase: "working", phaseDetail: null,
    canvasId: null, lastActivityAt: at, createdAt: at, updatedAt: at, failedAt: null, failedMessage: null, failedKind: null
  };
  mockFetch(({ url }) => {
    if (url.includes("/canvases")) return Response.json({ canvases: [] });
    if (url.includes("/plan")) return Response.json({ plan: { ...emptyPlan("w1"), openQuestions: ["Ship it behind a flag?"], updatedAt: at } });
    if (url.includes("/work-items")) return Response.json({ items: url.includes("featureId=w1") ? [item] : [], nextCursor: null });
    return Response.json({ thread: null, messages: [], hasMore: false });
  });
  act(() => {
    // Neither the item nor the plan is in hand.
    useWorkItemsStore.setState({ items: new Map() });
    useFeaturePlansStore.setState({ plans: new Map() });
    useProjectsStore.getState().setProjectsState([project]);
    useSnapshotStore.setState({ snapshot: { sessions: [{ sessionName: "project-1", windows: [] }], counts: {} } });
  });
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={["/projects/project-1/features/w1?tab=chat"]}>
      <PaneHeaderSlotsProvider>
        <Routes><Route path="/projects/:projectSlug/features/:featureSlug" element={<WindowPage />} /></Routes>
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  await settle();
  expect(host.textContent).toContain("Ship it behind a flag?");
  act(() => {
    useWorkItemsStore.setState({ items: new Map() });
    useFeaturePlansStore.setState({ plans: new Map() });
  });
});

// The page header carries the worker's state, so its Plan section does not
// repeat it. With the window gone the header has no window to
// title, and must still carry the state: otherwise it shows nowhere.
for (const phone of [false, true]) {
  test(`a worker whose tmux window is gone shows its state once on Plan (${phone ? "phone" : "desktop"})`, async () => {
    const { useFeaturePlansStore } = await import("@/store/feature-plans");
    const { emptyPlan } = await import("@shared/api/plans");
    const blocked = {
      ...emptyPlan("w1"), conclusion: "Waiting on upstream", updatedAt: at,
      steps: [{ id: 1, title: "wait for project-2", status: "blocked" as const, note: null, createdAt: at, startedAt: at, blockedAt: at, completedAt: null, updatedAt: at }]
    };
    mockFetch(({ url }) => {
      if (url.includes("/canvases")) return Response.json({ canvases: [] });
      if (url.includes("/plan")) return Response.json({ plan: blocked });
      return new Response("{}", { status: 404 });
    });
    act(() => {
      useFeaturePlansStore.setState({ plans: new Map([["w1", blocked]]) });
      useProjectsStore.getState().setProjectsState([project]);
      useSnapshotStore.setState({ snapshot: { sessions: [{ sessionName: "project-1", windows: [] }], counts: {} } });
    });
    const restore = phone ? fakePhoneWidth() : () => {};
    try {
      const { host } = await mountAsync(
        <MemoryRouter initialEntries={["/projects/project-1/features/w1?tab=plan"]}>
          <PaneHeaderSlotsProvider>
            {/* The shell's header, where the desktop title lands. */}
            <PaneHeaderTitleSlot />
            <Routes><Route path="/projects/:projectSlug/features/:featureSlug" element={<WindowPage />} /></Routes>
          </PaneHeaderSlotsProvider>
        </MemoryRouter>
      );
      await settle();
      // The Plan tab is open and the window is reported missing.
      expect(host.querySelector('[data-slot="plan-conclusion"]')!.textContent).toBe("Waiting on upstream");
      expect(host.textContent).toContain("window missing");
      const chips = [...host.querySelectorAll('[data-slot="feature-status"], [data-slot="feature-state"]')];
      expect(chips.map((c) => c.textContent)).toEqual(["Blocked"]);
    } finally {
      restore();
      act(() => useFeaturePlansStore.setState({ plans: new Map() }));
    }
  });
}

// A phone: the top bar carries the worker's name, state and menu,
// as the phone thread page and the desktop header do — not a breadcrumb over
// an in-page row that names the worker a second time.
for (const live of [true, false]) {
  test(`on a phone the top bar names the worker once, with its state and menu (${live ? "window open" : "window gone"})`, async () => {
    onCleanup(fakePhoneWidth());
    mockFetch(({ url }) => {
      if (url.includes("/canvases")) return Response.json({ canvases: [] });
      return Response.json({ thread: null, messages: [], hasMore: false });
    });
    const window = { windowName: "w1", panes: [] };
    act(() => {
      useProjectsStore.getState().setProjectsState([{ ...project, features: [{ ...w1, tmuxAlive: live }] }]);
      useSnapshotStore.setState({ snapshot: { sessions: [{ sessionName: "project-1", windows: live ? [window] : [] }], counts: {} } as never });
    });
    const { host } = await mountAsync(
      <MemoryRouter initialEntries={["/projects/project-1/features/w1?tab=chat"]}>
        <PaneHeaderSlotsProvider>
          <TopBar />
          <Routes><Route path="/projects/:projectSlug/features/:featureSlug" element={<WindowPage />} /></Routes>
        </PaneHeaderSlotsProvider>
      </MemoryRouter>
    );
    await settle();
    const bar = host.querySelector("header")!;
    expect(bar.querySelector('nav[aria-label="Breadcrumb"]') === null).toBe(true);
    expect(bar.querySelector('[aria-label="Worker actions"]') === null).toBe(false);
    expect(bar.querySelector('[data-slot="feature-status"]') === null).toBe(false);
    // Its name once on the page, in the bar.
    const named = [...host.querySelectorAll("h1, span")].filter((el) => el.textContent === "w1" && el.children.length === 0);
    expect(named.length).toBe(1);
    expect(bar.contains(named[0]!)).toBe(true);
    // One title either way: the name on its line, the state under it, where
    // a missing window says so rather than squeezing the name.
    expect(bar.querySelector('h1[data-slot="feature-title"]')!.textContent).toBe("w1");
    expect(bar.querySelector('[data-slot="worker-activity"]')!.textContent).toBe(live ? "worker idle" : "worker idle · window missing");
  });
}

// "Close" on the worker's page went to Projects: read as closing the menu or
// the worker, it did neither. The page's menu has none; the
// thread panel's, where Close closes the worker's tab, keeps it.
test("the worker page's menu has no Close", async () => {
  // The phone's top bar, where this harness renders the page's menu.
  onCleanup(fakePhoneWidth());
  mockFetch(({ url }) => {
    if (url.includes("/canvases")) return Response.json({ canvases: [] });
    return Response.json({ thread: null, messages: [], hasMore: false });
  });
  act(() => {
    useProjectsStore.getState().setProjectsState([{ ...project, features: [{ ...w1, tmuxAlive: true }] }]);
    useSnapshotStore.setState({ snapshot: { sessions: [{ sessionName: "project-1", windows: [{ windowName: "w1", panes: [] }] }], counts: {} } as never });
  });
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={["/projects/project-1/features/w1?tab=chat"]}>
      <PaneHeaderSlotsProvider>
        <TopBar />
        <Routes><Route path="/projects/:projectSlug/features/:featureSlug" element={<WindowPage />} /></Routes>
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  await settle();
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Worker actions"]')!;
  act(() => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
  await settle();
  const items = [...document.querySelectorAll('[role="menuitem"]')].map((n) => n.textContent?.trim());
  expect(items).toContain("Archive worker");
  expect(items).not.toContain("Close");
});

// A worker waiting on a watch: its page, on any tab, says what it
// watches under its name, by the name the transcript gave the pane. The page
// reads the worker's conversation for it, Chat open or not. Beside other
// waits it names the one its chat's line leads with.
test("on its Plan tab, a worker waiting on a watch says what it watches under its name, before an older command monitor", async () => {
  const at = "2026-10-08T12:50:00.000Z";
  const messages = [
    { id: "m1", threadId: "t-w1", seq: 1, role: "assistant", source: "self", sourceThreadId: null, wakeId: "wk", createdAt: at,
      content: { type: "assistant", text: "", toolCalls: [
        { toolCallId: "c1", toolName: "spawn_pane", args: { name: "Codex PR48" } },
        { toolCallId: "c2", toolName: "monitor", args: { pane: { paneId: "%103" }, note: "read the review" } }
      ] } },
    { id: "m2", threadId: "t-w1", seq: 2, role: "tool", source: "self", sourceThreadId: null, wakeId: "wk", createdAt: at,
      content: { type: "tool_result", toolCallId: "c1", toolName: "spawn_pane", result: { paneId: "%103" } } },
    { id: "m3", threadId: "t-w1", seq: 3, role: "tool", source: "self", sourceThreadId: null, wakeId: "wk", createdAt: at,
      content: { type: "tool_result", toolCallId: "c2", toolName: "monitor", result: { status: "registered", kind: "pane", monitorId: "ww_1" } } }
  ];
  const monitors = [
    { kind: "command", id: "mon_1", command: "gh pr checks 48", description: "project-1 CI", everyMs: 300_000, wakeWhen: "succeeds",
      timeoutAt: "2026-10-08T14:00:00.000Z", note: "", createdAt: "2026-10-08T12:40:00.000Z",
      runCount: 0, lastRunAt: null, nextRunAt: "2026-10-08T12:45:00.000Z", recentRuns: [] },
    { kind: "pane", id: "ww_1", windowKey: "project-1:w1", paneId: "%103", stableMs: 45_000, timeoutAt: "2026-10-08T13:21:00.000Z", note: "read the review",
      createdAt: at }
  ];
  mockFetch(({ url }) => {
    if (url.includes("/canvases")) return Response.json({ canvases: [] });
    if (url.includes("/thread")) return Response.json({ thread: { id: "t-w1" }, messages, hasMore: false, monitors, readAt: at });
    return new Response("{}", { status: 404 });
  });
  act(() => {
    useProjectsStore.getState().setProjectsState([project]);
    useSnapshotStore.setState({ snapshot: { sessions: [{ sessionName: "project-1", windows: [{ windowName: "w1", panes: [] }] }], counts: {} } as never });
  });
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={["/projects/project-1/features/w1?tab=plan"]}>
      <PaneHeaderSlotsProvider>
        <PaneHeaderTitleSlot />
        <Routes><Route path="/projects/:projectSlug/features/:featureSlug" element={<WindowPage />} /></Routes>
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  await settle(10);
  expect(host.querySelector('[data-slot="worker-activity"]')!.textContent).toBe("worker watching Codex PR48");
});
