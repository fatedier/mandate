import { afterEach, expect, jest, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { ProjectPage } from "@/routes/projects/ProjectPage";
import { PaneHeader } from "@/shell/PaneHeader";
import { PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";
import { useConfirmStore } from "@/components/confirm-action";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useProjectsStore, type Project } from "@/store/projects";
import { useTaskBoardStore } from "@/store/task-board";
import { useThreadStatusStore } from "@/store/thread-status";
import type { ArchivedThreadDto, ManagerThreadDto } from "@shared/api/agents";
import type { TaskDto } from "@shared/api/task-board";
import { runCleanups } from "../helpers/cleanup.js";
import { clientProject, clientWorker, managerThreadDto, taskDto } from "../helpers/client-builders.js";
import { fakeClock } from "../helpers/fake-clock.js";
import { jsonResponse, mockFetch, type FetchCall } from "../helpers/fetch.js";
import { mountAsync, settleUntil } from "../helpers/mount.js";
import { resetTaskBoardStore } from "../helpers/task-board.js";

// A project's page: one project from its own point of view, its workers,
// its threads and its open tasks, each list leading to the page that holds
// them all.

afterEach(() => {
  runCleanups();
  resetTaskBoardStore();
  act(() => {
    useProjectsStore.getState().setProjectsState([]);
    useManagerThreadsStore.setState({ threads: new Map(), loaded: false, archived: [], archivedLoaded: false, archivedReadFailed: false });
    useThreadStatusStore.getState().replace({ threads: [], waiting: [] });
    useConfirmStore.setState({ pending: null, resolver: null, returnFocus: null });
  });
});

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const label = (name: string) => [{ name, by: "auto" as const }];

function atlas(over: Partial<Project> = {}): Project {
  return clientProject("prj_atlas", {
    name: "atlas-api", workingDir: "/work/atlas-api", tmuxSessionName: "md-atlas-api",
    workers: [clientWorker("wkr_a", { projectId: "prj_atlas", name: "billing" }), clientWorker("wkr_b", { projectId: "prj_atlas", name: "docs" })],
    ...over
  });
}

let where = "";
let state: unknown = null;
let go: (to: string | -1) => void = () => {};
function Where() {
  const location = useLocation();
  const navigate = useNavigate();
  where = location.pathname + location.search;
  state = location.state;
  go = (to) => { void (to === -1 ? navigate(-1) : navigate(to)); };
  return null;
}

async function render({ projects = [atlas()], open = [], archived = [], tasks = [], at = "/projects/md-atlas-api", from, dots = [], arrived = true, answer }: {
  projects?: Project[]; open?: ManagerThreadDto[]; archived?: ArchivedThreadDto[]; tasks?: TaskDto[]; at?: string;
  /** A page the history holds before `at`. */
  from?: string;
  dots?: Array<{ threadId: string; state: "failed" | "needs_you" | "working" }>;
  /** Whether the projects have come from the stream. */
  arrived?: boolean;
  answer?: (call: FetchCall) => Response | Promise<Response> | undefined;
} = {}) {
  const calls = mockFetch((call) => answer?.(call) ?? reads(call));
  act(() => {
    if (arrived) useProjectsStore.getState().setProjectsState(projects);
    else useProjectsStore.setState({ projects: [], byId: {}, bySlug: {}, loaded: false });
    useManagerThreadsStore.getState().replaceAll(open);
    useManagerThreadsStore.setState({ archived, archivedLoaded: true });
    useThreadStatusStore.getState().replace({ threads: dots, waiting: [] });
    useTaskBoardStore.getState().replaceAll(tasks);
  });
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={from ? [from, at] : [at]} initialIndex={from ? 1 : 0}>
      <Where />
      <PaneHeaderSlotsProvider>
        <PaneHeader />
        <Routes>
          <Route path="/projects/:projectSlug" element={<ProjectPage />} />
          <Route path="/projects" element={<p data-slot="projects-list">The list</p>} />
          <Route path="*" element={<p data-slot="elsewhere">Elsewhere</p>} />
        </Routes>
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  return { host, calls };
}

/** The project's brief, memory count and reports, as the server answers them; `brief` null: the project has none. */
function reads(call: FetchCall, { brief = "## atlas-api\n\nTakes bakery orders by the dozen.", memories = 12, reports = REPORTS }: { brief?: string | null; memories?: number; reports?: typeof REPORTS } = {}): Response {
  if (call.url.includes("/api/memory/briefs")) {
    return jsonResponse({ briefs: brief === null ? [] : [{ scope: "project", projectId: "prj_atlas", projectName: "atlas-api", content: brief, builtAt: ago(5), stale: false, bytes: brief.length, limitBytes: 3000 }] });
  }
  if (call.url.includes("/api/memory/entries")) return jsonResponse({ entries: [], total: memories, limit: 1, offset: 0 });
  if (call.url.includes("/api/projects/prj_atlas/canvases")) return jsonResponse({ canvases: reports, total: reports.length });
  if (call.url.includes("/canvases")) return jsonResponse({ canvases: [], total: 0 });
  return jsonResponse({});
}

const REPORTS = [
  { id: "cnv_1", title: "Rollout report", kind: "report", scope: "worker", scopeId: "wkr_a", threadId: "thr_w", createdAt: ago(3), updatedAt: ago(3), projectId: "prj_atlas", projectName: "atlas-api", projectSlug: "md-atlas-api", workerId: "wkr_a", workerName: "billing", workerSlug: "wkr_a" },
  { id: "cnv_2", title: "Price audit", kind: "report", scope: "manager", scopeId: null, threadId: "thr_a", createdAt: ago(26), updatedAt: ago(26), projectId: "prj_atlas", projectName: "atlas-api", projectSlug: "md-atlas-api", workerId: null, workerName: null, workerSlug: null }
];

const texts = (root: ParentNode, selector: string) => [...root.querySelectorAll<HTMLElement>(selector)].map((n) => n.textContent?.trim());
const block = (host: HTMLElement, name: string) => host.querySelector<HTMLElement>(`[data-slot="project-block"][data-block="${name}"]`)!;
const link = (root: ParentNode, name: string) => [...root.querySelectorAll<HTMLAnchorElement>("a")].find((a) => a.textContent?.trim() === name);
const menuItems = () => texts(document, '[role="menuitem"]');
const press = async (el: HTMLElement) => {
  await act(async () => {
    el.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
};

test("the page names the project and its folder, counts what is there and lists its workers", async () => {
  const { host } = await render({
    open: [managerThreadDto("thr_a", { projects: ["atlas-api"], lastActivityAt: ago(1) }), managerThreadDto("thr_b", { projects: ["atlas-api"], lastActivityAt: ago(2) })],
    archived: [{ id: "thr_c", title: "Old", archivedAt: ago(30), lastActivityAt: ago(30), workers: 1, canvases: 0, labels: [], projects: ["atlas-api"] }],
    tasks: [taskDto("tsk_a", { status: "todo", labels: label("atlas-api") }), taskDto("tsk_b", { status: "review", labels: label("atlas-api") })]
  });
  const header = host.querySelector<HTMLElement>('[data-slot="project-header"]')!;
  expect(header.querySelector("h1")?.textContent).toBe("atlas-api");
  expect(header.querySelector('[data-slot="project-folder"]')?.textContent).toBe("/work/atlas-api");
  expect(texts(host, '[data-slot="project-figure"]').slice(0, 3)).toEqual(["2 working", "2 open tasks", "3 threads"]);
  expect(texts(host, '[data-slot="project-block"] h2')).toEqual(["Working now", "What the agents know", "Threads", "Open tasks", "Recent reports"]);
  expect(block(host, "workers").querySelectorAll('[data-slot="worker-row"]').length).toBe(2);
});

test("the band reads Projects, then the project's name, Projects leading to the list", async () => {
  const { host } = await render();
  const title = host.querySelector<HTMLElement>('[data-slot="pane-header"] nav[aria-label="Breadcrumb"]')!;
  expect(title.textContent?.replace(/\s+/g, "")).toBe("Projects/atlas-api");
  expect(link(title, "Projects")?.getAttribute("href")).toBe("/projects");
});

test("threads list what wants you first, five at most, and All threads opens the Threads page filtered", async () => {
  const open = ["thr_1", "thr_2", "thr_3", "thr_4", "thr_5", "thr_6"].map((id, i) => managerThreadDto(id, { title: `Thread ${i + 1}`, projects: ["atlas-api"], lastActivityAt: ago(i + 1) }));
  const { host } = await render({
    open: [...open, managerThreadDto("thr_x", { projects: ["search-server"], lastActivityAt: ago(0.1) })],
    archived: [{ id: "thr_old", title: "Old", archivedAt: ago(90), lastActivityAt: ago(90), workers: 0, canvases: 0, labels: [], projects: ["atlas-api"] }],
    dots: [{ threadId: "thr_6", state: "needs_you" }, { threadId: "thr_4", state: "working" }]
  });
  const rows = [...block(host, "threads").querySelectorAll<HTMLAnchorElement>('[data-slot="project-thread-row"]')];
  expect(rows.map((r) => r.getAttribute("href"))).toEqual(["/threads/thr_6", "/threads/thr_4", "/threads/thr_1", "/threads/thr_2", "/threads/thr_3"]);
  expect(rows[0]!.textContent).toContain("Thread 6");
  expect(link(block(host, "threads"), "All threads →")?.getAttribute("href")).toBe("/threads?project=atlas-api");
});

test("All threads opens the Archived tab when every thread of the project is archived", async () => {
  const { host } = await render({
    archived: [{ id: "thr_c", title: "Old", archivedAt: ago(30), lastActivityAt: ago(30), workers: 1, canvases: 0, labels: [], projects: ["atlas-api"] }]
  });
  expect(link(block(host, "threads"), "All threads →")?.getAttribute("href")).toBe("/threads?project=atlas-api&tab=archived");
});

test("open tasks list five at most, a row opens the task, and Board opens the board filtered", async () => {
  const tasks = ["a", "b", "c", "d", "e", "f"].map((id) => taskDto(`tsk_${id}`, { title: `Task ${id}`, status: "todo", labels: label("atlas-api"), createdAt: `2026-11-0${"abcdef".indexOf(id) + 1}T00:00:00.000Z` }));
  const { host } = await render({ tasks: [...tasks, taskDto("tsk_done", { status: "done", labels: label("atlas-api") })] });
  const rows = [...block(host, "tasks").querySelectorAll<HTMLElement>('[data-slot="project-task-row"]')];
  expect(rows.map((r) => r.textContent?.trim())).toEqual(["Task a", "Task b", "Task c", "Task d", "Task e"]);
  expect(link(block(host, "tasks"), "Board →")?.getAttribute("href")).toBe("/tasks?label=atlas-api");
  act(() => rows[1]!.click());
  expect(where).toBe("/agent?task=tsk_b");
});

test("empty blocks say so", async () => {
  const { host } = await render({ projects: [atlas({ workers: [] })], answer: (call) => reads(call, { brief: null, memories: 0, reports: [] }) });
  await settleUntil(() => texts(host, '[data-slot="project-figure"]').length === 5, "the reads");
  expect(texts(host, '[data-slot="project-block-empty"]')).toEqual(["No workers right now.", "No brief yet.", "No threads yet.", "No open tasks.", "No reports yet."]);
  expect(texts(host, '[data-slot="project-figure"]')).toEqual(["0 working", "0 open tasks", "0 threads", "0 memories", "0 reports"]);
});

test("a missing session shows on the header with Restore", async () => {
  const { host, calls } = await render({ projects: [atlas({ tmuxStatus: "gone" })] });
  const header = host.querySelector<HTMLElement>('[data-slot="project-header"]')!;
  expect(header.textContent).toContain("session missing");
  const restore = [...header.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Restore")!;
  act(() => restore.click());
  expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/projects/prj_atlas/reconcile"))).toBe(true);
  // It says Restoring… until the answer comes.
  await settleUntil(() => restore.textContent?.trim() === "Restore", "the answer");
});

test("the header's menu has no ordering", async () => {
  const { host } = await render();
  await press(host.querySelector<HTMLElement>('[data-slot="project-header"] [aria-label="Project actions"]')!);
  expect(menuItems()).toEqual(["Change working directory…", "Archive project"]);
});

test("archiving from the page goes to the list", async () => {
  const { host, calls } = await render({ answer: (call) => (call.method === "DELETE" ? jsonResponse({ ok: true }) : undefined) });
  await press(host.querySelector<HTMLElement>('[data-slot="project-header"] [aria-label="Project actions"]')!);
  await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) => m.textContent?.trim() === "Archive project")!.click(); });
  expect(useConfirmStore.getState().pending?.title).toBe('Archive project "atlas-api"?');
  await act(async () => { useConfirmStore.getState().resolve(true); });
  await settleUntil(() => useConfirmStore.getState().pending?.title === "Also kill the tmux session?", "the tmux question");
  await act(async () => { useConfirmStore.getState().resolve(false); });
  await settleUntil(() => where === "/projects", "the list");
  expect(calls.find((c) => c.method === "DELETE")?.url).toEndWith("/api/projects/prj_atlas");
});

