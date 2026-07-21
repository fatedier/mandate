import { expect, test } from "bun:test";
import { buildListProjectsTool } from "../src/server/modules/projects/tools/list-projects.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";

test("list_projects: returns active only, with feature counts", async () => {
  const { projects, features, cleanup } = freshStoresEnv("md-lp-");
  try {
    const aId = seedProject(projects, { name: "alpha", workingDir: "/a", tmuxSessionName: "alpha" });
    const bId = seedProject(projects, {
      name: "beta", workingDir: "/b", isGit: true, gitRemote: "git@x:b.git",
      tmuxSessionName: "beta"
    });
    seedFeature(features, aId, { name: "f1", tmuxWindowName: "f1" });
    seedFeature(features, aId, { name: "f2", tmuxWindowName: "f2" });
    projects.archive(bId);

    const tool = buildListProjectsTool({ projectsStore: projects, featuresStore: features });
    const r = await tool.handler({}, {} as any);
    expect(r.projects.length).toBe(1);
    expect(r.projects[0]!.name).toBe("alpha");
    expect(r.projects[0]!.featureCount).toBe(2);
    expect(r.projects[0]!.isGit).toBe(false);
    expect(r.projects[0]!.slug).toBe("alpha");
  } finally { cleanup(); }
});

test("list_projects: empty when no active projects", async () => {
  const { projects, features, cleanup } = freshStoresEnv("md-lp-");
  try {
    const tool = buildListProjectsTool({ projectsStore: projects, featuresStore: features });
    const r = await tool.handler({}, {} as any);
    expect(r.projects.length).toBe(0);
  } finally { cleanup(); }
});
