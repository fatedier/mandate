import { expect, test } from "bun:test";
import { activeWorkers, countText, projectOpenTasks, projectThreads } from "../src/client/routes/projects/project-overview.js";
import type { ArchivedThreadDto } from "../src/shared/api/agents.js";
import type { ThreadDot } from "../src/shared/thread-dot.js";
import { clientProject, clientWorker, managerThreadDto, taskDto } from "./helpers/client-builders.js";

// One project's share of what the client holds: its threads, its open
// tasks, its workers, as its page lists them.

const at = (hour: number) => `2026-11-10T${String(hour).padStart(2, "0")}:00:00.000Z`;
const archived = (id: string, over: Partial<ArchivedThreadDto> = {}): ArchivedThreadDto => ({
  id, title: id, archivedAt: at(1), lastActivityAt: at(1), workers: 0, canvases: 0, labels: [], projects: [], ...over
});

test("a project's threads are its open and archived ones, what wants you first, then what runs, then the rest by last activity", () => {
  const open = [
    managerThreadDto("thr_asks", { lastActivityAt: at(2), projects: ["atlas-api"] }),
    managerThreadDto("thr_runs", { lastActivityAt: at(3), projects: ["search-server", "atlas-api"] }),
    managerThreadDto("thr_quiet", { lastActivityAt: at(9), projects: ["atlas-api"] }),
    managerThreadDto("thr_other", { lastActivityAt: at(10), projects: ["search-server"] }),
    managerThreadDto("thr_broke", { lastActivityAt: at(1), projects: ["atlas-api"] })
  ];
  const old = [archived("thr_done", { archivedAt: at(8), projects: ["atlas-api"] }), archived("thr_gone", { projects: ["search-server"] })];
  const dots = new Map<string, ThreadDot>([["thr_asks", "needs_you"], ["thr_runs", "working"], ["thr_other", "needs_you"], ["thr_broke", "failed"]]);
  const listed = projectThreads(open, old, "atlas-api", dots);
  expect(listed.map((t) => t.id)).toEqual(["thr_asks", "thr_broke", "thr_runs", "thr_quiet", "thr_done"]);
  expect(listed.find((t) => t.id === "thr_done")?.archived).toBe(true);
});

test("archived threads come after the open ones, however lately archived: an archive is not activity", () => {
  const open = [managerThreadDto("thr_quiet", { lastActivityAt: at(2), projects: ["atlas-api"] })];
  const old = [archived("thr_late", { archivedAt: at(9), projects: ["atlas-api"] }), archived("thr_early", { archivedAt: at(5), projects: ["atlas-api"] })];
  expect(projectThreads(open, old, "atlas-api", new Map()).map((t) => t.id)).toEqual(["thr_quiet", "thr_late", "thr_early"]);
});

test("a project's open tasks are those labelled with its name in any case, In review first", () => {
  const tasks = [
    taskDto("tsk_todo", { status: "todo", labels: [{ name: "atlas-api", by: "owner" }] }),
    taskDto("tsk_review", { status: "review", labels: [{ name: "Atlas-API", by: "auto" }] }),
    taskDto("tsk_done", { status: "done", labels: [{ name: "atlas-api", by: "auto" }] }),
    taskDto("tsk_cancelled", { status: "cancelled", labels: [{ name: "atlas-api", by: "auto" }] }),
    taskDto("tsk_progress", { status: "progress", labels: [{ name: "ops", by: "owner" }, { name: "atlas-api", by: "auto" }] }),
    taskDto("tsk_other", { status: "todo", labels: [{ name: "search-server", by: "auto" }] })
  ];
  expect(projectOpenTasks(tasks, "atlas-api").map((t) => t.id)).toEqual(["tsk_review", "tsk_progress", "tsk_todo"]);
});

test("a project's workers on its page are its active ones", () => {
  const project = clientProject("prj_a", { workers: [clientWorker("wkr_a"), clientWorker("wkr_b", { archivedAt: at(1) })] });
  expect(activeWorkers(project).map((w) => w.id)).toEqual(["wkr_a"]);
});

test("counts read in the singular at one", () => {
  expect(countText(1, "thread", "threads")).toBe("1 thread");
  expect(countText(0, "thread", "threads")).toBe("0 threads");
  expect(countText(5, "thread", "threads")).toBe("5 threads");
});
