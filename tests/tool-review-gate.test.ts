import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "../src/server/config.js";
import { DEFAULT_CONFIG } from "../src/server/config/defaults.js";
import { AgentLlmCallRecorder } from "../src/server/modules/activity/llm-call-recorder.js";
import type { AgentScope } from "../src/server/modules/agent/tool-scope.js";
import type { ToolCallSpec } from "../src/server/modules/agent/wake-loop.js";
import { HandoffStore } from "../src/server/modules/personal/handoff-store.js";
import { resolveDataDir } from "../src/server/platform/fs/data-dir.js";
import type { JudgementCandidate } from "../src/server/modules/manager-checks/judge.js";
import { reviewKind, ToolReviewGate, type ReviewKindDeps } from "../src/server/modules/tool-review/gate.js";
import { ToolReviewStreaks } from "../src/server/modules/tool-review/streak-store.js";
import { REVIEW_UNAVAILABLE } from "../src/server/modules/tool-review/reviewer.js";
import { freshStoresEnv, seedWorker, seedProject, type StoresEnv } from "./helpers/fixtures.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { workerScope } from "./helpers/typed.js";

// What is reviewed is decided by what each tool can do: bash unless the fast
// path recognises it, keys typed into a pane, a monitor's command, a write
// outside the scope's roots or to a file something runs, an archive that
// deletes. The rest runs as it always has.

