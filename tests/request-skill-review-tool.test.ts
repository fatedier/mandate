import { afterEach, expect, test } from "bun:test";
import { SkillRegistry } from "../src/server/modules/skills/skill-registry.js";
import { LearnedSkillStore } from "../src/server/modules/skills/learned-skill-store.js";
import { buildRequestSkillReviewTool } from "../src/server/modules/skills/request-skill-review-tool.js";
import { buildSkillToolPacks } from "../src/server/modules/skills/tool-packs.js";
import { pickPersonalReusedTools } from "../src/server/modules/personal/personal-scope.js";
import { resolveReviewTarget } from "../src/server/modules/skills/review-target.js";
import { projectIdsOfThread } from "../src/server/modules/task-board/work-ran-in.js";
import type { ToolContext } from "../src/server/modules/agent/tool-registry.js";
import { freshStoresEnv, seedProject, seedWorker } from "./helpers/fixtures.js";
import { runCleanups } from "./helpers/cleanup.js";

afterEach(() => runCleanups());

function setup() {
  const env = freshStoresEnv("md-request-review-");
  const project = seedProject(env.projects, { name: "bakery", tmuxSessionName: "md-bk" });
  const learned = new LearnedSkillStore(env.store.db, () => new Set());
  const manager = env.agentStore.createManagerThread("Bakery");
  const otherManager = env.agentStore.createManagerThread("Shop");
  const workerId = seedWorker(env.workers, project, { name: "cert renewal", tmuxWindowName: "md-w1", ownerThreadId: manager.id });
  const workerThread = env.agentStore.getOrCreateThread("worker", workerId);
  const strangerId = seedWorker(env.workers, project, { name: "someone else", tmuxWindowName: "md-w2", ownerThreadId: otherManager.id });
  const strangerThread = env.agentStore.getOrCreateThread("worker", strangerId);
  for (let i = 0; i < 5; i++) env.agentStore.appendMessage({ threadId: workerThread.id, role: "user", source: "user", content: { type: "text", text: `step ${i}` } });
  for (const threadId of [strangerThread.id, otherManager.id]) env.agentStore.appendMessage({ threadId, role: "user", source: "user", content: { type: "text", text: "work" } });
  const personal = env.agentStore.getOrCreatePersonalThread();
  let kicked = 0;
  const registry = new SkillRegistry();
  registry.attachLearned({
    store: learned,
    projectName: (id) => env.projects.getById(id)?.name ?? null,
    projectIdByName: () => null,
    projectIdsOfThread: projectIdsOfThread({ workersStore: env.workers }),
    reviewTarget: (requesterThreadId, ref) => resolveReviewTarget({ agentStore: env.agentStore, workersStore: env.workers, store: learned }, requesterThreadId, ref),
    reviewRequested: () => { kicked += 1; }
  });
  const tool = buildRequestSkillReviewTool(registry);
  const ctxOf = (threadId: string, kind: "manager" | "personal") => ({ threadId, wakeId: "w", scope: { kind } }) as unknown as ToolContext;
  return { env, learned, manager, otherManager, workerId, workerThread, strangerThread, personal, tool, ctxOf, kicked: () => kicked };
}

test("a manager requests a review of its worker's conversation; a second request joins it", async () => {
  const { learned, manager, workerThread, tool, ctxOf, kicked } = setup();
  expect(await tool.handler({ thread: "cert renewal", focus: "the renewal order that worked" }, ctxOf(manager.id, "manager"))).toBe("Requested. The user will be told if a skill is written or changed.");
  expect(await tool.handler({ thread: workerThread.id, focus: "the oven pitfall" }, ctxOf(manager.id, "manager"))).toBe("Requested. The user will be told if a skill is written or changed.");
  const queued = learned.nextQueuedReview();
  expect(queued && [queued.threadId, queued.requestedBy, queued.focus, queued.fromSeq, queued.toSeq]).toEqual([workerThread.id, manager.id, "the renewal order that worked; the oven pitfall", 1, 5]);
  expect(kicked()).toBe(2);
});

