import { afterEach, expect, test } from "bun:test";
import { SkillRegistry } from "../src/server/modules/skills/skill-registry.js";
import { buildSkillTool } from "../src/server/modules/skills/skill-tool.js";
import { learnedSkillLines } from "../src/server/modules/skills/learned-skill-lines.js";
import { LearnedSkillStore, type LearnedSkill, type LearnedSkillWhere } from "../src/server/modules/skills/learned-skill-store.js";
import { projectIdsOfThread } from "../src/server/modules/task-board/work-ran-in.js";
import type { SkillEntry } from "../src/server/modules/skills/skill-loader.js";
import type { ToolContext } from "../src/server/modules/agent/tool-registry.js";
import { buildWorkerScope, type WorkerScopeDeps } from "../src/server/runtime/scopes/worker-scope.js";
import { buildManagerScope } from "../src/server/runtime/scopes/manager-scope.js";
import { buildPersonalScope, type PersonalScopeDeps } from "../src/server/modules/personal/personal-scope.js";
import { voiceToolSurface } from "../src/server/app/voice.js";
import { DEFAULT_CONFIG } from "../src/server/config/defaults.js";
import { freshStoresEnv, seedProject, seedWorker } from "./helpers/fixtures.js";
import { runCleanups } from "./helpers/cleanup.js";

afterEach(() => runCleanups());

const GLOBAL: LearnedSkillWhere = { scope: "user" };

function setup() {
  const env = freshStoresEnv("md-learned-ctx-");
  const p1 = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-p1" });
  const p2 = seedProject(env.projects, { name: "bakery", tmuxSessionName: "md-bk" });
  const learned = new LearnedSkillStore(env.store.db, () => new Set(["house-style"]));
  const add = (name: string, where: LearnedSkillWhere, description = `How to ${name}.`) => {
    const made = learned.create({ name, description, body: `Steps of ${name}.`, where, by: "review" });
    if (!made.ok) throw new Error(made.message);
    return made.skill;
  };
  const fileSkill: SkillEntry = { name: "house-style", description: "The house style.", scope: ["manager", "worker"], sourcePath: "/fake/SKILL.md", loadBody: async () => "file body", resolveReference: () => null };
  const registry = new SkillRegistry([[fileSkill]]);
  registry.attachLearned({
    store: learned,
    projectName: (id) => env.projects.getById(id)?.name ?? null,
    projectIdsOfThread: projectIdsOfThread({ workersStore: env.workers }),
    projectIdByName: (name) => env.projects.listActive().find((p) => p.name === name)?.id ?? null
  });
  return { env, p1, p2, learned, add, registry };
}

const skill = (over: Partial<LearnedSkill>): LearnedSkill => ({
  id: "skl_x", name: "x", description: "d", body: "b", where: GLOBAL, status: "available", revision: 1,
  createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", lastUsedAt: null, archivedReason: null, absorbedInto: null, ...over
});

test("lines read name, description and where", () => {
  const lines = learnedSkillLines([
    skill({ name: "release-steps", description: "Cut a release.", where: { scope: "project", projectId: "proj_a" } }),
    skill({ name: "error-triage", description: "Find where errors come from." })
  ], (id) => (id === "proj_a" ? "project-1" : null));
  expect(lines).toEqual(["- error-triage: Find where errors come from. (global)", "- release-steps: Cut a release. (project project-1)"]);
});

test("past the budget descriptions shorten to 120, then the least recently used go, with a count", () => {
  const long = "x".repeat(250);
  const many = Array.from({ length: 6 }, (_, i) => skill({ name: `skill-${i}`, description: long, lastUsedAt: `2026-11-1${i}T00:00:00.000Z` }));
  const shortened = learnedSkillLines(many, () => null, 1000);
  expect(shortened.every((line) => line.length < 160)).toBe(true);
  const cut = learnedSkillLines(many, () => null, 400);
  expect(cut[cut.length - 1]).toBe(`${6 - (cut.length - 1)} more learned skills are not listed; load one by name if you know it.`);
  // The most recently used stay.
  expect(cut.slice(0, -1).map((line) => line.slice(2, 9))).toContain("skill-5");
  expect(cut.join("\n").length).toBeLessThanOrEqual(400);
});