test("archiving from the page never says No such project. on the way, and Back skips the page that is gone", async () => {
  let answered: () => void = () => {};
  const held = new Promise<void>((resolve) => { answered = resolve; });
  const { host } = await render({ from: "/threads", answer: (call) => (call.method === "DELETE" ? held.then(() => jsonResponse({ ok: true })) : undefined) });
  await press(host.querySelector<HTMLElement>('[data-slot="project-header"] [aria-label="Project actions"]')!);
  await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) => m.textContent?.trim() === "Archive project")!.click(); });
  await act(async () => { useConfirmStore.getState().resolve(true); });
  await settleUntil(() => useConfirmStore.getState().pending?.title === "Also kill the tmux session?", "the tmux question");
  await act(async () => { useConfirmStore.getState().resolve(false); });
  // The stream says the project is archived before the request answers.
  act(() => useProjectsStore.getState().removeProject("prj_atlas"));
  expect(host.textContent).not.toContain("No such project.");
  answered();
  await settleUntil(() => where === "/projects", "the list");
  act(() => go(-1));
  expect(where).toBe("/threads");
});

test("before the projects arrive the page says Loading…, never No such project.", async () => {
  fakeClock();
  const { host } = await render({ arrived: false });
  expect(host.querySelector('[data-slot="loading-line"]')?.textContent).toBe("Loading…");
  expect(host.textContent).not.toContain("No such project.");
  act(() => { jest.advanceTimersByTime(1_000); });
  act(() => useProjectsStore.getState().setProjectsState([atlas()]));
  expect(host.querySelector('[data-slot="project-header"] h1')?.textContent).toBe("atlas-api");
  // The page's reads start now; they land inside act (the clock is fake: no timer to wait on).
  await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
});

