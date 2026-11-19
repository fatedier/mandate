import { expect, test } from "bun:test";
import { buildCreateProjectTool } from "../src/server/modules/projects/tools/create-project.js";
import { buildListProjectsTool } from "../src/server/modules/projects/tools/list-projects.js";
import { freshProjectEnv, freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { toolContext } from "./helpers/typed.js";

test("create_project: creates a tmux-backed project", async () => {
  const env = freshProjectEnv("md-cp-rt-");
  const events: unknown[] = [];
  const tool = buildCreateProjectTool({
    projectsStore: env.projects, workersStore: env.workers,
    tmuxClient: env.tmux.client, broadcast: (event) => { events.push(event); }
  });
  const ctx = { threadId: "t1", wakeId: "w1", scope: { kind: "manager" as const, managerDir: env.dir, projectWorkingDirs: [] } };
  const r = await tool.handler({ name: "My App", workingDir: env.dir }, ctx);
  const project = env.projects.getById(r.projectId!)!;
  expect(project.tmuxSessionName).toContain("my_app");
  expect(r).toStrictEqual({ ok: true, projectId: project.id, projectName: "My App", projectSlug: project.tmuxSessionName });
  expect(events).toStrictEqual([{ type: "projectCreated", data: project }]);
  // A refusal is the service's own words, and nothing is announced.
  expect(await tool.handler({ name: "  ", workingDir: env.dir }, ctx)).toStrictEqual({ error: "name is required" });
  expect(events).toHaveLength(1);
});

test("list_projects: returns active only, with worker counts", async () => {
  const { projects, workers } = freshStoresEnv("md-lp-");
  const aId = seedProject(projects, { name: "alpha", workingDir: "/a", tmuxSessionName: "alpha" });
  const bId = seedProject(projects, {
    name: "beta", workingDir: "/b", isGit: true, gitRemote: "git@x:b.git",
    tmuxSessionName: "beta"
  });
  seedWorker(workers, aId, { name: "f1", tmuxWindowName: "f1" });
  seedWorker(workers, aId, { name: "f2", tmuxWindowName: "f2" });
  projects.archive(bId);

  const tool = buildListProjectsTool({ projectsStore: projects, workersStore: workers });
  const r = await tool.handler({}, toolContext());
  expect(r.projects.length).toBe(1);
  expect(r.projects[0]!.name).toBe("alpha");
  expect(r.projects[0]!.workerCount).toBe(2);
  expect(r.projects[0]!.isGit).toBe(false);
  expect(r.projects[0]!.slug).toBe("alpha");
});

test("list_projects: empty when no active projects", async () => {
  const { projects, workers } = freshStoresEnv("md-lp-");
  const tool = buildListProjectsTool({ projectsStore: projects, workersStore: workers });
  const r = await tool.handler({}, toolContext());
  expect(r.projects.length).toBe(0);
});
