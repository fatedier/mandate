import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { WorkerView } from "@/routes/window/WorkerView";
import { useAgentChatStore } from "@/store/agent-chat";
import { useFeaturePlansStore } from "@/store/feature-plans";
import { emptyPlan, type FeaturePlanDto } from "@shared/api/plans";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mockFetch } from "../helpers/fetch.js";
import { mount, mountAsync, settle } from "../helpers/mount.js";
import { clientFeature, clientProject } from "../helpers/client-builders.js";

const at = "2026-09-27T00:00:00.000Z";
const feature = clientFeature("zoom");
const project = clientProject("p1", { features: [feature] });

// A worker has no New chat: it archived the conversation that
// holds the manager's task, and the manager was not told. The user talks to
// the worker in the same conversation. In a thread's panel the worker's menu
// ends the tab row on every tab.
describe("the worker's tabs", () => {
  afterEach(() => runCleanups());

  async function view(tab: "chat" | "plan", variant: "page" | "panel") {
    mockFetch(({ url }) => (
      url.includes("/canvases") ? Response.json({ canvases: [] }) : Response.json({ thread: null, messages: [], hasMore: false })
    ));
    const { host } = await mountAsync(
      <MemoryRouter>
        <WorkerView
          project={project}
          feature={feature}
          tab={tab}
          onTabChange={() => {}}
          variant={variant}
          actions={variant === "panel" ? <button type="button" aria-label="Worker actions" /> : undefined}
        />
      </MemoryRouter>
    );
    await settle();
    const tabRow = host.querySelector('[role="tablist"]')!.parentElement!;
    return { host, tabRow };
  }

  test("no tab offers a New chat, on the page or in a panel", async () => {
    for (const tab of ["chat", "plan"] as const) {
      for (const variant of ["page", "panel"] as const) {
        const { host } = await view(tab, variant);
        expect(host.querySelector('button[aria-label="New worker chat"]') === null).toBe(true);
        expect([...host.querySelectorAll("button")].some((b) => b.textContent?.includes("New chat"))).toBe(false);
        runCleanups();
      }
    }
  });

  test("in a thread's panel the worker's menu ends the tab row on every tab", async () => {
    for (const tab of ["chat", "plan"] as const) {
      const { tabRow } = await view(tab, "panel");
      const menu = tabRow.querySelector('button[aria-label="Worker actions"]');
      expect(menu).not.toBeNull();
      expect(tabRow.lastElementChild!.contains(menu)).toBe(true);
      runCleanups();
    }
  });

  // The menu beside the tabs says how full the worker's context is, and that
  // figure comes with its conversation: read when the view opens, not only on
  // the Chat tab, so the line is there before Chat was ever opened.
  test("the worker's conversation is read whichever tab its view opens on, and no more often on Chat", async () => {
    onCleanup(() => useAgentChatStore.setState({ threadsByScope: new Map() }));
    const reads: number[] = [];
    for (const [tab, variant] of [["plan", "panel"], ["plan", "page"], ["chat", "panel"]] as const) {
      useAgentChatStore.setState({ threadsByScope: new Map() });
      const asked: string[] = [];
      mockFetch(({ url }) => {
        asked.push(new URL(url, "http://x").pathname);
        if (url.includes("/canvases")) return Response.json({ canvases: [] });
        return Response.json({
          thread: { id: "t-zoom" }, messages: [], hasMore: false,
          contextUsage: { inputTokens: 102_000, budgetTokens: 250_000, updatedAt: at, source: "compression_budget" }
        });
      });
      await mountAsync(
        <MemoryRouter>
          <WorkerView project={project} feature={feature} tab={tab} onTabChange={() => {}} variant={variant} />
        </MemoryRouter>
      );
      await settle();
      reads.push(asked.filter((path) => path === "/api/agents/workers/zoom/thread").length);
      expect([tab, variant, useAgentChatStore.getState().threadsByScope.get("worker:zoom")?.contextUsage?.inputTokens]).toEqual([tab, variant, 102_000]);
      runCleanups();
    }
    // A read is its first page and the catch-up after it. The Chat tab asks for
    // the same conversation itself; the two requests are one read.
    expect(reads[0]).toBeGreaterThan(0);
    expect(reads).toStrictEqual([reads[0]!, reads[0]!, reads[0]!]);
  });

  // A worker's changes are its directory's against git. The tab used to ask
  // for a branch of the worker's own, so a worker made to work in the project's
  // directory had none, in a git project too.
  test("every worker of a git project has Changes, with or without a branch of its own; outside git none has", async () => {
    const CHANGES = { compare: "head", baseRef: "HEAD", mergeBase: "abc", head: "def", files: [{ path: "src/a.ts", oldPath: null, status: "M", additions: 3, deletions: 1, binary: false, uncommitted: true, untracked: false }], totalAdditions: 3, totalDeletions: 1 };
    const open = async (tab: "plan" | "changes", git: boolean, branch: string | null) => {
      useAgentChatStore.setState({ threadsByScope: new Map() });
      const asked: string[] = [];
      mockFetch(({ url }) => {
        asked.push(url);
        if (url.includes("/changes/file")) return Response.json({ path: "src/a.ts", patch: "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-old\n+new", truncated: false, binary: false });
        if (url.includes("/changes")) return Response.json(CHANGES);
        if (url.includes("/canvases")) return Response.json({ canvases: [] });
        return Response.json({ thread: null, messages: [], hasMore: false });
      });
      const { host } = await mountAsync(
        <MemoryRouter>
          <WorkerView project={{ ...project, isGit: git }} feature={{ ...feature, branch }} tab={tab} onTabChange={() => {}} variant="panel" />
        </MemoryRouter>
      );
      await settle();
      const seen = {
        tabs: [...host.querySelectorAll('[data-slot="worker-tabs"] [role="tab"]')].map((el) => (el.textContent ?? "").trim()),
        selected: host.querySelector('[data-slot="worker-tabs"] [role="tab"][aria-selected="true"]')?.textContent?.trim() ?? null,
        changesTab: host.querySelector('[data-slot="changes-tab"]') !== null,
        choice: host.querySelector('[role="group"][aria-label="Compare against"]') !== null,
        summary: host.querySelector('[data-slot="changes-summary"]')?.textContent ?? null,
        askedChanges: asked.some((url) => url.includes("/changes"))
      };
      runCleanups();
      return seen;
    };
    const WITH = ["Chat", "Plan", "Changes", "Canvases", "Terminal"];
    const WITHOUT = ["Chat", "Plan", "Canvases", "Terminal"];
    // In the project's own directory, no branch of its own: the tab, its list, no choice of comparison.
    expect(await open("changes", true, null)).toEqual({ tabs: WITH, selected: "Changes", changesTab: true, choice: false, summary: null, askedChanges: true });
    // A branch of its own: the same, with the choice.
    expect(await open("changes", true, "feat/x")).toEqual({ tabs: WITH, selected: "Changes", changesTab: true, choice: true, summary: null, askedChanges: true });
    // Its plan says how much is uncommitted, and leads there.
    expect(await open("plan", true, null)).toMatchObject({ tabs: WITH, selected: "Plan", summary: "+3 −1 · 1 file · uncommitted" });
    // Not a git project: no tab, an address that asks for it shows the plan, and nothing is asked of git.
    expect(await open("changes", false, null)).toEqual({ tabs: WITHOUT, selected: "Plan", changesTab: false, choice: false, summary: null, askedChanges: false });
    expect(await open("plan", false, null)).toMatchObject({ tabs: WITHOUT, summary: null, askedChanges: false });
  });
});

