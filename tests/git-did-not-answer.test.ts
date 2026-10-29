import { expect, test } from "bun:test";
import {
  gitBranchExists,
  gitDetectRepository,
  gitRefExists,
  type GitClient
} from "../src/server/platform/git/git.js";
import { CommandDidNotAnswerError, type CommandResult } from "../src/server/platform/process/command-runner.js";
import { tmuxNewSession } from "../src/server/platform/tmux/tmux.js";
import { buildPaneRuntimes } from "../src/server/runtime/pane-runtime-registry.js";
import { freshProjectEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { buildFeaturesTestApp, buildGitTestApp, buildProjectsTestApp, deleteJson, postJson } from "./helpers/test-app.js";
import { tempDir } from "./helpers/temp.js";

/**
 * A git that does not answer in time is not a git that says no. Read as "no",
 * it recorded a project as not a git repository for good, and let a worker be
 * made on a branch nobody had checked. Bun 1.4.2's spawnSync can stall every
 * call this way (oven-sh/bun#34069); an ordinary timeout does it one call at a time.
 */

const TIMED_OUT: CommandResult = {
  status: null, signal: "SIGTERM", stdout: "", stderr: "",
  error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" })
};
const NOT_INSTALLED: CommandResult = {
  status: null, signal: null, stdout: "", stderr: "",
  error: Object.assign(new Error("spawnSync git ENOENT"), { code: "ENOENT" })
};
const ok = (stdout = ""): CommandResult => ({ status: 0, signal: null, stdout, stderr: "" });
const no = (): CommandResult => ({ status: 1, signal: null, stdout: "", stderr: "" });

/** Git that answers as a repo on `main` would, except the calls `stalls` picks. */
function scriptedGit(stalls: (args: string[]) => boolean, calls: string[][] = []): GitClient {
  return {
    runner: {
      run(_command, args) {
        calls.push(args);
        if (stalls(args)) return TIMED_OUT;
        if (args.includes("show-ref")) return no(); // a branch that does not exist yet
        if (args.includes("rev-parse")) return ok(args.includes("--git-dir") ? ".git\n" : "abc123\n");
        if (args.includes("branch") && args.includes("-a")) return ok("main\n");
        if (args.includes("config")) return ok("git@example.com:repo.git\n");
        return ok();
      }
    }
  };
}

function probeOutcome(probe: () => unknown): string {
  try {
    return JSON.stringify(probe());
  } catch (err) {
    return err instanceof CommandDidNotAnswerError ? "did not answer" : String(err);
  }
}

test("the git probes throw when git does not answer, answer no when it says no, and treat no git at all as no", () => {
  const stalled = scriptedGit(() => true);
  const missing: GitClient = { runner: { run: () => NOT_INSTALLED } };
  const said = { runner: { run: () => no() } } satisfies GitClient;
  const probes: Array<[string, (client: GitClient) => unknown]> = [
    ["branch exists", (c) => gitBranchExists("/r", "x", c)],
    ["ref exists", (c) => gitRefExists("/r", "main", c)],
    ["detect repository", (c) => gitDetectRepository("/r", c)]
  ];
  expect(probes.map(([name, probe]) => [name, probeOutcome(() => probe(stalled))])).toEqual(probes.map(([name]) => [name, "did not answer"]));
  expect(probes.map(([name, probe]) => [name, probeOutcome(() => probe(said))])).toEqual([
    ["branch exists", "false"], ["ref exists", "false"], ["detect repository", JSON.stringify({ isGit: false, gitRemote: null })]
  ]);
  expect(probes.map(([name, probe]) => [name, probeOutcome(() => probe(missing))])).toEqual([
    ["branch exists", "false"], ["ref exists", "false"], ["detect repository", JSON.stringify({ isGit: false, gitRemote: null })]
  ]);
  // The remote is asked only once the directory is known to be a repository: not answering is unknown too.
  expect(probeOutcome(() => gitDetectRepository("/r", scriptedGit((args) => args.includes("config"))))).toBe("did not answer");
});

function makeApps(gitClient: GitClient) {
  const env = freshProjectEnv("md-git-unanswered-");
  const deps = {
    projects: env.projects, features: env.features, agentStore: env.agentStore, tmuxClient: env.tmux.client, gitClient, broadcast: () => {},
    paneRuntimes: buildPaneRuntimes({ tmuxClient: env.tmux.client, projectsStore: env.projects, featuresStore: env.features })
  };
  return { ...env, projectsApp: buildProjectsTestApp(deps), featuresApp: buildFeaturesTestApp(deps), gitApp: buildGitTestApp(deps) };
}

test("a project is not created or adopted when git does not answer whether its folder is a repository", async () => {
  const s = makeApps(scriptedGit((args) => args.includes("--git-dir")));
  try {
    const created = await postJson(s.projectsApp, "/api/projects", { name: "P", workingDir: tempDir("md-wd-") });
    expect([created.status, created.body.retryable]).toEqual([503, true]);
    tmuxNewSession("real", "/tmp", s.tmux.client);
    const adopted = await postJson(s.projectsApp, "/api/projects/adopt", { sessionName: "real", projectName: "Real", workingDir: tempDir("md-wd-") });
    expect([adopted.status, adopted.body.retryable]).toEqual([503, true]);
    expect(s.projects.listActive()).toEqual([]);
  } finally {
    s.cleanup();
  }
});

test("a worker is not made on a branch git did not answer about", async () => {
  const calls: string[][] = [];
  const s = makeApps(scriptedGit((args) => args.includes("show-ref"), calls));
  try {
    const wd = tempDir("md-wd-");
    const projectId = seedProject(s.projects, { isGit: true, workingDir: wd, tmuxSessionName: "md-g" });
    tmuxNewSession("md-g", wd, s.tmux.client);
    const r = await postJson(s.featuresApp, `/api/projects/${projectId}/features`, { name: "F", mode: "new-branch-new-worktree", branch: "feat-x", baseRef: "main" });
    expect([r.status, r.body.retryable]).toEqual([503, true]);
    expect(calls.some((a) => a.includes("worktree"))).toBe(false);
    expect(s.features.listActiveByProject(projectId)).toEqual([]);
  } finally {
    s.cleanup();
  }
});

test("archiving goes ahead when git does not answer whether the branch exists: the branch is left, and said so", async () => {
  const calls: string[][] = [];
  const s = makeApps(scriptedGit((args) => args.includes("show-ref"), calls));
  try {
    const wd = tempDir("md-wd-");
    const projectId = seedProject(s.projects, { isGit: true, workingDir: wd, tmuxSessionName: "md-g" });
    const featureId = seedFeature(s.features, projectId, { name: "F", mode: "existing-branch-existing-worktree", branch: "feat-x", worktreePath: wd, tmuxWindowName: "f" });
    const r = await deleteJson(s.featuresApp, `/api/features/${featureId}?confirmed=1&deleteBranch=1`);
    expect(r.status).toBe(200);
    expect(s.features.getById(featureId)!.archivedAt).toBeTruthy();
    expect(r.body.cleanupFailures).toEqual([expect.objectContaining({ kind: "branch", error: expect.stringContaining("did not answer") })]);
    expect(calls.some((a) => a.includes("branch") && (a.includes("-d") || a.includes("-D")))).toBe(false);
  } finally {
    s.cleanup();
  }
});

