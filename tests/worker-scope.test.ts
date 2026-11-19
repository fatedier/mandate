import { expect, test } from "bun:test";
import type { Config } from "../src/server/config.js";
import { DEFAULT_CONFIG } from "../src/server/config/defaults.js";
import { buildWorkerInitialContext } from "../src/server/modules/agent/system-prompt.js";
import { buildWorkerScope, type WorkerScopeDeps } from "../src/server/runtime/scopes/worker-scope.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { Analyzer } from "../src/server/modules/analysis/analyzer.js";
import type { TmuxRuntime } from "../src/server/runtime/runtimes/tmux-runtime.js";
import { analyseWindow } from "./helpers/analysis.js";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { stub } from "./helpers/typed.js";

const base = {
  project: { name: "project-1", workingDir: "/w", isGit: true, gitRemote: null, tmuxSessionName: "md-project-1" },
  worker: { id: "wkr_1", name: "project-2 evict", tmuxWindowName: "f", mode: "worktree", branch: "b", baseRef: "dev", worktreePath: "/w/f" },
  availableSkillsSection: ""
} as unknown as Parameters<typeof buildWorkerInitialContext>[0];

test("the initial context carries the plan, and says when there is none", () => {
  expect(buildWorkerInitialContext({ ...base, planSection: "Plan: 1 of 2 done" })).toContain("## Your plan\n\nPlan: 1 of 2 done");
  expect(buildWorkerInitialContext(base)).toContain("## Your plan\n\nNo plan yet.");
});

test("the worker scope reads the plan when the context is built, so a compaction sees the latest", async () => {
  const env = freshStoresEnv("md-worker-plan-ctx-");
  const projectId = seedProject(env.projects);
  const workerId = seedWorker(env.workers, projectId);
  const thread = env.agentStore.getOrCreateThread("worker", workerId);
  const planStore = new PlanStore(env.store.db);
  const scope = buildWorkerScope({
    agentStore: env.agentStore,
    projectsStore: env.projects,
    workersStore: env.workers,
    skillRegistry: { maybeRefresh: async () => {}, renderManifest: () => "" },
    planStore
  } as unknown as WorkerScopeDeps);
  expect(await scope.buildInitialContext!(thread.id)).toContain("## Your plan\n\nNo plan yet.");
  planStore.update(workerId, { conclusion: "Waiting on upstream", steps: [{ title: "wait", status: "blocked", note: "project-2#17" }] });
  expect(await scope.buildInitialContext!(thread.id)).toContain("## Your plan\n\nPlan: 0 of 1 done\nConclusion: Waiting on upstream");
});

test("the worker reads the user's rules for the tool-call review while the review is on", async () => {
  const env = freshStoresEnv("md-worker-rules-ctx-");
  const projectId = seedProject(env.projects);
  const workerId = seedWorker(env.workers, projectId);
  const thread = env.agentStore.getOrCreateThread("worker", workerId);
  const chat = { ...DEFAULT_CONFIG.agent.decisions, provider: "gw", model: "deepseek/deepseek-flash" };
  const config: Config = { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, toolReviewEnabled: true, toolReviewRules: "Ask me before anything touches production.", decisionsEnabled: true, decisions: chat } };
  const scope = buildWorkerScope({
    agentStore: env.agentStore,
    projectsStore: env.projects,
    workersStore: env.workers,
    skillRegistry: { maybeRefresh: async () => {}, renderManifest: () => "" },
    config
  } as unknown as WorkerScopeDeps);
  expect(await scope.buildInitialContext!(thread.id)).toContain("## Your user's rules for risky steps\n\nAsk me before anything touches production.");
});

test("the worker's pane digest shows what the analyser decided for each pane, else that it is running", async () => {
  const env = freshStoresEnv("md-worker-pane-ctx-");
  const projectId = seedProject(env.projects);
  const workerId = seedWorker(env.workers, projectId);
  const thread = env.agentStore.getOrCreateThread("worker", workerId);
  const analyzer = new Analyzer();
  analyseWindow(analyzer, [
    { paneId: "%21", currentCommand: "zsh", capture: "alice@host p % ", foreground: ["-zsh"] },
    // Nothing on screen and nothing the heuristics know: undecided.
    { paneId: "%22", currentCommand: "less", capture: "", foreground: ["less notes.txt"] }
  ]);
  expect(analyzer.getCachedAnalysis("%22")?.status).toBe("unknown");
  const pane = (id: string) => ({ id, workerId, command: [], cwd: "/tmp", pid: null, status: "running" as const, spawnedAt: "" });
  const scope = buildWorkerScope(stub<WorkerScopeDeps>({
    agentStore: env.agentStore,
    projectsStore: env.projects,
    workersStore: env.workers,
    analyzer,
    tmuxRuntime: stub<TmuxRuntime>({ listPanes: async () => [pane("%21"), pane("%22"), pane("%23")] })
  }));
  const context = await scope.buildRuntimeContext!(thread.id);
  expect(context).toContain("- %21 [idle_shell]");
  expect(context).toContain("- %22 [running]");
  expect(context).toContain("- %23 [running]");
});