// The worker's state chip appears once wherever its Plan tab is shown. On the
// worker's page the header carries it (FeatureTitle), so the Plan section does
// not repeat it; in a thread's panel there is no such header, so the section's
// chip is the one place it shows.
describe("the Plan section's state chip", () => {
  beforeEach(() => {
    // What the view fetches for itself (plan, work item, canvases) answers
    // "nothing", so the seeded plan is what it shows.
    mockFetch(({ url }) => (
      url.includes("/canvases") ? Response.json({ canvases: [] }) : new Response("{}", { status: 404 })
    ));
  });

  afterEach(() => {
    // Unmount before the plans store the view reads is reset under it.
    runCleanups();
    useFeaturePlansStore.setState({ plans: new Map() });
  });

  const blocked: FeaturePlanDto = {
    ...emptyPlan("zoom"),
    conclusion: "Waiting on upstream",
    steps: [{ id: 1, title: "wait for project-2", status: "blocked", note: null, createdAt: at, startedAt: at, blockedAt: at, completedAt: null, updatedAt: at }],
    updatedAt: at
  };

  function renderPlan(variant: "page" | "panel") {
    act(() => useFeaturePlansStore.setState({ plans: new Map([["zoom", blocked]]) }));
    const { host } = mount(
      <MemoryRouter><WorkerView project={project} feature={feature} tab="plan" onTabChange={() => {}} variant={variant} /></MemoryRouter>
    );
    const section = host.querySelector('section[aria-label="Plan"]');
    if (section === null) throw new Error("expected the Plan section");
    // The plan is on screen, whichever variant: what follows is about the chip only.
    expect(section.querySelector('[data-slot="plan-conclusion"]')!.textContent).toBe("Waiting on upstream");
    return section;
  }

  test("on the worker's page the Plan section does not repeat the state the header shows", () => {
    const section = renderPlan("page");
    expect(section.querySelector('[data-slot="feature-state"]') === null).toBe(true);
  });

  test("in a thread's panel the Plan section shows the state, which has no header there", () => {
    const section = renderPlan("panel");
    expect(section.querySelector('[data-slot="feature-state"]')!.textContent).toBe("Blocked");
  });
});
