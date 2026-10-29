import { expect, test } from "bun:test";
import fs from "node:fs";
import { freshProjectEnv, seedProject } from "../tests/helpers/fixtures.js";
import { onCleanup } from "../tests/helpers/cleanup.js";
import { git, nextSecond, repoWithWorktree } from "./helpers/git-repo.js";
import { FeatureService } from "../src/server/modules/features/feature-service.js";
import { buildPaneRuntimes } from "../src/server/runtime/pane-runtime-registry.js";
import { nodeCommandRunner, type CommandRunner } from "../src/server/platform/process/command-runner.js";

// Archiving a worker also deletes the branches it made in its own worktree
// (an MR's, say) once they are merged, by git's own records only; a branch
// made anywhere else stays, even one the worker checked out.

const branches = (repo: string) => git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").filter(Boolean).sort();

async function workerWithBranches() {
  const env = freshProjectEnv("md-archive-worker-branches-");
  onCleanup(() => env.cleanup());
  const { repo, worktree } = repoWithWorktree("research/x");
  const projectId = seedProject(env.projects, { name: "project-1", workingDir: repo, isGit: true, tmuxSessionName: "md-project-1" });
  const featureId = env.features.insert({
    projectId, name: "export", mode: "new-branch-new-worktree", branch: "research/x", worktreePath: worktree,
    tmuxWindowName: "export", ownership: "app", baseRef: "main"
  });
  // The owner's branch, made in their own checkout while the worker runs, merged.
  await nextSecond();
  git(repo, ["branch", "owner-merged"]);
  await nextSecond();
  // The worker reads it, then makes its MR branch, merged into main.
  git(worktree, ["checkout", "-q", "owner-merged"]);
  git(worktree, ["checkout", "-q", "-b", "fix/merged"]);
  git(worktree, ["commit", "-q", "--allow-empty", "-m", "the fix"]);
  git(repo, ["merge", "-q", "--ff-only", "fix/merged"]);
  await nextSecond();
  // And a second one, not merged.
  git(worktree, ["checkout", "-q", "-b", "fix/open"]);
  git(worktree, ["commit", "-q", "--allow-empty", "-m", "still in review"]);
  const service = new FeatureService({
    projects: env.projects, features: env.features, tmuxClient: env.tmux.client,
    paneRuntimes: buildPaneRuntimes({ tmuxClient: env.tmux.client, projectsStore: env.projects, featuresStore: env.features })
  });
  return { env, repo, worktree, featureId, projectId, service };
}

test("archiving deletes the merged branches the worker made in its worktree, and only those", async () => {
  const w = await workerWithBranches();
  const result = await w.service.archive({ id: w.featureId, confirmed: true });
  expect(result.ok).toBe(true);
  // research/x (Mandate's) and fix/merged (the worker's, merged) go; the
  // owner's branch stays though the worker checked it out; fix/open is not
  // merged, so a safe delete refuses it and says so.
  expect(branches(w.repo)).toEqual(["fix/open", "main", "owner-merged"]);
  expect(result.ok && result.cleanupFailures?.map((f) => (f.kind === "branch" ? f.branch : f.kind))).toEqual(["fix/open"]);
}, 20_000);

test("archiving that keeps branches keeps the worker's too", async () => {
  const w = await workerWithBranches();
  const result = await w.service.archive({ id: w.featureId, confirmed: true, cleanup: { deleteBranch: false } });
  expect(result.ok).toBe(true);
  expect(branches(w.repo)).toEqual(["fix/merged", "fix/open", "main", "owner-merged", "research/x"]);
}, 20_000);

// An archived worker's worktree can outlive a move of its project to another
// repository; archiving again then reads that worktree but deletes in the
// project's folder. Branches are deleted only in the worktree's own
// repository.
test("a worktree of another repository than the project's deletes nothing there", async () => {
  const w = await workerWithBranches();
  const other = git(w.repo, ["rev-parse", "--show-toplevel"]) + "-other";
  fs.mkdirSync(other);
  onCleanup(() => fs.rmSync(other, { recursive: true, force: true }));
  git(other, ["init", "-q", "-b", "main"]);
  git(other, ["commit", "-q", "--allow-empty", "-m", "init"]);
  git(other, ["branch", "fix/merged"]);
  git(other, ["branch", "research/x"]);
  w.env.store.db.prepare("update projects set working_dir = ? where id = ?").run(other, w.projectId);
  const result = await w.service.archive({ id: w.featureId, confirmed: true });
  expect(result.ok).toBe(true);
  expect(branches(other)).toEqual(["fix/merged", "main", "research/x"]);
  // The worktree stays, so a second archive still sees whose it is.
  expect(fs.existsSync(w.worktree)).toBe(true);
  const again = await w.service.archive({ id: w.featureId, confirmed: true });
  expect(again.ok).toBe(true);
  expect(branches(other)).toEqual(["fix/merged", "main", "research/x"]);
}, 30_000);

