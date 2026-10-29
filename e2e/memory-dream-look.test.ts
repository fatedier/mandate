import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createMockLLM } from "../tests/helpers/mock-llm.js";
import { freshStoresEnv, seedFeature, seedProject } from "../tests/helpers/fixtures.js";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { MemoryManager } from "../src/server/modules/memory/manager.js";
import { MemoryDreamer } from "../src/server/modules/memory/dream.js";
import { whereWorkIs } from "../src/server/modules/memory/dream-places.js";
import type { ShellCommandRunner } from "../src/server/platform/process/shell-command-runner.js";
import { nodeCommandRunner } from "../src/server/platform/process/command-runner.js";
import type { GitClient } from "../src/server/platform/git/git.js";
import { tempDir } from "../tests/helpers/temp.js";
import { FeatureRecordStore } from "../src/server/modules/plans/record-store.js";

// A dream looks at a project's files where its work is, with the shell and
// read; it is told where that is and how new each place is.

const NOW = Date.parse("2026-10-18T12:00:00Z");

function git(dir: string, args: string[], date?: string) {
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
    ...(date ? { GIT_AUTHOR_DATE: `${date}T10:00:00Z`, GIT_COMMITTER_DATE: `${date}T10:00:00Z` } : {}) };
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

function commit(dir: string, file: string, date: string) {
  fs.writeFileSync(path.join(dir, file), `${file} ${date}\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", file], date);
}

/** A clone of a repository with master and dev, a worker branch only local,
 *  one only on the remote, and an old one. Made once for the file (some
 *  twenty git commands); each test changes a copy of its own. */
let template: { root: string; work: string } | null = null;
beforeAll(() => { template = buildRepo(); });
afterAll(() => { if (template) fs.rmSync(template.root, { recursive: true, force: true }); });

function repo() {
  const work = path.join(tempDir("md-look-work-"), "work");
  fs.cpSync(template!.work, work, { recursive: true });
  return work;
}

function buildRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "md-look-template-"));
  const dir = (name: string) => { const d = path.join(root, name); fs.mkdirSync(d); return d; };
  const origin = dir("origin");
  git(origin, ["init", "-q", "--bare", "-b", "master"]);
  const seed = dir("seed");
  git(seed, ["init", "-q", "-b", "master"]);
  commit(seed, "a.txt", "2026-10-10");
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "-q", "origin", "master"]);
  git(seed, ["checkout", "-q", "-b", "dev"]);
  commit(seed, "dev.txt", "2026-10-15");
  git(seed, ["push", "-q", "origin", "dev"]);
  git(seed, ["checkout", "-q", "-b", "feature-b", "master"]);
  commit(seed, "b.txt", "2026-09-30");
  git(seed, ["push", "-q", "origin", "feature-b"]);
  const work = path.join(root, "work");
  spawnSync("git", ["clone", "-q", origin, work], { encoding: "utf8" });
  git(work, ["checkout", "-q", "-b", "feature-a", "origin/master"]);
  commit(work, "fa.txt", "2026-10-12");
  git(work, ["checkout", "-q", "-b", "old-branch", "origin/master"]);
  commit(work, "old.txt", "2026-07-30");
  git(work, ["checkout", "-q", "master"]);
  return { root, work };
}

test("where the work is: the default branch, where workers start, recent workers' branches and the folder, newest first", () => {
  const env = freshStoresEnv("md-look-places-");
  const work = repo();
  const projectId = seedProject(env.projects, { name: "p", workingDir: work, isGit: true, tmuxSessionName: "md-look" });
  const add = (name: string, branch: string | null, baseRef: string | null) =>
    seedFeature(env.features, projectId, { name, mode: "new-branch-new-worktree", branch, baseRef, tmuxWindowName: name.toLowerCase().replace(/ /g, "-") });
  add("Feature A", "feature-a", "origin/dev");
  const b = add("Feature B", "feature-b", "origin/dev");
  const old = add("Old work", "old-branch", "origin/master");
  // A base recorded as a commit (one that exists) is a point in time, not a place.
  add("Pinned to a commit", null, git(work, ["rev-parse", "origin/master"]));
  add("Gone branch", "deleted-long-ago", "origin/dev");
  env.store.db.prepare("update features set archived_at = ? where id = ?").run("2026-10-01T09:00:00Z", b);
  env.store.db.prepare("update features set archived_at = ? where id = ?").run("2026-08-01T09:00:00Z", old);
  expect(whereWorkIs({ workingDir: work, features: env.features.listByProject(projectId), now: NOW })).toBe([
    "## Where the work is (as it is on this machine; nothing is fetched)",
    "Look at the files in these places with the shell (git show, git grep, git log on the branch); go by the newest.",
    "- origin/dev: where this project's workers start their branches; last commit 2026-10-15",
    "- feature-a: worker \"Feature A\" (active); last commit 2026-10-12",
    "- origin/master: the default branch; last commit 2026-10-10",
    `- the working directory (${work}), on master: workers without a branch work here; last commit 2026-10-10`,
    "- origin/feature-b: worker \"Feature B\" (archived 2026-10-01); last commit 2026-09-30"
  ].join("\n"));
});

test("where the work is: a branch a tag shares its name with is listed by a name that means the branch", () => {
  const env = freshStoresEnv("md-look-tag-");
  const work = repo();
  // A tag on an older commit, named as the worker's branch.
  git(work, ["tag", "feature-a", "origin/master"]);
  const projectId = seedProject(env.projects, { name: "p", workingDir: work, isGit: true, tmuxSessionName: "md-look" });
  seedFeature(env.features, projectId, { name: "Feature A", mode: "new-branch-new-worktree", branch: "feature-a", tmuxWindowName: "fa" });
  const listed = whereWorkIs({ workingDir: work, features: env.features.listByProject(projectId), now: NOW });
  expect(listed).toContain("- heads/feature-a: worker \"Feature A\" (active); last commit 2026-10-12");
});

test("where the work is: one branch written two ways is one place; a base that is a commit, short or not, is none", () => {
  const env = freshStoresEnv("md-look-same-");
  const work = repo();
  git(work, ["branch", "dev", "origin/dev"]);
  const projectId = seedProject(env.projects, { name: "p", workingDir: work, isGit: true, tmuxSessionName: "md-look" });
  seedFeature(env.features, projectId, { name: "On dev", mode: "existing-branch-new-worktree", branch: "dev", baseRef: "refs/heads/dev", tmuxWindowName: "on-dev" });
  seedFeature(env.features, projectId, { name: "Short base", mode: "shared-cwd", branch: null, baseRef: git(work, ["rev-parse", "--short", "origin/dev"]), tmuxWindowName: "short" });
  // A tag is a point in time; a name that is only a prefix of branches is no branch.
  git(work, ["tag", "v0.1", "origin/dev"]);
  seedFeature(env.features, projectId, { name: "Tag base", mode: "shared-cwd", branch: null, baseRef: "refs/tags/v0.1", tmuxWindowName: "tag" });
  seedFeature(env.features, projectId, { name: "Remote base", mode: "shared-cwd", branch: null, baseRef: "origin", tmuxWindowName: "remote" });
  const listed = whereWorkIs({ workingDir: work, features: env.features.listByProject(projectId), now: NOW }).split("\n");
  expect(listed.filter((line) => line.startsWith("- dev:"))).toEqual([
    "- dev: where this project's workers start their branches; worker \"On dev\" (active); last commit 2026-10-15"
  ]);
  expect(listed.filter((line) => line.startsWith("- "))).toHaveLength(3);
});

test("where the work is: a base named by an alias (origin/HEAD) is the branch it points to", () => {
  const env = freshStoresEnv("md-look-alias-");
  const work = repo();
  const projectId = seedProject(env.projects, { name: "p", workingDir: work, isGit: true, tmuxSessionName: "md-look" });
  seedFeature(env.features, projectId, { name: "From the default", mode: "shared-cwd", branch: null, baseRef: "origin/HEAD", tmuxWindowName: "alias" });
  const listed = whereWorkIs({ workingDir: work, features: env.features.listByProject(projectId), now: NOW }).split("\n");
  expect(listed.filter((line) => line.startsWith("- origin"))).toEqual([
    "- origin/master: the default branch; where this project's workers start their branches; last commit 2026-10-10"
  ]);
});

test("where the work is: a day is a day even when the user's git shows signatures", () => {
  const work = repo();
  // As log.showSignature=true prints a signed commit's check before its line.
  const signing: GitClient = { runner: { run: (command, args, options) => {
    const r = nodeCommandRunner.run(command, args, options);
    return args.includes("log") && !args.includes("--no-show-signature") ? { ...r, stdout: `Good "git" signature for t with ED25519 key\n2026-01-01\n${r.stdout}` } : r;
  } } };
  expect(whereWorkIs({ workingDir: work, features: [], now: NOW, git: signing })).toContain(
    `- the working directory (${work}), on master: workers without a branch work here; last commit 2026-10-10`
  );
});

test("where the work is: a bare repository lists its branches, and has no working directory", () => {
  const env = freshStoresEnv("md-look-bare-");
  const work = repo();
  const bare = path.join(tempDir("md-look-bare-dir-"), "bare.git");
  spawnSync("git", ["clone", "-q", "--bare", work, bare], { encoding: "utf8" });
  const projectId = seedProject(env.projects, { name: "p", workingDir: bare, isGit: true, tmuxSessionName: "md-look" });
  seedFeature(env.features, projectId, { name: "Worker", mode: "new-branch-new-worktree", branch: "feature-a", baseRef: "master", tmuxWindowName: "w" });
  expect(whereWorkIs({ workingDir: bare, features: env.features.listByProject(projectId), now: NOW })).toBe([
    "## Where the work is (as it is on this machine; nothing is fetched)",
    "Look at the files in these places with the shell (git show, git grep, git log on the branch); go by the newest.",
    "- feature-a: worker \"Worker\" (active); last commit 2026-10-12",
    "- master: the default branch; where this project's workers start their branches; last commit 2026-10-10"
  ].join("\n"));
});

test("where the work is: a git that does not answer leaves the folder, and a run goes on without the list", async () => {
  const env = freshStoresEnv("md-look-slow-");
  const work = repo();
  const silent = { status: null, signal: null, stdout: "", stderr: "", error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) };
  const slowRefs: GitClient = { runner: { run: (command, args, options) => args.includes("for-each-ref") || args.includes("symbolic-ref") ? silent : nodeCommandRunner.run(command, args, options) } };
  expect(whereWorkIs({ workingDir: work, features: [], now: NOW, git: slowRefs })).toBe([
    "## Where the work is (as it is on this machine; nothing is fetched)",
    "Look at the files in these places with the shell (git show, git grep, git log on the branch); go by the newest.",
    `- the working directory (${work}), on master: workers without a branch work here; last commit 2026-10-10`
  ].join("\n"));
  // Whatever goes wrong reading git, the run itself goes on.
  const broken: GitClient = { runner: { run: () => { throw new Error("git exploded"); } } };
  const projectId = seedProject(env.projects, { name: "p", workingDir: work, isGit: true, tmuxSessionName: "md-look" });
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
  await memory.remember({ scope: "project", projectId, type: "knowledge", source: "agent", content: "A fact." });
  const model = createMockLLM([{ toolCalls: [{ toolCallId: "c1", toolName: "write_brief", args: { content: "p: memory." } }], finishReason: "tool-calls" }]);
  const dreamer = new MemoryDreamer({ contextLimitTokens: 200_000, db: env.store.db, records: new FeatureRecordStore(env.store.db), memory, agentStore: env.agentStore, projectsStore: env.projects, featuresStore: env.features, model, provider: "openai", maxSteps: 1, git: broken, shellRunner: recordingRunner("").runner });
  expect(await dreamer.run("manual", { kind: "project", projectId })).toMatchObject({ status: "succeeded" });
  expect(JSON.stringify(model.streamCalls[0]?.prompt)).not.toContain("## Where the work is");
});

test("where the work is: a folder that is not a git repository has one version", () => {
  const plain = tempDir("md-look-plain-");
  expect(whereWorkIs({ workingDir: plain, features: [], now: NOW })).toBe([
    "## Where the work is",
    `- the project's folder: ${plain} (not a git repository: one version only)`
  ].join("\n"));
});