test("a slug that is a name every object has says No such project. too", async () => {
  for (const slug of ["constructor", "toString", "__proto__"]) {
    const { host } = await render({ at: `/projects/${slug}` });
    expect(host.querySelector('[data-slot="state-message"]')?.textContent).toContain("No such project.");
    runCleanups();
  }
});

test("a slug no project has says No such project. with All projects", async () => {
  const { host } = await render({ at: "/projects/md-gone" });
  expect(host.querySelector('[data-slot="state-message"]')?.textContent).toContain("No such project.");
  expect(link(host, "All projects")?.getAttribute("href")).toBe("/projects");
});

test("the brief shows with Memory, and the counts gain memories and reports once read", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const { host } = await render({ answer: (call) => held.then(() => reads(call)) });
  expect(block(host, "brief").querySelector('[data-slot="loading-line"]')?.textContent).toBe("Loading…");
  expect(texts(host, '[data-slot="project-figure"]')).toEqual(["2 working", "0 open tasks", "0 threads"]);
  release();
  await settleUntil(() => texts(host, '[data-slot="project-figure"]').length === 5, "the reads");
  expect(texts(host, '[data-slot="project-figure"]').slice(3)).toEqual(["12 memories", "2 reports"]);
  expect(block(host, "brief").querySelector('[data-slot="project-brief"]')?.textContent).toContain("Takes bakery orders by the dozen.");
  expect(link(block(host, "brief"), "Memory →")?.getAttribute("href")).toBe("/memory?view=browse&project=prj_atlas");
  expect(texts(block(host, "reports"), '[data-slot="project-report-row"] [data-slot="project-report-title"]')).toEqual(["Rollout report", "Price audit"]);
});

