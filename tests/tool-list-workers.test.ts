import { expect, test } from "bun:test";
import { buildListWorkersTool } from "../src/server/modules/workers/tools/list-workers.js";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { toolContext } from "./helpers/typed.js";

test("list_workers: all active workers when projectId omitted", async () => {
  const { projects, workers } = freshStoresEnv("md-lf-");
  const aId = seedProject(projects, { name: "alpha", workingDir: "/a", tmuxSessionName: "alpha" });
  const bId = seedProject(projects, { name: "beta",  workingDir: "/b", tmuxSessionName: "beta" });
  seedWorker(workers, aId, { name: "f1", tmuxWindowName: "f1" });
  seedWorker(workers, bId, { name: "f2", tmuxWindowName: "f2" });

  const tool = buildListWorkersTool({ workersStore: workers, projectsStore: projects });
  const all = await tool.handler({}, toolContext());
  expect(all.workers.length).toBe(2);
  const names = all.workers.map(f => f.name).sort();
  expect(names).toEqual(["f1", "f2"]);
});

test("list_workers: scoped by projectId", async () => {
  const { projects, workers } = freshStoresEnv("md-lf-");
  const aId = seedProject(projects, { name: "alpha", workingDir: "/a", tmuxSessionName: "alpha" });
  const bId = seedProject(projects, { name: "beta",  workingDir: "/b", tmuxSessionName: "beta" });
  seedWorker(workers, aId, { name: "f1", tmuxWindowName: "f1" });
  seedWorker(workers, bId, { name: "f2", tmuxWindowName: "f2" });

  const tool = buildListWorkersTool({ workersStore: workers, projectsStore: projects });
  const justA = await tool.handler({ projectId: aId }, toolContext());
  expect(justA.workers.length).toBe(1);
  expect(justA.workers[0]!.name).toBe("f1");
  expect(justA.workers[0]!.projectName).toBe("alpha");
});

test("list_workers: archived workers excluded", async () => {
  const { projects, workers } = freshStoresEnv("md-lf-");
  const pId = seedProject(projects, { name: "alpha", workingDir: "/a", tmuxSessionName: "alpha" });
  const workerId = seedWorker(workers, pId, { name: "f1", tmuxWindowName: "f1" });
  workers.archive(workerId);

  const tool = buildListWorkersTool({ workersStore: workers, projectsStore: projects });
  const r = await tool.handler({}, toolContext());
  expect(r.workers.length).toBe(0);
});
