import { expect, test } from "bun:test";
import { reconcileProject } from "../src/server/modules/projects/project-reconcile.js";
import { tmuxReconcileAdapter } from "../src/server/modules/projects/tmux-reconcile-adapter.js";
import { buildCreateFeatureTool } from "../src/server/modules/features/tools/create-feature.js";
import { buildPaneRuntimes } from "../src/server/runtime/pane-runtime-registry.js";
import { freshProjectEnv, seedProject } from "./helpers/fixtures.js";

function buildRegistry(env: ReturnType<typeof freshProjectEnv>) {
  return buildPaneRuntimes({
    tmuxClient: env.tmux.client,
    projectsStore: env.projects,
    featuresStore: env.features
  });
}

test("create_feature (manager tool): creates feature row + tmux window", async () => {
  const env = freshProjectEnv("md-cf-");
  try {
    const projectId = seedProject(env.projects, {
      name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-test"
    });
    const project = env.projects.getById(projectId)!;
    reconcileProject(project, [], tmuxReconcileAdapter(env.tmux.client));

    const events: any[] = [];
    const tool = buildCreateFeatureTool({
      featuresStore: env.features,
      projectsStore: env.projects,
      agentStore: env.agentStore,
      tmuxClient: env.tmux.client,
      paneRuntimes: buildRegistry(env),
      broadcast: (e) => events.push(e)
    });

    const r = await tool.handler(
      { projectId, name: "login", mode: "shared-cwd" },
      { threadId: "t1", wakeId: "w1" }
    );
    expect(r.ok).toBeTruthy();
    expect(r.featureName).toBe("login");
    expect(r.featureId).toBeTruthy();
    // SSE event broadcast happened.
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("featureCreated");
    // DB has feature row.
    const row = env.features.getById(r.featureId!);
    expect(row).toBeTruthy();
    expect(row?.archivedAt).toBe(null);
  } finally { env.cleanup(); }
});

test("create_feature (manager tool): error for missing project", async () => {
  const env = freshProjectEnv("md-cf-");
  try {
    const tool = buildCreateFeatureTool({
      featuresStore: env.features,
      projectsStore: env.projects,
      agentStore: env.agentStore,
      tmuxClient: env.tmux.client,
      paneRuntimes: buildRegistry(env),
      broadcast: () => {}
    });
    const r = await tool.handler(
      { projectId: "nope", name: "x", mode: "shared-cwd" },
      { threadId: "t1", wakeId: "w1" }
    );
    expect(String(r.error)).toMatch(/project not found|project.*not found/i);
  } finally { env.cleanup(); }
});