test("a worker's list has global skills and its project's, a manager's those of the workers it owns or owned, the personal agent's all", () => {
  const { env, p1, p2, add, registry } = setup();
  add("error-triage", GLOBAL);
  add("shop-release", { scope: "project", projectId: p1 });
  add("bakery-release", { scope: "project", projectId: p2 });
  const worker = registry.renderManifest("worker", { projectIds: [p1] });
  expect([worker.includes("- error-triage:"), worker.includes("- shop-release:"), worker.includes("bakery-release")]).toEqual([true, true, false]);
  expect(worker.includes("- house-style: The house style.")).toBe(true);
  const manager = env.agentStore.createManagerThread("Releases");
  const owned = seedWorker(env.workers, p2, { ownerThreadId: manager.id });
  env.workers.archive(owned);
  const forManager = registry.renderManifest("manager", { threadId: manager.id });
  expect([forManager.includes("bakery-release"), forManager.includes("shop-release")]).toEqual([true, false]);
  const personal = registry.renderManifest("personal", { projectIds: "all" });
  expect([personal.includes("bakery-release"), personal.includes("shop-release"), personal.includes("error-triage")]).toEqual([true, true, true]);
});

const ctx = (over: Partial<ToolContext>): ToolContext => ({ threadId: "thr_w", wakeId: "w", scope: { kind: "manager", managerDir: "/tmp", projectWorkingDirs: [] }, ...over }) as ToolContext;

test("a worker loads a global skill and its project's, not another project's", async () => {
  const { env, p1, p2, add, registry } = setup();
  add("error-triage", GLOBAL);
  add("bakery-release", { scope: "project", projectId: p2 });
  const own = add("shop-release", { scope: "project", projectId: p1 });
  const tool = buildSkillTool(registry, "worker");
  const workerCtx = ctx({ project: env.projects.getById(p1)! });
  const loaded = String(await tool.handler({ name: "shop-release" }, workerCtx));
  expect(loaded).toContain(`Learned skill (project project-1, revision 1).\n\nSteps of shop-release.`);
  expect(String(await tool.handler({ name: "error-triage" }, workerCtx))).toContain("Learned skill (global, revision 1).");
  expect(await tool.handler({ name: "bakery-release" }, workerCtx)).toEqual({ error: "Unknown skill: bakery-release" });
  expect(registry.loadedRevision("thr_w", own.id)).toBe(1);
});

test("a manager or the personal agent loads any learned skill", async () => {
  const { p2, add, registry } = setup();
  add("bakery-release", { scope: "project", projectId: p2 });
  expect(String(await buildSkillTool(registry, "manager").handler({ name: "bakery-release" }, ctx({})))).toContain("Steps of bakery-release.");
  expect(String(await buildSkillTool(registry, "personal").handler({ name: "bakery-release" }, ctx({ threadId: "thr_n" })))).toContain("Steps of bakery-release.");
});

test("an archived skill answers that it is archived and why", async () => {
  const { add, learned, registry } = setup();
  const old = add("old-steps", GLOBAL);
  learned.change(old.id, 1, { status: "archived", archivedReason: "No use in 60 days", change: "archive", by: "rule" });
  expect(await buildSkillTool(registry, "manager").handler({ name: "old-steps" }, ctx({}))).toEqual({ error: 'The skill "old-steps" is archived and not in use: No use in 60 days' });
});

test("a load records a use with the thread and the agent", async () => {
  const { add, learned, registry } = setup();
  const s = add("error-triage", GLOBAL);
  await buildSkillTool(registry, "manager").handler({ name: "error-triage" }, ctx({ threadId: "thr_m" }));
  expect(learned.usesSince(s.id, "2000-01-01T00:00:00.000Z")).toBe(1);
  expect(learned.get(s.id)?.lastUsedAt).not.toBeNull();
});