function recordingRunner(stdout: string) {
  const calls: Array<{ command: string; cwd: string }> = [];
  const runner: ShellCommandRunner = {
    spawn: async () => null,
    run: async (command, options) => {
      calls.push({ command, cwd: options.cwd });
      return { stdout, stderr: "", exitCode: 0, timedOut: false };
    }
  };
  return { runner, calls };
}

function setup(stdout = "a1b2c3 rename watch_window to monitor") {
  const env = freshStoresEnv("md-look-env-");
  const dir = tempDir("md-look-dir-");
  const projectId = seedProject(env.projects, { name: "project-1", workingDir: dir, tmuxSessionName: "md-p1" });
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
  const shell = recordingRunner(stdout);
  const dreamer = (model: ReturnType<typeof createMockLLM>, maxSteps = 2) => new MemoryDreamer({ contextLimitTokens: 200_000,
    db: env.store.db, records: new FeatureRecordStore(env.store.db), memory, agentStore: env.agentStore, projectsStore: env.projects, featuresStore: env.features,
    model, provider: "openai", maxSteps, shellRunner: shell.runner
  });
  return { env, dir, projectId, memory, shell, dreamer };
}

test("a project run is told where the work is, and looks with the shell in the project's folder", async () => {
  const t = setup();
  try {
    await t.memory.remember({ scope: "project", projectId: t.projectId, type: "knowledge", source: "agent", content: "The watch tool is watch_window." });
    const model = createMockLLM([
      { toolCalls: [{ toolCallId: "c0", toolName: "bash", args: { command: "git log -S watch_window --oneline" } }], finishReason: "tool-calls" },
      { toolCalls: [{ toolCallId: "c1", toolName: "write_brief", args: { content: "project-1: memory." } }], finishReason: "tool-calls" }
    ]);
    expect(await t.dreamer(model).run("manual", { kind: "project", projectId: t.projectId })).toMatchObject({ status: "succeeded" });
    const opening = JSON.stringify(model.streamCalls[0]?.prompt);
    expect(opening).toContain(`- the project's folder: ${t.dir} (not a git repository: one version only)`);
    const tools = JSON.stringify(model.streamCalls[0]?.tools);
    expect(tools).toContain("\"bash\"");
    expect(tools).toContain("\"read\"");
    expect(tools).not.toContain("search_code");
    expect(t.shell.calls).toStrictEqual([{ command: "git log -S watch_window --oneline", cwd: t.dir }]);
    expect(JSON.stringify(model.streamCalls[1]?.prompt)).toContain("rename watch_window to monitor");
  } finally {
    t.env.cleanup();
  }
});

