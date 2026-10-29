import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GitClient } from "../src/server/platform/git/git.js";
import type { CommandResult } from "../src/server/platform/process/command-runner.js";
import type { LifecycleEvent } from "../src/server/runtime/events.js";
import { freshProjectEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { buildProjectsTestApp, patchJson } from "./helpers/test-app.js";
import { tempDir } from "./helpers/temp.js";

const ok = (stdout = ""): CommandResult => ({ status: 0, signal: null, stdout, stderr: "" });
const TIMED_OUT: CommandResult = {
  status: null, signal: "SIGTERM", stdout: "", stderr: "",
  error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" })
};
const no = (): CommandResult => ({ status: 1, signal: null, stdout: "", stderr: "" });
const REMOTE = "git@example.com:project-1.git";

/** Git as a test lays it out: the repository (common dir) each directory
 *  belongs to, the worktrees each repository lists as its own, and every
 *  call made. A repair links the worktrees it names to the repository it
 *  runs in. */
function layoutGit() {
  const repos = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const calls: string[][] = [];
  const stalls = { repair: false };
  const client: GitClient = {
    runner: {
      run(_bin, args) {
        calls.push(args);
        const [, dir, ...rest] = args;
        const repo = repos.get(dir!);
        switch (rest.join(" ")) {
          case "rev-parse --git-dir": return repo ? ok(".git\n") : no();
          case "config --get remote.origin.url": return repo ? ok(`${REMOTE}\n`) : no();
          case "rev-parse --git-common-dir": return repo ? ok(`${repo}\n`) : no();
          // As git writes them: a line per attribute, or with -z a NUL after each and between records.
          case "worktree list --porcelain": return repo ? ok([dir, ...(lists.get(dir!) ?? [])].map((p) => `worktree ${p}\nHEAD abc\n`).join("\n")) : no();
          case "worktree list --porcelain -z": return repo ? ok([dir, ...(lists.get(dir!) ?? [])].map((p) => `worktree ${p}\0HEAD abc\0\0`).join("")) : no();
        }
        if (rest[0] === "worktree" && rest[1] === "repair") {
          if (stalls.repair) return TIMED_OUT;
          for (const worktree of rest.slice(2)) if (repo) repos.set(worktree, repo);
          return ok();
        }
        return no();
      }
    }
  };
  return { client, repos, lists, calls, stalls };
}

let env: ReturnType<typeof freshProjectEnv> | null = null;
afterEach(() => { env?.cleanup(); env = null; });

function setup() {
  env = freshProjectEnv("md-project-workdir-");
  const git = layoutGit();
  const events: LifecycleEvent[] = [];
  const changed: Array<{ projectId: string; from: string; to: string }> = [];
  const app = buildProjectsTestApp({
    projects: env.projects, features: env.features, agentStore: env.agentStore, tmuxClient: env.tmux.client,
    gitClient: git.client, broadcast: (event) => events.push(event),
    onWorkingDirChanged: ({ project, from }) => changed.push({ projectId: project.id, from, to: project.workingDir })
  });
  return { env, git, events, changed, app };
}

test("a project's working directory moves to another directory: its git facts are read again, and the page and the conversations hear of it", async () => {
  const s = setup();
  const from = tempDir("md-wd-from-");
  const to = tempDir("md-wd-to-");
  const id = seedProject(s.env.projects, { name: "project-1", workingDir: from, tmuxSessionName: "md-project-1" });
  s.git.repos.set(to, "/repos/project-1/.git");
  const r = await patchJson(s.app, `/api/projects/${id}`, { workingDir: `  ${to}/ ` });
  expect(r.status).toBe(200);
  expect([r.body.workingDir, r.body.isGit, r.body.gitRemote]).toEqual([to, true, REMOTE]);
  const row = s.env.projects.getById(id)!;
  expect([row.workingDir, row.isGit, row.gitRemote, row.name, row.tmuxSessionName]).toEqual([to, true, REMOTE, "project-1", "md-project-1"]);
  expect(s.events.map((e) => [e.type, (e.data as { workingDir?: string }).workingDir])).toStrictEqual([["projectUpdated", to]]);
  expect(s.changed).toStrictEqual([{ projectId: id, from, to }]);
});

test("what cannot be a project's directory is refused and nothing changes; the directory it already has changes nothing", async () => {
  const s = setup();
  const from = tempDir("md-wd-from-");
  const id = seedProject(s.env.projects, { name: "project-1", workingDir: from });
  const file = path.join(tempDir("md-wd-file-"), "notes.txt");
  fs.writeFileSync(file, "x");
  const archived = seedProject(s.env.projects, { name: "project-2", workingDir: from, tmuxSessionName: "md-project-2" });
  s.env.projects.archive(archived);
  const cases: Array<[string, string, unknown, number, string]> = [
    ["relative", id, { workingDir: "code/project-1" }, 400, "Give the directory as an absolute path."],
    ["empty", id, { workingDir: "  " }, 400, "workingDir is required"],
    ["missing", id, { workingDir: path.join(from, "gone") }, 400, "That directory does not exist."],
    ["a file", id, { workingDir: file }, 400, "That is a file, not a directory."],
    ["unknown project", "proj_none", { workingDir: from }, 404, "project not found"],
    ["archived project", archived, { workingDir: from }, 404, "project not found"]
  ];
  for (const [name, projectId, body, status, error] of cases) {
    const r = await patchJson(s.app, `/api/projects/${projectId}`, body);
    expect([name, r.status, r.body.error]).toEqual([name, status, error]);
  }
  const same = await patchJson(s.app, `/api/projects/${id}`, { workingDir: from });
  expect([same.status, same.body.workingDir]).toEqual([200, from]);
  expect(s.env.projects.getById(id)!.workingDir).toBe(from);
  expect([s.events, s.changed]).toEqual([[], []]);
});

test("a worker whose worktree belongs to another repository refuses the change and is named; once it is archived the change goes through", async () => {
  const s = setup();
  const from = tempDir("md-wd-from-");
  const to = tempDir("md-wd-to-");
  const id = seedProject(s.env.projects, { name: "project-1", workingDir: from, isGit: true, gitRemote: REMOTE });
  const own = tempDir("md-wt-own-");
  const other = tempDir("md-wt-other-");
  s.git.repos.set(from, "/repos/project-1/.git").set(to, "/repos/project-1/.git").set(own, "/repos/project-1/.git").set(other, "/repos/project-9/.git");
  seedFeature(s.env.features, id, { name: "search", mode: "new-branch-new-worktree", branch: "search", worktreePath: own, tmuxWindowName: "search" });
  const elsewhere = seedFeature(s.env.features, id, { name: "billing", mode: "existing-branch-existing-worktree", branch: "billing", worktreePath: other, tmuxWindowName: "billing" });
  // In the project's directory, or with a worktree no longer on disk: nothing to check.
  seedFeature(s.env.features, id, { name: "docs", mode: "shared-cwd", tmuxWindowName: "docs" });
  seedFeature(s.env.features, id, { name: "gone", mode: "new-branch-new-worktree", branch: "gone", worktreePath: path.join(from, "no-such-worktree"), tmuxWindowName: "gone" });

  const refused = await patchJson(s.app, `/api/projects/${id}`, { workingDir: to });
  expect([refused.status, refused.body.error, refused.body.workers]).toEqual([
    409,
    `These workers' worktrees belong to another repository than ${to}: billing. Archive them first.`,
    [{ id: elsewhere, name: "billing" }]
  ]);
  expect(s.env.projects.getById(id)!.workingDir).toBe(from);
  // A directory that is no repository at all: every worktree is another repository's.
  const plain = tempDir("md-wd-plain-");
  expect((await patchJson(s.app, `/api/projects/${id}`, { workingDir: plain })).body.workers.map((w: { name: string }) => w.name).sort()).toEqual(["billing", "search"]);

  s.env.features.archive(elsewhere);
  const moved = await patchJson(s.app, `/api/projects/${id}`, { workingDir: to });
  expect([moved.status, s.env.projects.getById(id)!.workingDir]).toEqual([200, to]);
  // The old directory is still there: nothing was repaired.
  expect(s.git.calls.some((args) => args.includes("repair"))).toBe(false);
});

test("a project moved on disk: the worktrees its repository still lists are linked again from the new place", async () => {
  const s = setup();
  const from = path.join(tempDir("md-wd-old-"), "project-1");
  const to = tempDir("md-wd-to-");
  const id = seedProject(s.env.projects, { name: "project-1", workingDir: from, isGit: true, gitRemote: REMOTE });
  const worktree = tempDir("md-wt-");
  seedFeature(s.env.features, id, { name: "search", mode: "new-branch-new-worktree", branch: "search", worktreePath: worktree, tmuxWindowName: "search" });
  seedFeature(s.env.features, id, { name: "docs", mode: "shared-cwd", tmuxWindowName: "docs" });
  // Broken by the move: the worktree's link points where the project used
  // to be, and the moved repository still lists it as its own.
  s.git.repos.set(to, `${to}/.git`);
  s.git.lists.set(to, [worktree]);
  const r = await patchJson(s.app, `/api/projects/${id}`, { workingDir: to });
  expect([r.status, s.env.projects.getById(id)!.workingDir]).toEqual([200, to]);
  expect(s.git.calls.filter((args) => args.includes("repair"))).toStrictEqual([["-C", to, "worktree", "repair", worktree]]);
});

test("a worktree its repository lists under another name for the same directory (a link) is still its own", async () => {
  const s = setup();
  const from = path.join(tempDir("md-wd-old-"), "project-1");
  const to = tempDir("md-wd-to-");
  const id = seedProject(s.env.projects, { name: "project-1", workingDir: from, isGit: true, gitRemote: REMOTE });
  const worktree = tempDir("md-wt-");
  const alias = path.join(tempDir("md-wt-alias-"), "search");
  fs.symlinkSync(worktree, alias);
  seedFeature(s.env.features, id, { name: "search", mode: "new-branch-new-worktree", branch: "search", worktreePath: worktree, tmuxWindowName: "search" });
  s.git.repos.set(to, `${to}/.git`);
  s.git.lists.set(to, [alias]);
  const r = await patchJson(s.app, `/api/projects/${id}`, { workingDir: to });
  expect([r.status, s.git.calls.filter((args) => args.includes("repair"))]).toEqual([200, [["-C", to, "worktree", "repair", worktree]]]);
});

test("a broken worktree is linked only to a repository that lists it as its own; a refusal repairs nothing", async () => {
  const s = setup();
  const from = path.join(tempDir("md-wd-old-"), "project-1");
  const id = seedProject(s.env.projects, { name: "project-1", workingDir: from, isGit: true, gitRemote: REMOTE });
  const broken = tempDir("md-wt-broken-");
  const foreign = tempDir("md-wt-foreign-");
  seedFeature(s.env.features, id, { name: "search", mode: "new-branch-new-worktree", branch: "search", worktreePath: broken, tmuxWindowName: "search" });
  // Another repository, with a worktree of its own: it does not list ours.
  const unrelated = tempDir("md-wd-unrelated-");
  s.git.repos.set(unrelated, "/repos/project-9/.git");
  s.git.lists.set(unrelated, ["/srv/worktrees/project-9-search"]);
  const refused = await patchJson(s.app, `/api/projects/${id}`, { workingDir: unrelated });
  expect([refused.status, refused.body.workers.map((w: { name: string }) => w.name)]).toEqual([409, ["search"]]);
  // The moved repository lists it, but another worker is a third repository's: refused before anything is repaired.
  const to = tempDir("md-wd-to-");
  s.git.repos.set(to, `${to}/.git`).set(foreign, "/repos/project-7/.git");
  s.git.lists.set(to, [broken]);
  seedFeature(s.env.features, id, { name: "billing", mode: "existing-branch-existing-worktree", branch: "billing", worktreePath: foreign, tmuxWindowName: "billing" });
  const second = await patchJson(s.app, `/api/projects/${id}`, { workingDir: to });
  expect([second.status, second.body.workers.map((w: { name: string }) => w.name)]).toEqual([409, ["billing"]]);
  expect([s.git.calls.some((args) => args.includes("repair")), s.env.projects.getById(id)!.workingDir]).toEqual([false, from]);
});

test("a path another repository lists is ours only whole: one with a line break that reads like ours is not", async () => {
  const s = setup();
  const from = path.join(tempDir("md-wd-old-"), "project-1");
  const id = seedProject(s.env.projects, { name: "project-1", workingDir: from, isGit: true, gitRemote: REMOTE });
  const broken = tempDir("md-wt-broken-");
  seedFeature(s.env.features, id, { name: "search", mode: "new-branch-new-worktree", branch: "search", worktreePath: broken, tmuxWindowName: "search" });
  const unrelated = tempDir("md-wd-unrelated-");
  s.git.repos.set(unrelated, "/repos/project-9/.git");
  s.git.lists.set(unrelated, [`/srv/worktrees/odd\nworktree ${broken}`]);
  const r = await patchJson(s.app, `/api/projects/${id}`, { workingDir: unrelated });
  expect([r.status, s.git.calls.some((args) => args.includes("repair"))]).toEqual([409, false]);
});

test("a directory is kept as it is named: \"..\" after a link is the filesystem's to follow, not the name's", async () => {
  const s = setup();
  const id = seedProject(s.env.projects, { name: "project-1", workingDir: tempDir("md-wd-from-") });
  const a = tempDir("md-wd-a-");
  const b = tempDir("md-wd-b-");
  fs.mkdirSync(path.join(a, "app"));
  fs.symlinkSync(path.join(a, "app"), path.join(b, "link"));
  const named = path.join(b, "link") + "/..";
  const r = await patchJson(s.app, `/api/projects/${id}`, { workingDir: `${named}/` });
  expect([r.status, s.env.projects.getById(id)!.workingDir]).toEqual([200, named]);
  // The directory the system finds there (a realpath here reads ".." by name too).
  expect([fs.statSync(named).dev, fs.statSync(named).ino]).toEqual([fs.statSync(a).dev, fs.statSync(a).ino]);
});

test("a repository whose directory differs only by a trailing space is another repository", async () => {
  const s = setup();
  const id = seedProject(s.env.projects, { name: "project-1", workingDir: tempDir("md-wd-from-"), isGit: true, gitRemote: REMOTE });
  const worktree = tempDir("md-wt-");
  seedFeature(s.env.features, id, { name: "search", mode: "new-branch-new-worktree", branch: "search", worktreePath: worktree, tmuxWindowName: "search" });
  const to = tempDir("md-wd-to-");
  // Separate git directories: one's name ends in a space.
  s.git.repos.set(worktree, "/repos/meta").set(to, "/repos/meta ");
  expect((await patchJson(s.app, `/api/projects/${id}`, { workingDir: to })).status).toBe(409);
});

test("a repair git does not finish in time leaves the worktree as the move broke it; the change, its repository settled, stands", async () => {
  const s = setup();
  const from = path.join(tempDir("md-wd-old-"), "project-1");
  const to = tempDir("md-wd-to-");
  const id = seedProject(s.env.projects, { name: "project-1", workingDir: from, isGit: true, gitRemote: REMOTE });
  const worktree = tempDir("md-wt-");
  seedFeature(s.env.features, id, { name: "search", mode: "new-branch-new-worktree", branch: "search", worktreePath: worktree, tmuxWindowName: "search" });
  s.git.repos.set(to, `${to}/.git`);
  s.git.lists.set(to, [worktree]);
  s.git.stalls.repair = true;
  const r = await patchJson(s.app, `/api/projects/${id}`, { workingDir: to });
  expect([r.status, s.env.projects.getById(id)!.workingDir]).toEqual([200, to]);
});

test("a directory stored with a trailing slash is the same directory without it: nothing changes, nobody is told", async () => {
  const s = setup();
  const dir = tempDir("md-wd-slash-");
  const id = seedProject(s.env.projects, { name: "project-1", workingDir: `${dir}/` });
  const r = await patchJson(s.app, `/api/projects/${id}`, { workingDir: dir });
  expect([r.status, s.env.projects.getById(id)!.workingDir, s.events, s.changed]).toEqual([200, `${dir}/`, [], []]);
});