test("a manager reviews only its own workers' conversations; the personal agent any manager's or worker's", async () => {
  const { manager, strangerThread, otherManager, personal, tool, ctxOf } = setup();
  expect(await tool.handler({ thread: strangerThread.id, focus: "x" }, ctxOf(manager.id, "manager"))).toEqual({ error: `There is no conversation ${strangerThread.id} you can ask a review of.` });
  expect(await tool.handler({ thread: "someone else", focus: "x" }, ctxOf(personal.id, "personal"))).toBe("Requested. The user will be told if a skill is written or changed.");
  expect(await tool.handler({ thread: "Shop", focus: "x" }, ctxOf(personal.id, "personal"))).toBe("Requested. The user will be told if a skill is written or changed.");
  expect(await tool.handler({ thread: otherManager.id, focus: "x" }, ctxOf(manager.id, "manager"))).toEqual({ error: `There is no conversation ${otherManager.id} you can ask a review of.` });
});

// By id, any conversation the requester may ask about, archived ones too (a
// manager's archived workers, the personal agent's archived manager threads);
// by name, the ones its context lists: active workers, open manager threads.
test("an archived manager thread is reviewed when named by id, not by its old title", async () => {
  const { env, otherManager, personal, tool, ctxOf } = setup();
  env.agentStore.archiveThread(otherManager.id);
  expect(await tool.handler({ thread: otherManager.id, focus: "x" }, ctxOf(personal.id, "personal"))).toBe("Requested. The user will be told if a skill is written or changed.");
  expect(await tool.handler({ thread: "Shop", focus: "x" }, ctxOf(personal.id, "personal"))).toEqual({ error: "There is no conversation Shop you can ask a review of." });
});

test("a manager names its archived worker by name or id", async () => {
  const { env, manager, workerId, workerThread, learned, tool, ctxOf } = setup();
  env.workers.archive(workerId);
  expect(await tool.handler({ thread: "cert renewal", focus: "x" }, ctxOf(manager.id, "manager"))).toBe("Requested. The user will be told if a skill is written or changed.");
  expect(await tool.handler({ thread: workerId, focus: "y" }, ctxOf(manager.id, "manager"))).toBe("Requested. The user will be told if a skill is written or changed.");
  expect(learned.nextQueuedReview()?.threadId).toBe(workerThread.id);
});

test("left blank, the thread is the requester's own", async () => {
  const { env, learned, manager, tool, ctxOf } = setup();
  env.agentStore.appendMessage({ threadId: manager.id, role: "user", source: "user", content: { type: "text", text: "coordinate it" } });
  await tool.handler({ thread: "", focus: "how this was coordinated" }, ctxOf(manager.id, "manager"));
  expect(learned.nextQueuedReview()?.threadId).toBe(manager.id);
});

test("the range starts after the last reviewed point, or covers the last 300 messages", () => {
  const { env, learned, manager, workerThread } = setup();
  const target = (ref: string) => resolveReviewTarget({ agentStore: env.agentStore, workersStore: env.workers, store: learned }, manager.id, ref);
  expect(target(workerThread.id)).toMatchObject({ threadId: workerThread.id, fromSeq: 1, toSeq: 5 });
  learned.setReviewMark(workerThread.id, 3);
  expect(target(workerThread.id)).toMatchObject({ fromSeq: 4, toSeq: 5 });
  // Nothing new since the last review: the recent work again, as asked.
  learned.setReviewMark(workerThread.id, 5);
  expect(target(workerThread.id)).toMatchObject({ fromSeq: 1, toSeq: 5 });
});

test("workers have no request_skill_review; managers and the personal agent do", () => {
  const registry = new SkillRegistry();
  const names = (scope: "manager" | "worker") => buildSkillToolPacks({ scope, skillRegistry: registry }).flatMap((pack) => pack.tools.map((tool) => tool.name));
  expect([names("manager").includes("request_skill_review"), names("worker").includes("request_skill_review")]).toEqual([true, false]);
  expect(pickPersonalReusedTools(buildSkillToolPacks({ scope: "manager", skillRegistry: registry })).tools.map((tool) => tool.name)).toContain("request_skill_review");
});
