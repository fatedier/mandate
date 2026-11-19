import { afterEach, expect, test } from "bun:test";
import { SkillRegistry } from "../src/server/modules/skills/skill-registry.js";
import { buildSkillTool } from "../src/server/modules/skills/skill-tool.js";
import { buildManageSkillTool } from "../src/server/modules/skills/manage-skill-tool.js";
import { buildSkillToolPacks } from "../src/server/modules/skills/tool-packs.js";
import { pickPersonalReusedTools } from "../src/server/modules/personal/personal-scope.js";
import { LearnedSkillStore, type LearnedSkillWhere } from "../src/server/modules/skills/learned-skill-store.js";
import { projectIdsOfThread } from "../src/server/modules/task-board/work-ran-in.js";
import type { SkillEntry } from "../src/server/modules/skills/skill-loader.js";
import type { ToolContext } from "../src/server/modules/agent/tool-registry.js";
import type { NotifyRequest } from "../src/server/modules/notifications/notification-service.js";
import { buildWorkerScope, type WorkerScopeDeps } from "../src/server/runtime/scopes/worker-scope.js";
import { buildManagerScope } from "../src/server/runtime/scopes/manager-scope.js";
import { freshStoresEnv, seedProject, seedWorker } from "./helpers/fixtures.js";
import { runCleanups } from "./helpers/cleanup.js";

afterEach(() => runCleanups());

const GLOBAL: LearnedSkillWhere = { scope: "user" };

function setup() {
  const env = freshStoresEnv("md-manage-skill-");
  const project = seedProject(env.projects, { name: "bakery", tmuxSessionName: "md-bk" });
  const learned = new LearnedSkillStore(env.store.db, () => new Set(["house-style"]));
  const sent: NotifyRequest[] = [];
  const fileSkill: SkillEntry = { name: "house-style", description: "The house style.", scope: ["manager", "worker"], sourcePath: "/fake/SKILL.md", loadBody: async () => "file body", resolveReference: () => null };
  const registry = new SkillRegistry([[fileSkill]]);
  registry.attachLearned({
    store: learned,
    projectName: (id) => env.projects.getById(id)?.name ?? null,
    projectIdByName: (name) => env.projects.listActive().find((p) => p.name === name)?.id ?? null,
    projectIdsOfThread: projectIdsOfThread({ workersStore: env.workers }),
    notify: (request) => { sent.push(request); }
  });
  const made = learned.create({ name: "release-steps", description: "Cut a release.", body: "1. Tag.\n2. Build.\n3. Ship.", where: GLOBAL, by: "review" });
  if (!made.ok) throw new Error(made.message);
  const ctx = { threadId: "thr_m", wakeId: "w", scope: { kind: "manager", managerDir: "/tmp", projectWorkingDirs: [] } } as unknown as ToolContext;
  const load = () => buildSkillTool(registry, "manager").handler({ name: "release-steps" }, ctx);
  const update = buildManageSkillTool(registry);
  return { env, project, learned, registry, sent, skill: made.skill, ctx, load, update };
}

test("patch replaces one passage of a skill loaded in this conversation; rewrite its whole text", async () => {
  const { learned, skill, ctx, load, update } = setup();
  await load();
  const result = await update.handler({ name: "release-steps", action: "patch", revision: 1, old_text: "2. Build.", new_text: "2. Build and sign.", reason: "Unsigned builds are refused." }, ctx);
  expect(result).toEqual({ name: "release-steps", revision: 2, status: "available", scope: "global" });
  expect(learned.get(skill.id)?.body).toBe("1. Tag.\n2. Build and sign.\n3. Ship.");
  expect(learned.versions(skill.id)[0]).toMatchObject({ change: "patch", by: "agent", threadId: "thr_m", reason: "Unsigned builds are refused." });
  // The agent wrote what the skill now says: a second fix needs no reload.
  expect((await update.handler({ name: "release-steps", action: "rewrite", body: "1. Tag.\n2. Build and sign.\n3. Ship.\n4. Announce.", reason: "Announce was missing." }, ctx)) as { revision: number }).toMatchObject({ revision: 3 });
  expect(learned.versions(skill.id)[0]).toMatchObject({ change: "rewrite", by: "agent" });
});