test("a file skill with the same name wins", async () => {
  const { registry } = setup();
  // The store refuses the name; a file that appears later would win the same way.
  expect(String(await buildSkillTool(registry, "manager").handler({ name: "house-style" }, ctx({})))).toContain("file body");
});

test("a worker's initial context lists its project's learned skills, a manager's those of its workers' projects", async () => {
  const { env, p1, p2, add, registry } = setup();
  add("shop-release", { scope: "project", projectId: p1 });
  add("bakery-release", { scope: "project", projectId: p2 });
  const workerId = seedWorker(env.workers, p1);
  const workerThread = env.agentStore.getOrCreateThread("worker", workerId);
  const workerScope = buildWorkerScope({ agentStore: env.agentStore, projectsStore: env.projects, workersStore: env.workers, skillRegistry: registry } as unknown as WorkerScopeDeps);
  const workerContext = (await workerScope.buildInitialContext!(workerThread.id))!;
  expect([workerContext.includes("shop-release"), workerContext.includes("bakery-release")]).toEqual([true, false]);
  const manager = env.agentStore.createManagerThread("Bakery");
  seedWorker(env.workers, p2, { ownerThreadId: manager.id });
  const managerScope = buildManagerScope({ agentStore: env.agentStore, projectsStore: env.projects, workersStore: env.workers, skillRegistry: registry } as never);
  const managerContext = (await managerScope.buildInitialContext!(manager.id))!;
  expect([managerContext.includes("bakery-release"), managerContext.includes("shop-release")]).toEqual([true, false]);
});

test("the personal agent's list leaves out an archived project's skills; it still loads one by name", async () => {
  const { env, p1, p2, add, registry } = setup();
  add("shop-release", { scope: "project", projectId: p1 });
  add("bakery-release", { scope: "project", projectId: p2 });
  env.projects.archive(p2);
  const scope = buildPersonalScope({
    getConfig: () => structuredClone(DEFAULT_CONFIG), agentStore: env.agentStore, projectsStore: env.projects, workersStore: env.workers,
    skillRegistry: registry, memory: null, toolPacks: [], workDir: env.dir
  } as unknown as PersonalScopeDeps);
  const context = (await scope.buildInitialContext!(env.agentStore.getOrCreatePersonalThread().id)) ?? "";
  expect([context.includes("shop-release"), context.includes("bakery-release")]).toEqual([true, false]);
  expect(String(await buildSkillTool(registry, "personal").handler({ name: "bakery-release" }, ctx({ threadId: "thr_p" })))).toContain("Steps of bakery-release.");
});

test("a voice session is offered neither manage_skill nor request_skill_review, and refuses them", async () => {
  const called: string[] = [];
  const tool = (name: string) => ({ name, description: name, parameters: {} }) as never;
  const surface = voiceToolSurface({
    toolDefinitions: [tool("skill"), tool("manage_skill"), tool("request_skill_review"), tool("memory_search")],
    wrappedDispatcher: { registry: { tools: {}, offeredSpecs: () => [] }, dispatch: async (call) => { called.push(call.toolName); return { result: "ok" }; } }
  } as never);
  expect(surface.tools.map((t: { name: string }) => t.name)).toEqual(["skill", "memory_search"]);
  const ctxOf = { threadId: "thr_p", wakeId: "w", scope: { kind: "manager", managerDir: "/tmp", projectWorkingDirs: [] } } as never;
  expect(await surface.dispatcher.dispatch({ toolCallId: "c1", toolName: "manage_skill", args: {} }, ctxOf)).toEqual({ isError: true, error: "unknown tool: manage_skill" });
  expect(await surface.dispatcher.dispatch({ toolCallId: "c2", toolName: "skill", args: {} }, ctxOf)).toEqual({ result: "ok" });
  expect(called).toEqual(["skill"]);
});