test("the memory count is the one the Memory page lists for the project: live memories", async () => {
  const { calls } = await render();
  await settleUntil(() => calls.some((c) => c.url.includes("/api/memory/entries")), "the count");
  const asked = new URL(calls.find((c) => c.url.includes("/api/memory/entries"))!.url, "http://x").searchParams;
  expect([asked.get("projectId"), asked.get("status"), asked.get("limit")]).toEqual(["prj_atlas", "available", "1"]);
});

test("a report opens the canvas over the page", async () => {
  const { host } = await render();
  await settleUntil(() => host.querySelector('[data-slot="project-report-row"]') !== null, "the reports");
  act(() => host.querySelector<HTMLElement>('[data-slot="project-report-row"]')!.click());
  expect(where).toBe("/canvas/cnv_1");
  expect((state as { backgroundLocation?: { pathname: string } }).backgroundLocation?.pathname).toBe("/projects/md-atlas-api");
});

test("reports are read again when a canvas is published", async () => {
  let shown = REPORTS.slice(1);
  const { host } = await render({ answer: (call) => reads(call, { reports: shown }) });
  await settleUntil(() => texts(host, '[data-slot="project-report-title"]').length === 1, "the first read");
  shown = REPORTS;
  act(() => { window.dispatchEvent(new window.Event("mandate:canvas-updated")); });
  await settleUntil(() => texts(host, '[data-slot="project-report-title"]').length === 2, "the second read");
});

