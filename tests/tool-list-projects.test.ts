import { expect, test } from "bun:test";
import { buildListProjectsTool } from "../src/server/modules/projects/tools/list-projects.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { toolContext } from "./helpers/typed.js";

test("list_projects: returns active only, with feature counts", async () => {
  const { projects, features } = freshStoresEnv("md-lp-");
  const aId = seedProject(projects, { name: "alpha", workingDir: "/a", tmuxSessionName: "alpha" });
  const bId = seedProject(projects, {
    name: "beta", workingDir: "/b", isGit: true, gitRemote: "git@x:b.git",
    tmuxSessionName: "beta"
  });
  seedFeature(features, aId, { name: "f1", tmuxWindowName: "f1" });
  seedFeature(features, aId, { name: "f2", tmuxWindowName: "f2" });
  projects.archive(bId);

  const tool = buildListProjectsTool({ projectsStore: projects, featuresStore: features });
  const r = await tool.handler({}, toolContext());
  expect(r.projects.length).toBe(1);
  expect(r.projects[0]!.name).toBe("alpha");
  expect(r.projects[0]!.featureCount).toBe(2);
  expect(r.projects[0]!.isGit).toBe(false);
  expect(r.projects[0]!.slug).toBe("alpha");
});

test("list_projects: empty when no active projects", async () => {
  const { projects, features } = freshStoresEnv("md-lp-");
  const tool = buildListProjectsTool({ projectsStore: projects, featuresStore: features });
  const r = await tool.handler({}, toolContext());
  expect(r.projects.length).toBe(0);
});
