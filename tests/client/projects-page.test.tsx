import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { ProjectsPage } from "@/routes/projects/ProjectsPage";
import { PaneHeaderActionsSlot, PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useProjectsStore, type Project } from "@/store/projects";
import { useTaskBoardStore } from "@/store/task-board";
import type { ManagerThreadDto } from "@shared/api/agents";
import type { TaskDto } from "@shared/api/task-board";
import { runCleanups } from "../helpers/cleanup.js";
import { clientProject, clientWorker, managerThreadDto, taskDto } from "../helpers/client-builders.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mountAsync, settleUntil } from "../helpers/mount.js";
import { resetTaskBoardStore } from "../helpers/task-board.js";

// The Projects page: one row per project, its name and folder, how many
// workers it has, its open tasks and when its threads were last active; a
// row opens the project's page, its ⋯ menu keeps the ordering.

afterEach(() => {
  runCleanups();
  resetTaskBoardStore();
  act(() => {
    useProjectsStore.getState().setProjectsState([]);
    useManagerThreadsStore.setState({ threads: new Map(), loaded: false, archived: [], archivedLoaded: false, archivedReadFailed: false });
  });
});

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

const ATLAS = clientProject("prj_atlas", {
  name: "atlas-api", workingDir: "/work/atlas-api", tmuxSessionName: "md-atlas-api", sortOrder: 0,
  workers: [clientWorker("wkr_a", { projectId: "prj_atlas" }), clientWorker("wkr_b", { projectId: "prj_atlas" })]
});
const SEARCH = clientProject("prj_search", { name: "search-server", workingDir: "/work/search-server", tmuxSessionName: "md-search-server", sortOrder: 1000 });

let where = "";
function Where() {
  where = useLocation().pathname;
  return null;
}

async function render({ projects = [ATLAS, SEARCH], open = [managerThreadDto("thr_a", { projects: ["atlas-api"], lastActivityAt: ago(3.5) })], tasks = [taskDto("tsk_a", { status: "progress", labels: [{ name: "atlas-api", by: "auto" }] })] }: {
  projects?: Project[]; open?: ManagerThreadDto[]; tasks?: TaskDto[];
} = {}) {
  const calls = mockFetch(() => jsonResponse({ ok: true }));
  act(() => {
    useProjectsStore.getState().setProjectsState(projects);
    useManagerThreadsStore.getState().replaceAll(open);
    useManagerThreadsStore.setState({ archived: [], archivedLoaded: true });
    useTaskBoardStore.getState().replaceAll(tasks);
  });
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={["/projects"]}>
      <Where />
      <PaneHeaderSlotsProvider>
        <PaneHeaderActionsSlot />
        <Routes>
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:projectSlug" element={<p data-slot="project-route">A project</p>} />
        </Routes>
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  return { host, calls };
}

const row = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-slot="project-row"][data-project-id="${id}"]`)!;
const facts = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-slot="project-row-fact"]')].map((n) => n.textContent?.trim());
const press = async (el: HTMLElement) => {
  await act(async () => {
    el.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
};
const menuItem = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) => m.textContent?.trim() === name);

test("each project is one row: its name and folder, how many work, its open tasks, when its threads were last active", async () => {
  const { host } = await render();
  expect([...host.querySelectorAll<HTMLElement>('[data-slot="project-row"]')].map((r) => r.dataset.projectId)).toEqual(["prj_atlas", "prj_search"]);
  const atlas = row(host, "prj_atlas");
  expect(atlas.querySelector('[data-slot="project-row-name"]')?.textContent).toBe("atlas-api");
  expect(atlas.querySelector('[data-slot="project-row-folder"]')?.textContent).toBe("/work/atlas-api");
  expect(facts(atlas)).toEqual(["2 working", "1 open task", "3h ago"]);
  expect(facts(row(host, "prj_search"))).toEqual(["No workers", "No open tasks"]);
  // The workers' cards are the project page's now.
  expect(host.querySelector('[data-slot="worker-row"]') === null).toBe(true);
});

test("a row's link names the whole folder, which a narrow row cuts", async () => {
  const { host } = await render();
  expect(row(host, "prj_atlas").querySelector('[data-slot="project-row-name"]')?.getAttribute("title")).toBe("/work/atlas-api");
});

test("a row's last activity is its threads' activity, never an archiving", async () => {
  act(() => useManagerThreadsStore.setState({ archived: [] }));
  const { host } = await render({ open: [] });
  act(() => useManagerThreadsStore.setState({
    archived: [{ id: "thr_old", title: "Old", archivedAt: ago(0.5), lastActivityAt: ago(50), workers: 1, canvases: 0, labels: [], projects: ["atlas-api"] }]
  }));
  expect(facts(row(host, "prj_atlas")).at(-1)).toBe("2d ago");
});

test("a row opens the project's page", async () => {
  const { host } = await render();
  const name = row(host, "prj_search").querySelector<HTMLAnchorElement>('[data-slot="project-row-name"]')!;
  expect(name.getAttribute("href")).toBe("/projects/md-search-server");
  act(() => name.click());
  expect(where).toBe("/projects/md-search-server");
});

test("a row's menu keeps the ordering and does not open the page", async () => {
  const { host, calls } = await render();
  await press(row(host, "prj_search").querySelector<HTMLElement>('[aria-label="Project actions"]')!);
  expect(where).toBe("/projects");
  expect(["Move to top", "Move up", "Move down"].map((name) => menuItem(name)?.getAttribute("data-disabled") ?? null)).toEqual([null, null, ""]);
  await act(async () => { menuItem("Move up")!.click(); });
  await settleUntil(() => calls.some((c) => c.method === "POST" && c.url.endsWith("/api/projects/reorder")), "the reorder");
  expect(JSON.parse(String(calls.find((c) => c.url.endsWith("/api/projects/reorder"))!.init?.body))).toEqual({ projectIds: ["prj_search", "prj_atlas"] });
});

test("a missing session shows on its row with Restore", async () => {
  const { host } = await render({ projects: [{ ...ATLAS, tmuxStatus: "gone" }] });
  const atlas = row(host, "prj_atlas");
  expect(atlas.textContent).toContain("session missing");
  expect([...atlas.querySelectorAll("button")].map((b) => b.textContent?.trim())).toContain("Restore");
});

test("session-missing hides its text below md but keeps the icon and title", async () => {
  const { host } = await render({ projects: [{ ...SEARCH, tmuxStatus: "gone", ownership: "app" }] });
  const text = Array.from(host.querySelectorAll("span"))
    .find((s) => (s.textContent ?? "").trim() === "session missing" && s.children.length === 0);
  expect(text === undefined).toBe(false);
  expect(text!.className.split(/\s+/)).toContain("hidden");
  expect(text!.className.split(/\s+/)).toContain("md:inline");
  const wrapper = text!.parentElement!;
  expect(wrapper.getAttribute("title")).toBe("tmux session was killed externally — click Restore to rebuild");
  const icon = wrapper.querySelector("svg");
  expect(icon === null).toBe(false);
  expect(icon!.getAttribute("class") ?? "").not.toMatch(/(^|\s)md:/);
  expect(icon!.getAttribute("class") ?? "").not.toMatch(/(^|\s)hidden(\s|$)/);
});
