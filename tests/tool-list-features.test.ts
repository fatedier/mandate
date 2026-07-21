import { expect, test } from "bun:test";
import { buildListFeaturesTool } from "../src/server/modules/features/tools/list-features.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";

test("list_features: all active features when projectId omitted", async () => {
  const { projects, features, cleanup } = freshStoresEnv("md-lf-");
  try {
    const aId = seedProject(projects, { name: "alpha", workingDir: "/a", tmuxSessionName: "alpha" });
    const bId = seedProject(projects, { name: "beta",  workingDir: "/b", tmuxSessionName: "beta" });
    seedFeature(features, aId, { name: "f1", tmuxWindowName: "f1" });
    seedFeature(features, bId, { name: "f2", tmuxWindowName: "f2" });

    const tool = buildListFeaturesTool({ featuresStore: features, projectsStore: projects });
    const all = await tool.handler({}, {} as any);
    expect(all.features.length).toBe(2);
    const names = all.features.map(f => f.name).sort();
    expect(names).toEqual(["f1", "f2"]);
  } finally { cleanup(); }
});

test("list_features: scoped by projectId", async () => {
  const { projects, features, cleanup } = freshStoresEnv("md-lf-");
  try {
    const aId = seedProject(projects, { name: "alpha", workingDir: "/a", tmuxSessionName: "alpha" });
    const bId = seedProject(projects, { name: "beta",  workingDir: "/b", tmuxSessionName: "beta" });
    seedFeature(features, aId, { name: "f1", tmuxWindowName: "f1" });
    seedFeature(features, bId, { name: "f2", tmuxWindowName: "f2" });

    const tool = buildListFeaturesTool({ featuresStore: features, projectsStore: projects });
    const justA = await tool.handler({ projectId: aId }, {} as any);
    expect(justA.features.length).toBe(1);
    expect(justA.features[0]!.name).toBe("f1");
    expect(justA.features[0]!.projectName).toBe("alpha");
  } finally { cleanup(); }
});

test("list_features: archived features excluded", async () => {
  const { projects, features, cleanup } = freshStoresEnv("md-lf-");
  try {
    const pId = seedProject(projects, { name: "alpha", workingDir: "/a", tmuxSessionName: "alpha" });
    const fId = seedFeature(features, pId, { name: "f1", tmuxWindowName: "f1" });
    features.archive(fId);

    const tool = buildListFeaturesTool({ featuresStore: features, projectsStore: projects });
    const r = await tool.handler({}, {} as any);
    expect(r.features.length).toBe(0);
  } finally { cleanup(); }
});