test("a failed read says so with Retry, and Retry reads again", async () => {
  let fail = true;
  const { host } = await render({ answer: (call) => (fail && call.url.includes("/api/memory/briefs") ? jsonResponse({ error: "boom" }, 500) : undefined) });
  await settleUntil(() => block(host, "brief").textContent?.includes("Couldn't load the brief.") ?? false, "the failure");
  fail = false;
  act(() => [...block(host, "brief").querySelectorAll("button")].find((b) => b.textContent === "Retry")!.click());
  await settleUntil(() => block(host, "brief").textContent?.includes("Takes bakery orders by the dozen.") ?? false, "the brief");
});

test("a failed reports read says so, and leaves its count out", async () => {
  const { host } = await render({ answer: (call) => (call.url.includes("/canvases") ? jsonResponse({ error: "boom" }, 500) : undefined) });
  await settleUntil(() => block(host, "reports").textContent?.includes("Couldn't load the reports.") ?? false, "the failure");
  await settleUntil(() => texts(host, '[data-slot="project-figure"]').length === 4, "the memory count");
  expect(texts(host, '[data-slot="project-figure"]').at(-1)).toBe("12 memories");
});

test("moving to another project drops what was on its way for the first", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const search = clientProject("prj_search", { name: "search-server", workingDir: "/work/search-server", tmuxSessionName: "md-search-server" });
  const { host } = await render({
    projects: [atlas(), search],
    answer: (call) => {
      if (!call.url.includes("/api/memory/briefs")) return undefined;
      if (where.startsWith("/projects/md-atlas-api")) return held.then(() => reads(call));
      return jsonResponse({ briefs: [{ scope: "project", projectId: "prj_search", projectName: "search-server", content: "Search notes.", builtAt: ago(1), stale: false, bytes: 13, limitBytes: 3000 }] });
    }
  });
  act(() => go("/projects/md-search-server"));
  await settleUntil(() => block(host, "brief").textContent?.includes("Search notes.") ?? false, "the second project's brief");
  await act(async () => { release(); await new Promise((r) => setTimeout(r, 10)); });
  expect(block(host, "brief").textContent).toContain("Search notes.");
  expect(block(host, "brief").textContent).not.toContain("Takes bakery orders by the dozen.");
});
