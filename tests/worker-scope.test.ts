import { expect, test } from "bun:test";
import { buildWorkerInitialContext } from "../src/server/modules/agent/system-prompt.js";
import { buildWorkerScope, type WorkerScopeDeps } from "../src/server/runtime/scopes/worker-scope.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { Analyzer } from "../src/server/modules/analysis/analyzer.js";
import type { TmuxRuntime } from "../src/server/runtime/runtimes/tmux-runtime.js";
import type { PaneRuntimeRegistry } from "../src/server/runtime/pane-runtime-registry.js";
import { analyseWindow } from "./helpers/analysis.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { stub } from "./helpers/typed.js";

const base = {
  project: { name: "project-1", workingDir: "/w", isGit: true, gitRemote: null, tmuxSessionName: "md-project-1" },
  feature: { id: "feat_1", name: "project-2 evict", tmuxWindowName: "f", mode: "worktree", branch: "b", baseRef: "dev", worktreePath: "/w/f" },
  availableSkillsSection: ""
} as unknown as Parameters<typeof buildWorkerInitialContext>[0];

test("the initial context carries the plan, and says when there is none", () => {
  expect(buildWorkerInitialContext({ ...base, planSection: "Plan: 1 of 2 done" })).toContain("## Your plan\n\nPlan: 1 of 2 done");
  expect(buildWorkerInitialContext(base)).toContain("## Your plan\n\nNo plan yet.");
});

test("the worker scope reads the plan when the context is built, so a compaction sees the latest", async () => {
  const env = freshStoresEnv("md-worker-plan-ctx-");
  const projectId = seedProject(env.projects);
  const featureId = seedFeature(env.features, projectId);
  const thread = env.agentStore.getOrCreateThread("worker", featureId);
  const planStore = new PlanStore(env.store.db);
  const scope = buildWorkerScope({
    agentStore: env.agentStore,
    projectsStore: env.projects,
    featuresStore: env.features,
    skillRegistry: { maybeRefresh: async () => {}, renderManifest: () => "" },
    planStore
  } as unknown as WorkerScopeDeps);
  expect(await scope.buildInitialContext!(thread.id)).toContain("## Your plan\n\nNo plan yet.");
  planStore.update(featureId, { conclusion: "Waiting on upstream", steps: [{ title: "wait", status: "blocked", note: "project-2#17" }] });
  expect(await scope.buildInitialContext!(thread.id)).toContain("## Your plan\n\nPlan: 0 of 1 done\nConclusion: Waiting on upstream");
});

test("the worker's pane digest shows what the analyser decided for each live pane, else the pane's lifecycle", async () => {
  const env = freshStoresEnv("md-worker-pane-ctx-");
  const projectId = seedProject(env.projects);
  const featureId = seedFeature(env.features, projectId);
  const thread = env.agentStore.getOrCreateThread("worker", featureId);
  const analyzer = new Analyzer();
  analyseWindow(analyzer, [
    { paneId: "%21", currentCommand: "zsh", capture: "alice@host p % ", foreground: ["-zsh"] },
    // Nothing on screen and nothing the heuristics know: undecided.
    { paneId: "%22", currentCommand: "less", capture: "", foreground: ["less notes.txt"] },
    { paneId: "%24", currentCommand: "zsh", capture: "alice@host p % ", foreground: ["-zsh"] }
  ]);
  expect(analyzer.getCachedAnalysis("%22")?.status).toBe("unknown");
  const pane = (id: string, status: "running" | "dead" = "running") => ({ id, featureId, command: [], cwd: "/tmp", pid: null, status, spawnedAt: "" });
  const scope = buildWorkerScope(stub<WorkerScopeDeps>({
    agentStore: env.agentStore,
    projectsStore: env.projects,
    featuresStore: env.features,
    analyzer,
    paneRuntimes: stub<PaneRuntimeRegistry>({
      forProject: () => stub<TmuxRuntime>({ listPanes: async () => [pane("%21"), pane("%22"), pane("%23"), pane("%24", "dead")] })
    })
  }));
  const context = await scope.buildRuntimeContext!(thread.id);
  expect(context).toContain("- %21 [idle_shell]");
  expect(context).toContain("- %22 [running]");
  expect(context).toContain("- %23 [running]");
  // A pane that has exited is dead whatever its last screen looked like.
  expect(context).toContain("- %24 [dead]");
});