test("a run of the user's memories is given every project's folder", async () => {
  const t = setup();
  try {
    await t.memory.remember({ scope: "user", type: "preference", source: "agent", content: "Keep replies short." });
    const model = createMockLLM([
      { toolCalls: [{ toolCallId: "c1", toolName: "write_brief", args: { content: "The user's memory." } }], finishReason: "tool-calls" }
    ]);
    await t.dreamer(model, 1).run("manual", { kind: "user" });
    const opening = JSON.stringify(model.streamCalls[0]?.prompt);
    expect(opening).toContain(`## The projects' folders\\n- project-1: ${t.dir}`);
  } finally {
    t.env.cleanup();
  }
});

test("a long shell output reaches the model as an agent's would: saved to a file, its first 2,000 characters shown", async () => {
  const t = setup("x".repeat(30_000));
  try {
    await t.memory.remember({ scope: "project", projectId: t.projectId, type: "knowledge", source: "agent", content: "A fact." });
    const model = createMockLLM([
      { toolCalls: [{ toolCallId: "c0", toolName: "bash", args: { command: "cat big.log" } }], finishReason: "tool-calls" },
      { toolCalls: [{ toolCallId: "c1", toolName: "write_brief", args: { content: "project-1: memory." } }], finishReason: "tool-calls" }
    ]);
    await t.dreamer(model).run("manual", { kind: "project", projectId: t.projectId });
    const seen = JSON.stringify(model.streamCalls[1]?.prompt);
    expect(seen).toContain("<persisted-output>\\nOutput too large (");
    expect(seen).toContain("Preview (first 2,000 characters):");
    expect(seen).not.toContain("x".repeat(2_001));
  } finally {
    t.env.cleanup();
  }
});