// A name found before the worktree goes may be another branch by the time it
// is deleted: the owner deleted it and made their own.
const serviceWithGit = (w: Awaited<ReturnType<typeof workerWithBranches>>, run: CommandRunner["run"]) => new FeatureService({
  projects: w.env.projects, features: w.env.features, tmuxClient: w.env.tmux.client,
  paneRuntimes: buildPaneRuntimes({ tmuxClient: w.env.tmux.client, projectsStore: w.env.projects, featuresStore: w.env.features }),
  gitClient: { runner: { run } }
});

test("a branch made again under the same name while the worktree is removed is kept", async () => {
  const w = await workerWithBranches();
  const real = nodeCommandRunner;
  const service = serviceWithGit(w, (command, args, options) => {
      const result = real.run(command, args, options);
      if (args.includes("worktree") && args.includes("remove")) {
        // The owner's own fix/merged, on the very commit the worker's was
        // made from: only its moment differs.
        git(w.repo, ["branch", "-D", "fix/merged"]);
        git(w.repo, ["branch", "fix/merged", "owner-merged"]);
      }
      return result;
  });
  const result = await service.archive({ id: w.featureId, confirmed: true });
  expect(result.ok).toBe(true);
  expect(branches(w.repo)).toEqual(["fix/merged", "fix/open", "main", "owner-merged"]);
}, 30_000);

// The re-check reads the whole record again, not only the first entry: a
// branch moved from elsewhere while the worktree goes is kept.
test("a branch changed from outside while the worktree is removed is kept", async () => {
  const w = await workerWithBranches();
  const real = nodeCommandRunner;
  const service = serviceWithGit(w, (command, args, options) => {
    const result = real.run(command, args, options);
    if (args.includes("worktree") && args.includes("remove")) git(w.repo, ["branch", "-f", "fix/merged", "owner-merged"]);
    return result;
  });
  const result = await service.archive({ id: w.featureId, confirmed: true });
  expect(result.ok).toBe(true);
  expect(branches(w.repo)).toEqual(["fix/merged", "fix/open", "main", "owner-merged"]);
}, 30_000);

// The re-check reads git's expiry again: a setting that lets gc clear
// sooner, made while the worktree goes, keeps the branch.
test("a sooner reflog expiry set while the worktree is removed keeps the branch", async () => {
  const w = await workerWithBranches();
  const real = nodeCommandRunner;
  const service = serviceWithGit(w, (command, args, options) => {
    const result = real.run(command, args, options);
    if (args.includes("worktree") && args.includes("remove")) git(w.repo, ["config", "gc.reflogExpireUnreachable", "now"]);
    return result;
  });
  const result = await service.archive({ id: w.featureId, confirmed: true });
  expect(result.ok).toBe(true);
  expect(branches(w.repo)).toEqual(["fix/merged", "fix/open", "main", "owner-merged"]);
}, 30_000);

// Git before 2.31 does not know --path-format and prints it back as a line
// of output: the common case must still clean up.
test("archiving with a git older than --path-format still deletes the worker's merged branch", async () => {
  const w = await workerWithBranches();
  const real = nodeCommandRunner;
  const service = serviceWithGit(w, (command, args, options) => {
    if (!args.includes("--path-format=absolute")) return real.run(command, args, options);
    const result = real.run(command, args.filter((arg) => arg !== "--path-format=absolute"), options);
    return { ...result, stdout: `--path-format=absolute\n${String(result.stdout)}` };
  });
  const result = await service.archive({ id: w.featureId, confirmed: true });
  expect(result.ok).toBe(true);
  expect(fs.existsSync(w.worktree)).toBe(false);
  expect(branches(w.repo)).toEqual(["fix/open", "main", "owner-merged"]);
}, 30_000);