test("a text change of a skill not loaded, loaded at an older revision, or given another revision, is refused", async () => {
  const { learned, skill, ctx, load, update } = setup();
  const edit = { name: "release-steps", action: "patch", old_text: "1. Tag.", new_text: "1. Tag it.", reason: "x" } as const;
  expect(await update.handler(edit, ctx)).toEqual({ error: "Load the skill with `skill` first; you can only edit a skill you loaded in this conversation." });
  await load();
  expect(await update.handler({ ...edit, revision: 2 }, ctx)).toEqual({ error: "The skill changed since you loaded it. Load it again." });
  learned.change(skill.id, 1, { body: "changed elsewhere", change: "patch", by: "review" });
  expect(await update.handler(edit, ctx)).toEqual({ error: "The skill changed since you loaded it. Load it again." });
});

test("patch needs its passage, once, and rewrite its body", async () => {
  const { ctx, load, update } = setup();
  await load();
  expect(await update.handler({ name: "release-steps", action: "patch", reason: "x" }, ctx)).toEqual({ error: "Give `old_text`." });
  expect(await update.handler({ name: "release-steps", action: "rewrite", body: " ", reason: "x" }, ctx)).toEqual({ error: "Give `body`." });
  expect(await update.handler({ name: "release-steps", action: "patch", old_text: "4. Nope.", new_text: "x", reason: "x" }, ctx)).toEqual({ error: "The passage was not found in the skill, or it occurs more than once." });
  expect(await update.handler({ name: "release-steps", action: "patch", old_text: ". ", new_text: "x", reason: "x" }, ctx)).toEqual({ error: "The passage was not found in the skill, or it occurs more than once." });
  expect(await update.handler({ name: "release-steps", action: "rewrite", body: "a\n".repeat(501), reason: "x" }, ctx)).toEqual({ error: "The skill would be longer than 500 lines or 40,000 characters." });
});

test("a passage edit with no replacement text is refused; an empty one deletes the passage", async () => {
  const { learned, skill, ctx, load, update } = setup();
  await load();
  expect(await update.handler({ name: "release-steps", action: "patch", old_text: "2. Build.\n", reason: "x" }, ctx)).toEqual({ error: "Give `new_text`." });
  expect(learned.get(skill.id)?.body).toBe("1. Tag.\n2. Build.\n3. Ship.");
  expect(await update.handler({ name: "release-steps", action: "patch", old_text: "2. Build.\n", new_text: "", reason: "Building is automatic." }, ctx)).toMatchObject({ revision: 2 });
  expect(learned.get(skill.id)?.body).toBe("1. Tag.\n3. Ship.");
});

test("revert undoes the last change; revert to a revision brings that text back", async () => {
  const { learned, skill, ctx, load, update } = setup();
  learned.change(skill.id, 1, { body: "two", change: "patch", by: "review" });
  learned.change(skill.id, 2, { body: "three", change: "patch", by: "review" });
  expect(await update.handler({ name: "release-steps", action: "revert", reason: "The user asked." }, ctx)).toMatchObject({ revision: 4 });
  expect(learned.get(skill.id)?.body).toBe("two");
  expect(await update.handler({ name: "release-steps", action: "revert", to_revision: 1, reason: "The user asked." }, ctx)).toMatchObject({ revision: 5 });
  expect(learned.get(skill.id)?.body).toBe("1. Tag.\n2. Build.\n3. Ship.");
  expect(await update.handler({ name: "release-steps", action: "revert", to_revision: 99, reason: "x" }, ctx)).toEqual({ error: "The skill has no revision 99." });
  void load;
});

