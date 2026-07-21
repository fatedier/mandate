import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { buildFeatureWorkItemTool } from "../src/server/modules/agent/tools/feature-work-item-tools.js";
import { buildWorkItemTools } from "../src/server/modules/agent/tools/work-item-tools.js";
import type { ToolContext } from "../src/server/modules/agent/tool-registry.js";

function setup() {
  const db = new Database(":memory:");
  initializeProjectsSchema(db);
  initializeFeaturesSchema(db);
  initializeAgentSchema(db);
  const projects = new ProjectsStore(db);
  const features = new FeaturesStore(db);
  const workStore = new WorkItemStore(db);
  const projectId = projects.insert({
    name: "p", workingDir: "/tmp/p", tmuxSessionName: "p",
    ownership: "app", gitRemote: null, isGit: false
  });
  const featureId = features.insert({
    projectId, name: "login", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "login", ownership: "app"
  });
  const emitted: Array<{ event: string; data: unknown }> = [];
  const sse = { emit: (event: string, data: unknown) => { emitted.push({ event, data }); } };
  return { workStore, featureId, itemId: workStore.getByFeature(featureId)!.id, sse, emitted };
}

/** The tool context the wake loop actually builds: threadId, wakeId and the
 *  scope object it resolves for the thread. */
function featureCtx(): ToolContext {
  return {
    threadId: "t-feature", wakeId: "w-1",
    scope: {
      kind: "worker",
      feature: { workingDir: "/tmp/p/feat" },
      project: { workingDir: "/tmp/p" }
    }
  };
}

function managerCtx(): ToolContext {
  return {
    threadId: "t-manager", wakeId: "w-2",
    scope: { kind: "manager", managerDir: "/tmp/manager", projectWorkingDirs: ["/tmp/p"] }
  };
}

test("update_my_work_item records the worker as the summary's author", async () => {
  const { workStore, featureId, sse } = setup();
  const tool = buildFeatureWorkItemTool({
    workStore, sse: sse as never, resolveFeatureId: () => featureId
  });

  await tool.handler({ summary: "Approach picked: additive migration." }, featureCtx());

  const item = workStore.getByFeature(featureId)!;
  expect(item.summaryUpdatedBy).toBe("worker");
  expect(item.summaryUpdatedAt).not.toBeNull();
});

test("update_work_item records the manager as the summary's author", async () => {
  const { workStore, itemId, sse } = setup();
  const [update] = buildWorkItemTools({ workStore, sse: sse as never });

  await update!.handler({ id: itemId, patch: { summary: "Reworded for the user." } }, managerCtx());

  const item = workStore.get(itemId)!;
  expect(item.summaryUpdatedBy).toBe("manager");
});

test("the two writers are distinguishable on the same field, most recent wins", async () => {
  const { workStore, featureId, itemId, sse } = setup();
  const featureTool = buildFeatureWorkItemTool({
    workStore, sse: sse as never, resolveFeatureId: () => featureId
  });
  const [overviewTool] = buildWorkItemTools({ workStore, sse: sse as never });

  await featureTool.handler({ summary: "Written by the feature agent." }, featureCtx());
  expect(workStore.get(itemId)!.summaryUpdatedBy).toBe("worker");

  await overviewTool!.handler(
    { id: itemId, patch: { summary: "Reworded by manager." } },
    managerCtx()
  );
  expect(workStore.get(itemId)!.summaryUpdatedBy).toBe("manager");

  await featureTool.handler({ summary: "Feature agent again." }, featureCtx());
  expect(workStore.get(itemId)!.summaryUpdatedBy).toBe("worker");
});

test("a phase-only update through the tool leaves the summary's author and time alone", async () => {
  const { workStore, featureId, sse } = setup();
  const tool = buildFeatureWorkItemTool({
    workStore, sse: sse as never, resolveFeatureId: () => featureId
  });
  await tool.handler({ summary: "Result is in." }, featureCtx());
  const written = workStore.getByFeature(featureId)!;

  await Bun.sleep(5);
  await tool.handler({ phase: "done", phaseDetail: "wrapping up" }, featureCtx());

  const after = workStore.getByFeature(featureId)!;
  expect(after.phase).toBe("done");
  expect(after.summaryUpdatedAt).toBe(written.summaryUpdatedAt!);
  expect(after.summaryUpdatedBy).toBe("worker");
  expect(after.lastActivityAt > written.lastActivityAt).toBe(true);
});

test("the identity comes from the caller's scope, not from which tool was used", async () => {
  // A feature-scoped thread reaching update_work_item must not be recorded as
  // manager just because it called manager's tool.
  const { workStore, itemId, sse } = setup();
  const [update] = buildWorkItemTools({ workStore, sse: sse as never });

  await update!.handler({ id: itemId, patch: { summary: "From a feature thread." } }, featureCtx());

  expect(workStore.get(itemId)!.summaryUpdatedBy).toBe("worker");
});

test("the summary write is still emitted on SSE with its provenance attached", async () => {
  const { workStore, featureId, sse, emitted } = setup();
  const tool = buildFeatureWorkItemTool({
    workStore, sse: sse as never, resolveFeatureId: () => featureId
  });

  await tool.handler({ summary: "Visible to open clients." }, featureCtx());

  const update = emitted.find((e) => e.event === "workItemUpdated");
  expect(update).toBeDefined();
  const { item } = update!.data as { item: { summaryUpdatedBy: string | null; summary: string | null } };
  expect(item.summary).toBe("Visible to open clients.");
  expect(item.summaryUpdatedBy).toBe("worker");
});
