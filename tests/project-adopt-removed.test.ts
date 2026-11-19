import { expect, test } from "bun:test";
import { TmuxRuntime } from "../src/server/runtime/runtimes/tmux-runtime.js";
import { freshProjectEnv, seedProject } from "./helpers/fixtures.js";
import { tempDir } from "./helpers/temp.js";
import { buildProjectsTestApp, deleteJson, postJson } from "./helpers/test-app.js";
import type { CommandResult } from "../src/server/platform/process/command-runner.js";

// Adopt is gone: a tmux session no longer becomes a project. A project
// adopted before keeps working, as any installation may have one.

const NO_REPOSITORY = { runner: { run: async (): Promise<CommandResult> => ({ status: 128, signal: null, stdout: "", stderr: "fatal: not a git repository" }) } };

function projectsApp() {
  const env = freshProjectEnv("md-adopt-removed-");
  const deps = {
    projects: env.projects, workers: env.workers, agentStore: env.agentStore, tmuxClient: env.tmux.client, gitClient: NO_REPOSITORY, broadcast: () => {},
    tmuxRuntime: new TmuxRuntime({ tmuxClient: env.tmux.client, projectsStore: env.projects, workersStore: env.workers })
  };
  return { env, app: buildProjectsTestApp(deps) };
}

test("there is no adopt route", async () => {
  const { app } = projectsApp();
  const r = await postJson(app, "/api/projects/adopt", { sessionName: "work", projectName: "Work", workingDir: tempDir("md-wd-") });
  expect(r.status).toBe(404);
});

test("a project adopted before is still a project, and archiving it with its session closes the session it adopted", async () => {
  const { env, app } = projectsApp();
  const wd = tempDir("md-wd-");
  env.tmux.answer(["new-session", "-d", "-s", "work", "-c", wd]);
  const projectId = seedProject(env.projects, { name: "Work", workingDir: wd, tmuxSessionName: "work", ownership: "adopted" });
  expect(env.projects.listActive().map((p) => [p.id, p.ownership])).toContainEqual([projectId, "adopted"]);
  expect((await deleteJson(app, `/api/projects/${projectId}?killTmux=true`)).status).toBe(200);
  expect(env.tmux.answer(["has-session", "-t", "work"]).status).not.toBe(0);
});