test("archive, restore and move write a revision each; an archived skill is not edited; an unknown project is refused", async () => {
  const { learned, skill, ctx, load, update } = setup();
  await load();
  expect(await update.handler({ name: "release-steps", action: "archive", reason: "The user asked." }, ctx)).toMatchObject({ status: "archived" });
  expect(learned.get(skill.id)?.archivedReason).toBe("The user asked.");
  expect(await update.handler({ name: "release-steps", action: "patch", old_text: "1. Tag.", new_text: "x", reason: "x" }, ctx)).toEqual({ error: "This skill is archived: restore it first." });
  expect(await update.handler({ name: "release-steps", action: "restore", reason: "The user asked." }, ctx)).toMatchObject({ status: "available" });
  expect(await update.handler({ name: "release-steps", action: "move", scope: "bakery", reason: "Only this project releases so." }, ctx)).toMatchObject({ scope: "project bakery" });
  expect(await update.handler({ name: "release-steps", action: "move", scope: "nowhere", reason: "x" }, ctx)).toEqual({ error: "There is no project named nowhere." });
  expect(await update.handler({ name: "release-steps", action: "move", scope: "global", reason: "Every project does it so." }, ctx)).toMatchObject({ scope: "global" });
  expect(learned.versions(skill.id).map((v) => v.change).slice(0, 4)).toEqual(["move", "move", "restore", "archive"]);
});

test("a file skill is refused, and an unknown one is unknown", async () => {
  const { ctx, update } = setup();
  expect(await update.handler({ name: "house-style", action: "archive", reason: "x" }, ctx)).toEqual({ error: "This skill is a file the user maintains. Tell the user what should change." });
  expect(await update.handler({ name: "no-such-skill", action: "archive", reason: "x" }, ctx)).toEqual({ error: "Unknown skill: no-such-skill" });
});

test("every change sends one news notice with the reason, linking to that revision", async () => {
  const { sent, skill, ctx, load, update } = setup();
  await load();
  await update.handler({ name: "release-steps", action: "patch", old_text: "3. Ship.", new_text: "3. Ship to all.", reason: "Ship means all nodes." }, ctx);
  await update.handler({ name: "release-steps", action: "archive", reason: "The user asked." }, ctx);
  await update.handler({ name: "release-steps", action: "restore", reason: "The user asked." }, ctx);
  expect(sent.map((n) => [n.title, n.text, n.level, n.source])).toEqual([
    ["Skill updated: release-steps", "Ship means all nodes.", "news", "system"],
    ["Skill archived: release-steps", "The user asked.", "news", "system"],
    ["Skill restored: release-steps", "The user asked.", "news", "system"]
  ]);
  expect(sent[0]!.matter).toEqual({ key: `skill:${skill.id}:2`, link: `/memory?view=skills&skill=${skill.id}&revision=2` });
});

test("managers have manage_skill and workers do not", () => {
  const registry = new SkillRegistry();
  const names = (scope: "manager" | "worker") => buildSkillToolPacks({ scope, skillRegistry: registry }).flatMap((pack) => pack.tools.map((tool) => tool.name));
  expect([names("manager").includes("manage_skill"), names("worker").includes("manage_skill")]).toEqual([true, false]);
  expect(names("manager")).not.toContain("update_skill");
});

test("managers read when to change a skill, workers to report a wrong step", async () => {
  const { env, project, registry } = setup();
  const workerId = seedWorker(env.workers, project);
  const workerThread = env.agentStore.getOrCreateThread("worker", workerId);
  const workerScope = buildWorkerScope({ agentStore: env.agentStore, projectsStore: env.projects, workersStore: env.workers, skillRegistry: registry } as unknown as WorkerScopeDeps);
  const workerContext = (await workerScope.buildInitialContext!(workerThread.id))!;
  expect(workerContext).toContain("When a step of a skill you followed turned out wrong, missing or outdated, say so plainly in your report, with what actually worked.");
  expect(workerContext).not.toContain("manage_skill");
  const manager = env.agentStore.createManagerThread("Releases");
  const managerScope = buildManagerScope({ agentStore: env.agentStore, projectsStore: env.projects, workersStore: env.workers, skillRegistry: registry } as never);
  const managerContext = (await managerScope.buildInitialContext!(manager.id))!;
  expect(managerContext).toContain("change it with `manage_skill` before you finish, with the reason. When the user asks to undo a change to a skill, or to archive, restore or move one, do it with `manage_skill`.");
  expect(managerContext).toContain("call `request_skill_review` for the conversation where the work was done");
});

