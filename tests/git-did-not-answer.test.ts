import { expect, test } from "bun:test";
import {
  gitBranchExists,
  gitDetectRepository,
  gitRefExists,
  type GitClient
} from "../src/server/platform/git/git.js";
import { CommandDidNotAnswerError, type CommandResult } from "../src/server/platform/process/command-runner.js";
import { tmuxNewSession } from "../src/server/platform/tmux/tmux.js";
import { TmuxRuntime } from "../src/server/runtime/runtimes/tmux-runtime.js";
import { freshProjectEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { buildWorkersTestApp, buildGitTestApp, buildProjectsTestApp, deleteJson, postJson } from "./helpers/test-app.js";
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
      async run(_command, args) {
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

async function probeOutcome(probe: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify(await probe());
  } catch (err) {
    return err instanceof CommandDidNotAnswerError ? "did not answer" : String(err);
  }
}

test("the git probes throw when git does not answer, answer no when it says no, and treat no git at all as no", async () => {
  const stalled = scriptedGit(() => true);
  const missing: GitClient = { runner: { run: async () => NOT_INSTALLED } };
  const said = { runner: { run: async () => no() } } satisfies GitClient;
  const probes: Array<[string, (client: GitClient) => Promise<unknown>]> = [
    ["branch exists", (c) => gitBranchExists("/r", "x", c)],
    ["ref exists", (c) => gitRefExists("/r", "main", c)],
    ["detect repository", (c) => gitDetectRepository("/r", c)]
  ];
  const outcomes = (client: GitClient) => Promise.all(probes.map(async ([name, probe]) => [name, await probeOutcome(() => probe(client))]));
  expect(await outcomes(stalled)).toEqual(probes.map(([name]) => [name, "did not answer"]));
  expect(await outcomes(said)).toEqual([
    ["branch exists", "false"], ["ref exists", "false"], ["detect repository", JSON.stringify({ isGit: false, gitRemote: null })]
  ]);
  expect(await outcomes(missing)).toEqual([
    ["branch exists", "false"], ["ref exists", "false"], ["detect repository", JSON.stringify({ isGit: false, gitRemote: null })]
  ]);
  // The remote is asked only once the directory is known to be a repository: not answering is unknown too.
  expect(await probeOutcome(() => gitDetectRepository("/r", scriptedGit((args) => args.includes("config"))))).toBe("did not answer");
});

function makeApps(gitClient: GitClient) {
  const env = freshProjectEnv("md-git-unanswered-");
  const deps = {
    projects: env.projects, workers: env.workers, agentStore: env.agentStore, tmuxClient: env.tmux.client, gitClient, broadcast: () => {},
    tmuxRuntime: new TmuxRuntime({ tmuxClient: env.tmux.client, projectsStore: env.projects, workersStore: env.workers })
  };
  return { ...env, projectsApp: buildProjectsTestApp(deps), workersApp: buildWorkersTestApp(deps), gitApp: buildGitTestApp(deps) };
}

test("a project is not created when git does not answer whether its folder is a repository", async () => {
  const s = makeApps(scriptedGit((args) => args.includes("--git-dir")));
  const created = await postJson(s.projectsApp, "/api/projects", { name: "P", workingDir: tempDir("md-wd-") });
  expect(created.status).toBe(503);
  expect(s.projects.listActive()).toEqual([]);
});

test("a worker is not made on a branch git did not answer about", async () => {
  const calls: string[][] = [];
  const s = makeApps(scriptedGit((args) => args.includes("show-ref"), calls));
  const wd = tempDir("md-wd-");
  const projectId = seedProject(s.projects, { isGit: true, workingDir: wd, tmuxSessionName: "md-g" });
  await tmuxNewSession("md-g", wd, s.tmux.client);
  const r = await postJson(s.workersApp, `/api/projects/${projectId}/workers`, { name: "F", mode: "new-branch-new-worktree", branch: "feat-x", baseRef: "main" });
  expect(r.status).toBe(503);
  expect(calls.some((a) => a.includes("worktree"))).toBe(false);
  expect(s.workers.listActiveByProject(projectId)).toEqual([]);
});

test("archiving goes ahead when git does not answer whether the branch exists: the branch is left, and said so", async () => {
  const calls: string[][] = [];
  const s = makeApps(scriptedGit((args) => args.includes("show-ref"), calls));
  const wd = tempDir("md-wd-");
  const projectId = seedProject(s.projects, { isGit: true, workingDir: wd, tmuxSessionName: "md-g" });
  const workerId = seedWorker(s.workers, projectId, { name: "F", mode: "existing-branch-existing-worktree", branch: "feat-x", worktreePath: wd, tmuxWindowName: "f" });
  const r = await deleteJson(s.workersApp, `/api/workers/${workerId}?confirmed=1&deleteBranch=1`);
  expect(r.status).toBe(200);
  expect(s.workers.getById(workerId)!.archivedAt).toBeTruthy();
  expect(r.body.cleanupFailures).toEqual([expect.objectContaining({ kind: "branch", error: expect.stringContaining("did not answer") })]);
  expect(calls.some((a) => a.includes("branch") && (a.includes("-d") || a.includes("-D")))).toBe(false);
});