let env: StoresEnv;
let root: string;
beforeEach(() => {
  env = freshStoresEnv("md-tool-review-gate-");
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "md-gate-")));
  for (const dir of ["shop/.git", "shop-fix/.git", "shop-fix/src", "notes"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
});
afterEach(() => {
  env.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

const call = (toolName: string, args: unknown, id = "c1"): ToolCallSpec => ({ toolCallId: id, toolName, args });
const worker = (): AgentScope => ({ kind: "worker", worker: { workingDir: path.join(root, "shop-fix") }, project: { workingDir: path.join(root, "shop") } });
const manager = (): AgentScope => ({ kind: "manager", managerDir: path.join(root, "notes"), projectWorkingDirs: [path.join(root, "shop")] });
const kindDeps = (overrides: Partial<ReviewKindDeps> = {}): ReviewKindDeps => ({
  thread: "worker",
  registeredRepos: [path.join(root, "shop"), path.join(root, "shop-fix")],
  workers: env.workers,
  home: path.join(root, "home"),
  dataDir: path.join(root, "data"),
  // The fixtures live in a temp dir, which is scratch: none here, so roots are what is tested.
  scratch: [],
  ...overrides
});

test("a read-only bash call runs without a review", async () => {
  expect(await reviewKind(call("bash", { command: "git status --porcelain" }), worker(), kindDeps())).toEqual({ kind: "skip" });
  expect(await reviewKind(call("bash", { command: "rm -rf build" }), worker(), kindDeps())).toEqual({ kind: "review", fastPath: "program:rm" });
  // Keys typed into a pane and a monitor's command are always reviewed; a pane monitor is not.
  expect(await reviewKind(call("send_keys", { paneId: "%3", args: ["y", "Enter"] }), worker(), kindDeps())).toEqual({ kind: "review" });
  expect(await reviewKind(call("monitor", { command: { run: "gh pr checks 1", every: "5m" } }), worker(), kindDeps())).toEqual({ kind: "review" });
  expect(await reviewKind(call("monitor", { pane: { paneId: "%3" } }), worker(), kindDeps())).toEqual({ kind: "skip" });
  expect(await reviewKind(call("read", { path: "/etc/hosts" }), worker(), kindDeps())).toEqual({ kind: "skip" });
});

test("a write to .git/config inside the worktree is reviewed", async () => {
  const fix = path.join(root, "shop-fix");
  expect(await reviewKind(call("write", { path: path.join(fix, "src/a.ts"), content: "" }), worker(), kindDeps())).toEqual({ kind: "skip" });
  for (const target of [".git/config", ".git/hooks/pre-commit", ".claude/settings.json", ".codex/config.toml"]) {
    expect(await reviewKind(call("write", { path: path.join(fix, target), content: "" }), worker(), kindDeps())).toEqual({ kind: "review" });
  }
  expect(await reviewKind(call("edit", { path: path.join(root, "home", ".zshrc") }), manager(), kindDeps({ thread: "manager" }))).toEqual({ kind: "review" });
  expect(await reviewKind(call("write", { path: path.join(root, "data", "config.json"), content: "" }), worker(), kindDeps())).toEqual({ kind: "review" });
  // Outside the scope's roots.
  expect(await reviewKind(call("write", { path: "/etc/hosts", content: "" }), worker(), kindDeps())).toEqual({ kind: "review" });
  // A manager writes in its projects; the personal agent only in its own resources.
  const inProject = call("write", { path: path.join(root, "shop", "README.md"), content: "" });
  expect(await reviewKind(inProject, manager(), kindDeps({ thread: "manager" }))).toEqual({ kind: "skip" });
  expect(await reviewKind(inProject, manager(), kindDeps({ thread: "personal" }))).toEqual({ kind: "review" });
  expect(await reviewKind(call("write", { path: path.join(root, "notes", "n.md"), content: "" }), manager(), kindDeps({ thread: "personal" }))).toEqual({ kind: "skip" });
});

test("archiving with the default cleanup is reviewed, without deletion it is not", async () => {
  const project = seedProject(env.projects, { workingDir: path.join(root, "shop") });
  const own = seedWorker(env.workers, project, { mode: "new-branch-new-worktree", branch: "fix", worktreePath: path.join(root, "shop-fix") });
  const shared = seedWorker(env.workers, project, { name: "G", mode: "shared-cwd", tmuxWindowName: "g" });
  const deps = kindDeps({ thread: "manager" });
  expect(await reviewKind(call("archive_worker", { workerId: own }), manager(), deps)).toEqual({ kind: "review" });
  expect(await reviewKind(call("archive_worker", { workerId: own, removeWorktree: false, deleteBranch: false }), manager(), deps)).toEqual({ kind: "skip" });
  expect(await reviewKind(call("archive_worker", { workerId: shared }), manager(), deps)).toEqual({ kind: "skip" });
  expect(await reviewKind(call("archive_worker", { workerId: shared, forceDeleteBranch: true }), manager(), deps)).toEqual({ kind: "review" });
  expect(await reviewKind(call("archive_project", { projectId: project, killTmux: true }), manager(), deps)).toEqual({ kind: "review" });
  expect(await reviewKind(call("archive_project", { projectId: project }), manager(), deps)).toEqual({ kind: "skip" });
});

function config(agent: Partial<Config["agent"]>): Config {
  const base = structuredClone(DEFAULT_CONFIG);
  return { ...base, agent: { ...base.agent, ...agent } };
}

/** The review of a manager's thread "Shop": on unless `config` says
 *  otherwise, `secondLook` its models; `over` replaces any other of its deps. */
function gate(opts: { config?: Config; secondLook: JudgementCandidate[] }, over: Partial<ConstructorParameters<typeof ToolReviewGate>[0]> = {}) {
  const thread = env.agentStore.createManagerThread("Shop");
  const review = new ToolReviewGate({
    config: () => opts.config ?? config({ toolReviewEnabled: true }),
    available: () => opts.secondLook.length > 0,
    agentStore: env.agentStore,
    workers: env.workers,
    projects: env.projects,
    handoffs: new HandoffStore(env.store.db),
    scopeOf: () => manager(),
    models: () => ({ screen: [], secondLook: opts.secondLook, own: null }),
    paneFacts: async () => null,
    scratch: [],
    ...over
  });
  return { review, thread };
}

function chat(texts: string[]) {
  const model = createMockLLM(texts.map((text) => ({ text, finishReason: "stop" as const })), { mode: "stream" });
  const recorder = new AgentLlmCallRecorder({ store: env.store, logRequests: "metadata", provider: "gw", model: "m", baseURL: "", apiMode: "streamText" });
  return { model, candidate: { kind: "chat", model, provider: "openai-compatible", supportsReasoning: false, recorder } as JudgementCandidate };
}

test("with the review off nothing is reviewed", async () => {
  const second = chat(['{"hold": true, "reason": "No."}']);
  const off = gate({ config: config({ toolReviewEnabled: false }), secondLook: [second.candidate] });
  expect(await off.review.reviewStep(off.thread.id, "wake-1", [call("bash", { command: "rm -rf build" })])).toEqual(new Map());
  // On, but with no second look to run on: off as well.
  const noSecondLook = gate({ config: config({ toolReviewEnabled: true }), secondLook: [] });
  expect(await noSecondLook.review.reviewStep(noSecondLook.thread.id, "wake-1", [call("bash", { command: "rm -rf build" })])).toEqual(new Map());
  expect(second.model.streamCalls).toHaveLength(0);
});

test("a held call comes back with the text the agent reads, and is remembered for the next review", async () => {
  const second = chat(['{"hold": true, "reason": "Deletes the build others use."}']);
  const on = gate({ config: config({ toolReviewEnabled: true }), secondLook: [second.candidate] });
  const held = await on.review.reviewStep(on.thread.id, "wake-1", [call("bash", { command: "ls" }, "c0"), call("bash", { command: "rm -rf /srv/build" }, "c1")]);
  expect([...held.keys()]).toEqual(["c1"]);
  expect(held.get("c1")).toBe("Held back by the tool-call review; this is not a failure. Deletes the build others use. Go on with the work this does not touch. If this step is needed, get the user's word for exactly this step the way your instructions say, then try again. Do not reach the same effect another way.");
  expect(on.review.recentHolds(on.thread.id)).toEqual([expect.objectContaining({ call: expect.objectContaining({ toolCallId: "c1" }), reason: "Deletes the build others use." })]);
  // The read-only call was never sent to a model.
  expect(second.model.streamCalls).toHaveLength(1);
});

// A write's target is judged where it lands (through a link, in any case); bash's
// explicit cwd is taken as its handler takes it; a subagent judges as the conversation it works
// for; the shell snapshot every command sources is an executed file; archiving a thread deletes
// what its workers' default cleanup deletes; a restore earlier in the step changes what an archive does.
test("a write is judged where it lands, through a link and in any case", async () => {
  const fix = path.join(root, "shop-fix");
  fs.symlinkSync(path.join(fix, ".git"), path.join(fix, "meta"));
  expect(await reviewKind(call("write", { path: path.join(fix, "meta", "hooks", "pre-commit"), content: "" }), worker(), kindDeps())).toEqual({ kind: "review" });
  expect(await reviewKind(call("write", { path: path.join(fix, ".GIT", "config"), content: "" }), worker(), kindDeps())).toEqual({ kind: "review" });
  // Inside Mandate's data, where a worker may write, but sourced before every command.
  const data = resolveDataDir();
  expect(await reviewKind(call("write", { path: path.join(data, "notes", "n.md"), content: "" }), worker(), kindDeps({ dataDir: data }))).toEqual({ kind: "skip" });
  expect(await reviewKind(call("write", { path: path.join(data, "shell-snapshots", "snapshot-zsh.sh"), content: "" }), worker(), kindDeps({ dataDir: data }))).toEqual({ kind: "review" });
});

test("bash's explicit cwd is read as its handler reads it", async () => {
  // A relative cwd is the server's own working directory, not the scope's workspace: unregistered here.
  expect(await reviewKind(call("bash", { command: "git status --porcelain", cwd: "." }), worker(), kindDeps())).toEqual({ kind: "review", fastPath: "git-repo" });
  expect(await reviewKind(call("bash", { command: "git status --porcelain" }), worker(), kindDeps())).toEqual({ kind: "skip" });
});

test("archiving a thread is reviewed when its workers' default cleanup deletes", async () => {
  const project = seedProject(env.projects, { workingDir: path.join(root, "shop") });
  const deleting = env.agentStore.createManagerThread("A");
  seedWorker(env.workers, project, { mode: "new-branch-new-worktree", branch: "fix", worktreePath: path.join(root, "shop-fix"), ownerThreadId: deleting.id });
  const keeping = env.agentStore.createManagerThread("B");
  seedWorker(env.workers, project, { name: "G", mode: "shared-cwd", tmuxWindowName: "g", ownerThreadId: keeping.id });
  const deps = kindDeps({ thread: "personal" });
  expect(await reviewKind(call("archive_thread", { threadId: deleting.id }), manager(), deps)).toEqual({ kind: "review" });
  expect(await reviewKind(call("archive_thread", { threadId: keeping.id }), manager(), deps)).toEqual({ kind: "skip" });
});

test("a subagent is judged as the conversation it works for, and a restore earlier in the step makes an archive reviewed", async () => {
  const project = seedProject(env.projects, { workingDir: path.join(root, "shop") });
  const shared = seedWorker(env.workers, project, { name: "G", mode: "shared-cwd", tmuxWindowName: "g" });
  const yourAgent = env.agentStore.getOrCreatePersonalThread();
  const subagent = env.agentStore.createSubagentThread("task-1");
  const second = chat(Array.from({ length: 4 }, () => '{"hold": true, "reason": "Needs the user."}'));
  const { review } = gate({ secondLook: [second.candidate] }, { parentThreadOf: (threadId) => (threadId === subagent.id ? yourAgent.id : null) });
  // The personal agent writes only in its own directory: so does its subagent.
  const write = call("write", { path: path.join(root, "shop", "src", "new.ts"), content: "" }, "w1");
  expect([...(await review.reviewStep(subagent.id, "wake-1", [write])).keys()]).toEqual(["w1"]);
  const restore = call("restore_worker", { workerId: shared, mode: "new-branch-new-worktree", branch: "new", baseRef: "main" }, "r1");
  const archive = call("archive_worker", { workerId: shared }, "a1");
  expect([...(await review.reviewStep(yourAgent.id, "wake-2", [restore, archive])).keys()]).toEqual(["a1"]);
});

// A dangling link's destination is not known, so the write is reviewed; a
// protected place is matched by its real path too; a call that changes projects, workers or
// threads earlier in a step makes the step's later calls reviewed.
test("a write through a dangling link, or into a protected place by another name, is reviewed", async () => {
  const fix = path.join(root, "shop-fix");
  fs.symlinkSync(path.join(fix, ".git", "config"), path.join(fix, "settings"));
  expect(await reviewKind(call("write", { path: path.join(fix, "settings"), content: "[core]\n" }), worker(), kindDeps())).toEqual({ kind: "review" });
  // Mandate's data reached through a link, and under a name of its own.
  fs.mkdirSync(path.join(fix, "real-data"));
  fs.symlinkSync(path.join(fix, "real-data"), path.join(root, "data-link"));
  fs.symlinkSync(path.join(fix, "real-data"), path.join(fix, "state"));
  expect(await reviewKind(call("write", { path: path.join(fix, "state", "config.json"), content: "{}" }), worker(), kindDeps({ dataDir: path.join(root, "data-link") }))).toEqual({ kind: "review" });
});

test("after a call that changes projects, workers or threads, the step's later calls are reviewed", async () => {
  const project = seedProject(env.projects, { workingDir: path.join(root, "shop") });
  const second = chat(Array.from({ length: 4 }, () => '{"hold": true, "reason": "Needs the user."}'));
  const { review, thread } = gate({ secondLook: [second.candidate] });
  const archive = call("archive_project", { projectId: project, killTmux: false }, "p1");
  const write = call("write", { path: path.join(root, "shop", "new.ts"), content: "new" }, "w1");
  expect([...(await review.reviewStep(thread.id, "wake-1", [archive, write])).keys()]).toEqual(["w1"]);
  // On its own the same write is the manager's work.
  expect([...(await review.reviewStep(thread.id, "wake-2", [write])).keys()]).toEqual([]);
});

// A protected entry that is itself a link protects its destination; a reviewed
// call earlier in the step (a bash that makes a link, say) makes the step's later calls reviewed.
test("writing the destination of a protected link is reviewed", async () => {
  const fix = path.join(root, "shop-fix");
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  fs.writeFileSync(path.join(fix, "startup"), "");
  fs.symlinkSync(path.join(fix, "startup"), path.join(root, "home", ".zshrc"));
  expect(await reviewKind(call("write", { path: path.join(fix, "startup"), content: "echo hi" }), worker(), kindDeps())).toEqual({ kind: "review" });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.symlinkSync(path.join(fix, "conf.json"), path.join(root, "data", "config.json"));
  expect(await reviewKind(call("write", { path: path.join(fix, "conf.json"), content: "{}" }), worker(), kindDeps())).toEqual({ kind: "review" });
  expect(await reviewKind(call("write", { path: path.join(fix, "src", "a.ts"), content: "" }), worker(), kindDeps())).toEqual({ kind: "skip" });
});

test("after a reviewed call in a step, the step's later calls are reviewed", async () => {
  const second = chat(Array.from({ length: 4 }, () => '{"hold": false, "reason": "Fine."}'));
  const { review, thread } = gate({ secondLook: [second.candidate] });
  const link = call("bash", { command: `ln -s ${path.join(root, "shop", ".git")} ${path.join(root, "shop", "meta")}` }, "b1");
  const write = call("write", { path: path.join(root, "shop", "meta", "config"), content: "[core]\n" }, "w1");
  await review.reviewStep(thread.id, "wake-1", [link, write]);
  // Both went to the second look, the write too.
  expect(second.model.streamCalls).toHaveLength(2);
});

// Links in or as protected folders protect where they lead; a repository
// marker written earlier in the step makes a later bash reviewed.
test("a protected folder that is a link, or holds one, protects what it leads to", async () => {
  const shop = path.join(root, "shop");
  fs.mkdirSync(path.join(shop, "settings"));
  fs.symlinkSync(path.join(shop, "settings"), path.join(shop, ".claude"));
  fs.mkdirSync(path.join(shop, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(shop, "hook.sh"), "");
  fs.symlinkSync(path.join(shop, "hook.sh"), path.join(shop, ".git", "hooks", "pre-commit"));
  const deps = kindDeps({ thread: "manager", registeredRepos: [shop] });
  expect(await reviewKind(call("write", { path: path.join(shop, "settings", "settings.json"), content: "{}" }), manager(), deps)).toEqual({ kind: "review" });
  expect(await reviewKind(call("write", { path: path.join(shop, "hook.sh"), content: "" }), manager(), deps)).toEqual({ kind: "review" });
  expect(await reviewKind(call("write", { path: path.join(shop, "README.md"), content: "" }), manager(), deps)).toEqual({ kind: "skip" });
});

test("a repository marker written earlier in a step makes a later bash reviewed", async () => {
  seedProject(env.projects, { workingDir: path.join(root, "shop") });
  fs.mkdirSync(path.join(root, "shop", "nested"), { recursive: true });
  const second = chat(Array.from({ length: 4 }, () => '{"hold": false, "reason": "Fine."}'));
  const { review, thread } = gate({ secondLook: [second.candidate] });
  // A bare repository made by its HEAD (a .git of its own is reviewed itself).
  const marker = call("write", { path: path.join(root, "shop", "nested", "HEAD"), content: "ref: refs/heads/main\n" }, "w1");
  const status = call("bash", { command: "git status --porcelain", cwd: path.join(root, "shop", "nested") }, "b1");
  await review.reviewStep(thread.id, "wake-1", [marker, status]);
  // The marker write itself is the manager's work; the git status after it is reviewed.
  expect(second.model.streamCalls).toHaveLength(1);
  expect(JSON.stringify(second.model.streamCalls[0]!.prompt)).toContain("git status --porcelain");
});

// A write that makes repository structure under its path, or reaches a marker
// through a link, makes a later bash reviewed; a linked config.worktree protects its destination.
test("a repository made or reached by a write's path makes a later bash reviewed", async () => {
  const shop = path.join(root, "shop");
  seedProject(env.projects, { workingDir: shop });
  fs.mkdirSync(path.join(shop, "nested"), { recursive: true });
  fs.writeFileSync(path.join(shop, "pointer-target"), "");
  fs.symlinkSync(path.join(shop, ".git"), path.join(shop, "meta-link"));
  const second = chat(Array.from({ length: 6 }, () => '{"hold": false, "reason": "Fine."}'));
  const { review, thread } = gate({ secondLook: [second.candidate] });
  const status = (id: string) => call("bash", { command: "git status --porcelain", cwd: path.join(shop, "nested") }, id);
  await review.reviewStep(thread.id, "wake-1", [call("write", { path: path.join(shop, "nested", "objects", "info", "keep"), content: "" }, "w1"), status("b1")]);
  expect(second.model.streamCalls).toHaveLength(1);
  await review.reviewStep(thread.id, "wake-2", [call("write", { path: path.join(shop, "meta-link", "info", "exclude"), content: "" }, "w2"), status("b2")]);
  // The write lands under .git (an ignore file, nothing that runs): the bash after it is reviewed.
  expect(second.model.streamCalls).toHaveLength(2);
});

test("a linked config.worktree protects its destination", async () => {
  const shop = path.join(root, "shop");
  fs.writeFileSync(path.join(shop, "extra-config"), "");
  fs.symlinkSync(path.join(shop, "extra-config"), path.join(shop, ".git", "config.worktree"));
  expect(await reviewKind(call("write", { path: path.join(shop, "extra-config"), content: "" }), manager(), kindDeps({ thread: "manager", registeredRepos: [shop] }))).toEqual({ kind: "review" });
});

// The scope's own folders are searched for protected links too; a repository
// marker written earlier in a step makes a later write reviewed as well as a later bash.
test("a protected link in the scope's own folder protects its destination", async () => {
  const notes = path.join(root, "notes");
  fs.mkdirSync(path.join(notes, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(notes, "settings.json"), "{}");
  fs.symlinkSync(path.join(notes, "settings.json"), path.join(notes, ".claude", "settings.json"));
  expect(await reviewKind(call("write", { path: path.join(notes, "settings.json"), content: "{}" }), manager(), kindDeps({ thread: "personal", registeredRepos: [] }))).toEqual({ kind: "review" });
});

test("a repository marker written earlier in a step makes a later write reviewed", async () => {
  const shop = path.join(root, "shop");
  fs.mkdirSync(path.join(shop, "meta"), { recursive: true });
  const second = chat(Array.from({ length: 4 }, () => '{"hold": false, "reason": "Fine."}'));
  const { review, thread } = gate({ secondLook: [second.candidate] });
  // A bare repository made by its refs.
  const marker = call("write", { path: path.join(shop, "nested", "refs", "heads", "main"), content: "0000000000000000000000000000000000000000\n" }, "w1");
  const config2 = call("write", { path: path.join(shop, "meta", "config"), content: "[core]\n" }, "w2");
  await review.reviewStep(thread.id, "wake-1", [marker, config2]);
  expect(second.model.streamCalls).toHaveLength(1);
  expect(JSON.stringify(second.model.streamCalls[0]!.prompt)).toContain("meta/config");
});

test("a protected link in another worker's worktree protects its destination", async () => {
  const other = path.join(root, "elsewhere", "shop-docs");
  fs.mkdirSync(path.join(other, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(root, "notes", "hooks.json"), "{}");
  fs.symlinkSync(path.join(root, "notes", "hooks.json"), path.join(other, ".claude", "settings.json"));
  const project = seedProject(env.projects, { workingDir: path.join(root, "shop") });
  seedWorker(env.workers, project, { mode: "new-branch-new-worktree", branch: "docs", worktreePath: other });
  expect(await reviewKind(call("write", { path: path.join(root, "notes", "hooks.json"), content: "{}" }), manager(), kindDeps({ thread: "manager", registeredRepos: [] }))).toEqual({ kind: "review" });
});

test("a protected link in the personal agent's or the managers' folder protects its destination from any scope", async () => {
  const data = path.join(root, "data");
  for (const [bucket, file] of [["agent", "agent-settings.json"], ["manager", "manager-settings.json"]] as const) {
    const folder = path.join(data, "resources", "global", bucket, ".claude");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(root, "shop-fix", "src", file), "{}");
    fs.symlinkSync(path.join(root, "shop-fix", "src", file), path.join(folder, "settings.json"));
    expect(await reviewKind(call("write", { path: path.join(root, "shop-fix", "src", file), content: "{}" }), worker(), kindDeps())).toEqual({ kind: "review" });
  }
});

test("every link directly inside a protected folder protects its destination, however many there are", async () => {
  const fix = path.join(root, "shop-fix");
  const folder = path.join(fix, ".claude", "commands");
  fs.mkdirSync(folder, { recursive: true });
  const targets = Array.from({ length: 201 }, (_, i) => path.join(fix, "src", `command-${i}.md`));
  for (const [i, target] of targets.entries()) {
    fs.writeFileSync(target, "");
    fs.symlinkSync(target, path.join(folder, `command-${i}.md`));
  }
  // Every target, as "every" says: a sample misses a link skipped between
  // its ends (a batch resumed one too far). Each review reads every link, so
  // the 201 reviews take over a second alone; 29 s were seen for 250 under a load of 50.
  const verdicts = await Promise.all(targets.map((target) => reviewKind(call("write", { path: target, content: "" }), worker(), kindDeps())));
  expect(verdicts.filter((verdict) => verdict.kind !== "review")).toEqual([]);
}, 60_000);

test("a worktree that lives under a .claude or .codex folder is worked in like any other", async () => {
  for (const home of [".claude", ".codex"]) {
    const tree = path.join(root, "shop", home, "worktrees", "w");
    fs.mkdirSync(path.join(tree, "src"), { recursive: true });
    const scope: AgentScope = { kind: "worker", worker: { workingDir: tree }, project: { workingDir: path.join(root, "shop") } };
    expect(await reviewKind(call("edit", { path: path.join(tree, "src", "a.ts"), oldString: "a", newString: "b" }), scope, kindDeps())).toEqual({ kind: "skip" });
    // Its own agent settings are still the user's to approve.
    expect(await reviewKind(call("write", { path: path.join(tree, ".claude", "settings.json"), content: "{}" }), scope, kindDeps())).toEqual({ kind: "review" });
  }
});

test("a review a stop cut short holds nothing back for later and counts no hold", async () => {
  const streaks = new ToolReviewStreaks({ db: env.store.db, agentStore: env.agentStore, workers: env.workers });
  const second = chat(Array.from({ length: 6 }, () => '{"hold": true, "reason": "Deletes the build."}'));
  const { review, thread } = gate({ secondLook: [second.candidate] }, { streaks });
  for (let i = 0; i < 3; i += 1) {
    const stop = new AbortController();
    stop.abort();
    await review.reviewStep(thread.id, "wake-1", [call("bash", { command: "rm -rf /srv/build" }, `c${i}`)], stop.signal);
  }
  expect(review.recentHolds(thread.id)).toEqual([]);
  expect(streaks.mark(thread.id)).toBeNull();
  // Stopped before it began, it asks no model.
  expect(second.model.streamCalls).toHaveLength(0);
});

test("a review that fails outright holds the step's calls as not checked, and the step goes on", async () => {
  const second = chat(['{"hold": false, "reason": "Fine."}']);
  const { review, thread } = gate({ secondLook: [second.candidate] }, { scopeOf: () => { throw new Error("thread not found"); } });
  const held = await review.reviewStep(thread.id, "wake-1", [call("bash", { command: "rm -rf build" }, "c1"), call("read", { path: "/etc/hosts" }, "c2")]);
  expect([...held.entries()]).toEqual([["c1", REVIEW_UNAVAILABLE], ["c2", REVIEW_UNAVAILABLE]]);
});

test("writing a .git file that points a checkout's git elsewhere is reviewed", async () => {
  const fix = path.join(root, "shop-fix");
  expect(await reviewKind(call("write", { path: path.join(fix, "nested", ".git"), content: "gitdir: /tmp/elsewhere\n" }), worker(), kindDeps())).toEqual({ kind: "review" });
  // A file only named like one is not.
  expect(await reviewKind(call("write", { path: path.join(fix, "src", "a.git"), content: "" }), worker(), kindDeps())).toEqual({ kind: "skip" });
});

test("reading Mandate's own settings file in bash is reviewed: it holds provider keys", async () => {
  const data = path.join(root, "data");
  expect(await reviewKind(call("bash", { command: `cat ${path.join(data, "config.json")}` }), worker(), kindDeps())).toEqual({ kind: "review", fastPath: "secret-path" });
});

test("a working folder inside the home's git config or Mandate's skills is worked in like any other", async () => {
  for (const tree of [path.join(root, "home", ".config", "git", "worktrees", "w"), path.join(root, "data", "skills", "w")]) {
    fs.mkdirSync(path.join(tree, "src"), { recursive: true });
    const scope = workerScope(tree);
    expect(await reviewKind(call("edit", { path: path.join(tree, "src", "a.ts"), oldString: "a", newString: "b" }), scope, kindDeps())).toEqual({ kind: "skip" });
  }
});

test("a stop while a step's contexts are built starts no further lookup and ends the review", async () => {
  const stop = new AbortController();
  let lookups = 0;
  // The first pane's facts never come; the stop lands while waiting on them.
  const { review, thread } = gate({ secondLook: [chat(['{"hold": false, "reason": "Fine."}']).candidate] }, { paneFacts: () => { lookups += 1; return new Promise(() => {}); } });
  setTimeout(() => stop.abort(), 30);
  const startedAt = Date.now();
  await review.reviewStep(thread.id, "wake-1", [call("send_keys", { paneId: "%1", args: ["y"] }, "k1"), call("send_keys", { paneId: "%2", args: ["y"] }, "k2")], stop.signal);
  expect(Date.now() - startedAt).toBeLessThan(1000);
  expect(lookups).toBe(1);
  expect(review.recentHolds(thread.id)).toEqual([]);
});

test("a schedule's check is reviewed when it is written; running a saved one again is not", async () => {
  const deps = kindDeps({ thread: "personal" });
  expect(await reviewKind(call("manage_schedule", { action: "create", name: "q", cron: "0 9 * * *", check: "curl -s http://x", brief: "b", thread: { newTitle: "t" } }), manager(), deps)).toEqual({ kind: "review" });
  expect(await reviewKind(call("manage_schedule", { action: "update", id: "sch_1", check: "grep ERROR app.log" }), manager(), deps)).toEqual({ kind: "review" });
  expect(await reviewKind(call("manage_schedule", { action: "update", id: "sch_1", name: "renamed", check: "" }), manager(), deps)).toEqual({ kind: "skip" });
  expect(await reviewKind(call("manage_schedule", { action: "run_now", id: "sch_1" }), manager(), deps)).toEqual({ kind: "skip" });
  expect(await reviewKind(call("manage_schedule", { action: "update", id: "sch_1", resetState: true }), manager(), deps)).toEqual({ kind: "skip" });
  expect(await reviewKind(call("manage_schedule", { action: "pause", id: "sch_1", reason: "x" }), manager(), deps)).toEqual({ kind: "skip" });
  expect(await reviewKind(call("list_schedules", {}), manager(), deps)).toEqual({ kind: "skip" });
});