test("the personal agent gets manage_skill from the managers' tools", () => {
  const registry = new SkillRegistry();
  const personal = pickPersonalReusedTools(buildSkillToolPacks({ scope: "manager", skillRegistry: registry }));
  expect(personal.tools.map((tool) => tool.name)).toContain("manage_skill");
});

test("after a move, revert, archive or restore, a text change needs the skill loaded again", async () => {
  const { learned, skill, ctx, load, update } = setup();
  await load();
  // Another agent edits it; this one then moves it without reading it again.
  learned.change(skill.id, 1, { body: "1. Tag.\n2. Build.\n3. Ship.\n4. Their step.", change: "patch", by: "agent", threadId: "thr_other" });
  expect(await update.handler({ name: "release-steps", action: "move", scope: "bakery", reason: "x" }, ctx)).toMatchObject({ revision: 3 });
  expect(await update.handler({ name: "release-steps", action: "rewrite", body: "1. Tag.\n2. Build.", reason: "x" }, ctx)).toEqual({ error: "The skill changed since you loaded it. Load it again." });
  expect(learned.get(skill.id)?.body).toContain("4. Their step.");
  // Never loaded at all: an archive does not make it editable.
  const fresh = learned.create({ name: "other-steps", description: "x", body: "a", where: GLOBAL, by: "review" });
  if (!fresh.ok) throw new Error(fresh.message);
  await update.handler({ name: "other-steps", action: "archive", reason: "x" }, ctx);
  await update.handler({ name: "other-steps", action: "restore", reason: "x" }, ctx);
  expect(await update.handler({ name: "other-steps", action: "rewrite", body: "b", reason: "x" }, ctx)).toEqual({ error: "Load the skill with `skill` first; you can only edit a skill you loaded in this conversation." });
});

test("a change that only adds is saved, and its answer says to fold it into its step", async () => {
  const { learned, skill, ctx, load, update } = setup();
  await load();
  const added = "3. Ship.\n- Check the tag.\n- Check the build.\n- Check the notes.\n- Check the mirror.\n- Check the page.";
  const result = await update.handler({ name: "release-steps", action: "patch", old_text: "3. Ship.", new_text: added, reason: "Five checks were missing." }, ctx);
  expect(result).toEqual({
    name: "release-steps", revision: 2, status: "available", scope: "global",
    advice: [
      "This change only adds to the skill: fold what it teaches into the step it corrects or adds to, and take out what that step no longer needs.",
      "The change is saved; change it again if it should read otherwise."
    ]
  });
  expect(learned.get(skill.id)?.body).toContain("- Check the page.");
});

test("a restore with a new text is a text change: it needs the skill loaded at its current revision", async () => {
  const { learned, skill, ctx, load, update } = setup();
  await load();
  // Another writer changes and archives it after this conversation loaded it.
  learned.change(skill.id, 1, { body: "1. Tag.\n2. Build.\n3. Ship.\n4. Their step.", change: "patch", by: "review" });
  learned.change(skill.id, 2, { status: "archived", archivedReason: "Old.", change: "archive", by: "review" });
  expect(await update.handler({ name: "release-steps", action: "restore", revision: 1, body: "1. Tag.", reason: "x" }, ctx)).toEqual({ error: "The skill changed since you loaded it. Load it again." });
  expect(learned.get(skill.id)?.body).toContain("4. Their step.");
  // Restored as it is, it needs no load.
  expect(await update.handler({ name: "release-steps", action: "restore", reason: "The user asked." }, ctx)).toMatchObject({ status: "available" });
});
