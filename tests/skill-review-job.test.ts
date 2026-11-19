import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { LearnedSkillStore } from "../src/server/modules/skills/learned-skill-store.js";
import { BackgroundTaskStore } from "../src/server/modules/agent/background-task-store.js";
import { createSkillReviewJob, type SkillReviewJobDeps } from "../src/server/modules/skills/skill-review-job.js";
import { projectIdsOfThread } from "../src/server/modules/task-board/work-ran-in.js";
import type { NotifyRequest } from "../src/server/modules/notifications/notification-service.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { freshStoresEnv, seedProject, seedWorker } from "./helpers/fixtures.js";
import { runCleanups } from "./helpers/cleanup.js";
import { hasThreadReadFile } from "../src/server/modules/agent/tools/read-file.js";

afterEach(() => runCleanups());

type Call = { toolName: string; args: unknown };
let callId = 0;
const step = (calls: Call[]) => ({ toolCalls: calls.map((c) => ({ toolCallId: `c${++callId}`, toolName: c.toolName, args: c.args })), finishReason: "tool-calls" as const });
const finish = (outcome: string, reason: string): Call => ({ toolName: "finish", args: { outcome, reason } });
const readSkill = (name: string): Call => ({ toolName: "read_skill", args: { name } });
const RENEWAL = "1. Stop the till.\n2. Renew.\n3. Start the till.";
const create = (over: Record<string, unknown> = {}): Call => ({ toolName: "manage_skill", args: { action: "create", name: "cert-renewal", description: "Renew the shop's certificates.", body: RENEWAL, scope: "bakery", reason: "The renewal only worked with the till stopped.", ...over } });

function setup(scripted: Parameters<typeof createMockLLM>[0], over: Partial<SkillReviewJobDeps> = {}) {
  const env = freshStoresEnv("md-skill-review-job-");
  const project = seedProject(env.projects, { name: "bakery", tmuxSessionName: "md-bk" });
  const learned = new LearnedSkillStore(env.store.db, () => new Set(["house-style"]));
  const manager = env.agentStore.createManagerThread("Bakery");
  const workerId = seedWorker(env.workers, project, { name: "cert renewal", tmuxWindowName: "md-w1", ownerThreadId: manager.id });
  const workerThread = env.agentStore.getOrCreateThread("worker", workerId);
  for (const text of ["Renew the certificates.", "It failed until the till was stopped.", "Renewed."]) {
    env.agentStore.appendMessage({ threadId: workerThread.id, role: "user", source: "user", content: { type: "text", text } });
  }
  const model = createMockLLM(scripted, { mode: "stream" });
  const sent: NotifyRequest[] = [];
  const job = createSkillReviewJob({
    store: learned,
    agentStore: env.agentStore,
    workersStore: env.workers,
    projectsStore: env.projects,
    backgroundTasks: new BackgroundTaskStore(env.store.db),
    projectIdsOfThread: projectIdsOfThread({ workersStore: env.workers }),
    fileSkillNames: () => new Set(["house-style"]),
    lookupTools: () => [],
    candidates: () => [{ model, provider: "mock", modelName: "mock-1" }],
    notify: (n) => { sent.push(n); },
    ...over
  });
  const request = (focus = "the renewal order that worked") => learned.requestReview({ threadId: workerThread.id, requestedBy: manager.id, focus, fromSeq: 1, toSeq: 3 });
  return { env, project, learned, manager, workerThread, model, sent, job, request };
}

test("a review that creates a skill writes revision 1 by review, moves the mark and sends a notice", async () => {
  const t = setup([step([create()]), step([finish("created", "Kept the renewal order.")])]);
  const { id } = t.request();
  await t.job.tick();
  const skill = t.learned.getByName("cert-renewal")!;
  expect([skill.revision, skill.body, skill.where]).toEqual([1, RENEWAL, { scope: "project", projectId: t.project }]);
  expect(t.learned.versions(skill.id)[0]).toMatchObject({ by: "review", runId: id, threadId: t.workerThread.id, reason: "The renewal only worked with the till stopped." });
  expect(t.learned.review(id)).toMatchObject({ status: "succeeded", outcome: "created", skillId: skill.id, revision: 1, reason: "Kept the renewal order." });
  expect(t.learned.reviewMark(t.workerThread.id)).toBe(3);
  expect(t.sent.map((n) => [n.title, n.text])).toEqual([["Skill learned: cert-renewal", "The renewal only worked with the till stopped."]]);
  // The opening named the request, the range and the focus.
  const opening = JSON.stringify(t.model.streamCalls[0]!.prompt);
  expect(opening).toContain("the renewal order that worked");
  expect(opening).toContain("#2 user: It failed until the till was stopped.");
});

test("a change to a second skill in one run is refused; another call on the same skill replaces its change", async () => {
  const t = setup([
    step([create()]),
    step([create({ name: "cert-renewal-2" })]),
    step([create({ body: "1. Stop the till.\n2. Renew.\n3. Start the till.\n4. Check the expiry." })]),
    step([finish("created", "x")])
  ]);
  t.request();
  await t.job.tick();
  expect(JSON.stringify(t.model.streamCalls[2]!.prompt)).toContain("You have made this review's one change.");
  expect(t.learned.getByName("cert-renewal-2")).toBeNull();
  const skill = t.learned.getByName("cert-renewal")!;
  expect([skill.revision, skill.body]).toEqual([1, "1. Stop the till.\n2. Renew.\n3. Start the till.\n4. Check the expiry."]);
  expect(t.sent).toHaveLength(1);
  // One tool for every writer, offered with this review's actions.
  const offered = t.model.streamCalls[0]!.tools?.map((tool) => tool.name) ?? [];
  expect(offered).toContain("manage_skill");
  expect(offered).not.toContain("save_skill");
});

test("a review's change that only adds is staged, and told to fold it into its step", async () => {
  const appended = "3. Start the till.\n- Check A.\n- Check B.\n- Check C.\n- Check D.\n- Check E.";
  const t = setup([
    step([readSkill("cert-renewal")]),
    step([{ toolName: "manage_skill", args: { action: "patch", name: "cert-renewal", revision: 1, old_text: "3. Start the till.", new_text: appended, reason: "Five checks." } }]),
    step([finish("changed", "Added the checks.")])
  ]);
  const made = t.learned.create({ name: "cert-renewal", description: "Renew.", body: RENEWAL, where: { scope: "user" }, by: "agent" });
  if (!made.ok) throw new Error(made.message);
  t.request();
  await t.job.tick();
  const told = JSON.stringify(t.model.streamCalls[2]!.prompt);
  expect(told).toContain("This change only adds to the skill: fold what it teaches into the step it corrects or adds to, and take out what that step no longer needs.");
  expect(told).toContain("To do it otherwise, call manage_skill again on this skill: that replaces this change.");
  // Advice never refuses: the change is saved as staged.
  expect(t.learned.getByName("cert-renewal")!.body).toContain("- Check E.");
});

test("rewrite or patch needs the revision read in this run", async () => {
  const t = setup([
    step([{ toolName: "manage_skill", args: { action: "patch", name: "cert-renewal", revision: 1, old_text: "2. Renew.", new_text: "2. Renew with --force.", reason: "x" } }]),
    step([readSkill("cert-renewal")]),
    step([{ toolName: "manage_skill", args: { action: "patch", name: "cert-renewal", revision: 1, old_text: "2. Renew.", new_text: "2. Renew with --force.", reason: "The renewal needs --force." } }]),
    step([finish("changed", "Added --force.")])
  ]);
  const made = t.learned.create({ name: "cert-renewal", description: "Renew.", body: RENEWAL, where: { scope: "user" }, by: "agent" });
  if (!made.ok) throw new Error(made.message);
  t.request();
  await t.job.tick();
  expect(JSON.stringify(t.model.streamCalls[1]!.prompt)).toContain("Read the skill with `read_skill` in this review first.");
  expect(t.learned.getByName("cert-renewal")!.body).toBe("1. Stop the till.\n2. Renew with --force.\n3. Start the till.");
  expect(t.sent.map((n) => n.title)).toEqual(["Skill updated: cert-renewal"]);
});

test("a skill changed by another agent during the review is not overwritten", async () => {
  let learned!: LearnedSkillStore;
  let skillId = "";
  const t = setup([
    step([readSkill("cert-renewal")]),
    step([{ toolName: "manage_skill", args: { action: "rewrite", name: "cert-renewal", revision: 1, body: "review's text", reason: "x" } }]),
    step([finish("changed", "Rewrote it.")])
  ]);
  learned = t.learned;
  const made = learned.create({ name: "cert-renewal", description: "Renew.", body: RENEWAL, where: { scope: "user" }, by: "agent" });
  if (!made.ok) throw new Error(made.message);
  skillId = made.skill.id;
  const model = t.model;
  const original = model.doStream.bind(model);
  let calls = 0;
  // Between the save and the end, a manager edits the skill.
  model.doStream = async (options) => {
    calls += 1;
    if (calls === 3) learned.change(skillId, 1, { body: "manager's text", change: "rewrite", by: "agent" });
    return original(options);
  };
  const { id } = t.request();
  await t.job.tick();
  expect(learned.get(skillId)!.body).toBe("manager's text");
  expect(learned.review(id)).toMatchObject({ status: "failed" });
  expect(learned.reviewMark(t.workerThread.id)).toBeNull();
});

test("a review that ends with finish and no change moves the mark and changes nothing", async () => {
  const t = setup([step([finish("none", "A one-off; nothing will recur.")])]);
  const { id } = t.request();
  await t.job.tick();
  expect(t.learned.list()).toEqual([]);
  expect(t.learned.review(id)).toMatchObject({ status: "succeeded", outcome: "none", reason: "A one-off; nothing will recur." });
  expect(t.learned.reviewMark(t.workerThread.id)).toBe(3);
  expect(t.sent).toEqual([]);
});

test("a target deleted meanwhile is skipped without a model call", async () => {
  const t = setup([step([finish("none", "x")])]);
  const { id } = t.request();
  t.env.store.db.prepare("delete from agent_threads where id = ?").run(t.workerThread.id);
  await t.job.tick();
  expect(t.learned.review(id)).toMatchObject({ status: "skipped" });
  expect(t.model.callsMade).toBe(0);
});

test("the step limit or a cut-off reply ends the run failed with nothing saved; no output cap is asked for", async () => {
  // Steps: it saves, then never finishes within its 3 steps.
  const t = setup([step([create()]), step([readSkill("house-style")]), step([readSkill("house-style")])], { limits: { steps: 3 } });
  const { id } = t.request();
  await t.job.tick();
  expect(t.learned.review(id)).toMatchObject({ status: "failed", error: "The review used its 3 steps without finishing." });
  expect(t.learned.getByName("cert-renewal")).toBeNull();
  expect(t.learned.reviewMark(t.workerThread.id)).toBeNull();
  // No output cap of its own: a whole skill's rewrite is one tool call.
  expect(t.model.streamCalls[0]!.maxOutputTokens).toBeUndefined();
  const cut = setup([step([create()]), { text: "…", finishReason: "length" }]);
  const second = cut.request();
  await cut.job.tick();
  expect(cut.learned.review(second.id)?.status).toBe("failed");
  expect(cut.learned.getByName("cert-renewal")).toBeNull();
});

test("a review that never finishes stops at 50 steps", async () => {
  const t = setup(Array.from({ length: 51 }, () => step([readSkill("house-style")])));
  const { id } = t.request();
  await t.job.tick();
  expect(t.learned.review(id)).toMatchObject({ status: "failed", error: "The review used its 50 steps without finishing." });
  expect(t.model.callsMade).toBe(50);
});

test("reviews run one at a time, in the order asked", async () => {
  const t = setup([step([finish("none", "first")]), step([finish("none", "second")])]);
  const other = t.env.agentStore.createManagerThread("Shop");
  t.env.agentStore.appendMessage({ threadId: other.id, role: "user", source: "user", content: { type: "text", text: "work" } });
  const first = t.request();
  const second = t.learned.requestReview({ threadId: other.id, requestedBy: other.id, focus: "x", fromSeq: 1, toSeq: 1 });
  await Promise.all([t.job.tick(), t.job.tick()]);
  expect([t.learned.review(first.id)?.status, t.learned.review(second.id)?.status]).toEqual(["succeeded", "queued"]);
  await t.job.tick();
  expect(t.learned.review(second.id)?.reason).toBe("second");
  // The first run's own start of the next one comes after; it finds none.
  await new Promise((resolve) => setTimeout(resolve, 0));
});


test("read_transcript reads earlier than the range and the subagents' threads, and no other thread", async () => {
  const t = setup([]);
  const tasks = new BackgroundTaskStore(t.env.store.db);
  const child = t.env.agentStore.createSubagentThread("task_probe");
  tasks.create({ id: "task_probe", parentThreadId: t.workerThread.id, childThreadId: child.id, type: "general", title: "check the till", task: "Is the till up?" });
  t.env.agentStore.appendMessage({ threadId: child.id, role: "user", source: "subagent-task", content: { type: "text", text: "Is the till up?" } });
  const stranger = t.env.agentStore.createManagerThread("Elsewhere");
  t.env.agentStore.appendMessage({ threadId: stranger.id, role: "user", source: "user", content: { type: "text", text: "private" } });
  const model = createMockLLM([
    step([{ toolName: "read_transcript", args: { from_seq: 1, to_seq: 2 } }]),
    step([{ toolName: "read_transcript", args: { thread: child.id, from_seq: 1, to_seq: 5 } }]),
    step([{ toolName: "read_transcript", args: { thread: stranger.id, from_seq: 1, to_seq: 5 } }]),
    step([finish("none", "x")])
  ], { mode: "stream" });
  const job = createSkillReviewJob({
    store: t.learned, agentStore: t.env.agentStore, workersStore: t.env.workers, projectsStore: t.env.projects, backgroundTasks: tasks,
    projectIdsOfThread: () => [], fileSkillNames: () => new Set(), lookupTools: () => [],
    candidates: () => [{ model, provider: "mock", modelName: "mock-1" }]
  });
  t.learned.requestReview({ threadId: t.workerThread.id, requestedBy: t.manager.id, focus: "x", fromSeq: 3, toSeq: 3 });
  await job.tick();
  const opening = JSON.stringify(model.streamCalls[0]!.prompt);
  expect(opening).not.toContain("#1 user: Renew the certificates.");
  expect(opening).toContain(`check the till: thread ${child.id}`);
  const last = JSON.stringify(model.streamCalls[3]!.prompt);
  expect(last).toContain("#1 user: Renew the certificates.");
  expect(last).toContain("#1 subagent-task: Is the till up?");
  expect(last).toContain("That thread is not part of this work.");
  expect(last).not.toContain("private");
});

test("with no model to run on, a review waits queued and nothing loops on it", async () => {
  let asked = 0;
  const t = setup([], { candidates: () => { asked += 1; return []; } });
  const { id } = t.request();
  await t.job.tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect([t.learned.review(id)?.status, asked]).toEqual(["queued", 1]);
});

test("a run whose end cannot be written saves no skill", async () => {
  const t = setup([step([create()]), step([finish("created", "x")])]);
  const { id } = t.request();
  t.learned.setReviewMark = () => { throw new Error("disk I/O error"); };
  await t.job.tick();
  expect(t.learned.getByName("cert-renewal")).toBeNull();
  expect(t.learned.review(id)?.status).toBe("failed");
  expect(t.sent).toEqual([]);
});

test("a reply cut at the output limit ends the run, even with a fallback model", async () => {
  const t = setup([step([create()]), { text: "…", finishReason: "length" }]);
  const fallback = createMockLLM([step([finish("created", "x")])], { mode: "stream" });
  const job = createSkillReviewJob({
    store: t.learned, agentStore: t.env.agentStore, workersStore: t.env.workers, projectsStore: t.env.projects, backgroundTasks: new BackgroundTaskStore(t.env.store.db),
    projectIdsOfThread: () => [], fileSkillNames: () => new Set(), lookupTools: () => [],
    candidates: () => [{ model: t.model, provider: "mock", modelName: "mock-1" }, { model: fallback, provider: "mock", modelName: "mock-2" }]
  });
  const { id } = t.request();
  await job.tick();
  expect(t.learned.review(id)?.status).toBe("failed");
  expect(t.learned.getByName("cert-renewal")).toBeNull();
  expect(fallback.callsMade).toBe(0);
});

test("a long skill and a long transcript page reach the review whole", async () => {
  const body = Array.from({ length: 350 }, (_, i) => `${String(i).padStart(3, "0")} ${"s".repeat(95)}`).join("\n");
  const t = setup([step([readSkill("long-steps")]), step([{ toolName: "read_transcript", args: { from_seq: 4, to_seq: 6 } }]), step([finish("none", "x")])]);
  const made = t.learned.create({ name: "long-steps", description: "x", body, where: { scope: "user" }, by: "agent" });
  if (!made.ok) throw new Error(made.message);
  for (const mark of ["first", "second", "third"]) {
    t.env.agentStore.appendMessage({ threadId: t.workerThread.id, role: "user", source: "user", content: { type: "text", text: `${mark} ${"t".repeat(15_000)} ${mark}-end` } });
  }
  t.learned.requestReview({ threadId: t.workerThread.id, requestedBy: t.manager.id, focus: "x", fromSeq: 1, toSeq: 3 });
  await t.job.tick();
  const afterSkill = JSON.stringify(t.model.streamCalls[1]!.prompt);
  expect(afterSkill).toContain("349 ");
  const afterTranscript = JSON.stringify(t.model.streamCalls[2]!.prompt);
  for (const mark of ["first-end", "second-end", "third-end"]) expect(afterTranscript).toContain(mark);
  expect(afterTranscript).not.toContain("persisted-output");
});

test("a reply that says the turn goes on does not end the review", async () => {
  const t = setup([
    { text: "I'll read the existing skill first.", finishReason: "stop", providerMetadata: { codex: { endTurn: false } } },
    step([finish("none", "Nothing new to keep.")])
  ]);
  const { id } = t.request();
  await t.job.tick();
  expect(t.model.callsMade).toBe(2);
  expect(t.learned.review(id)).toMatchObject({ status: "succeeded", reason: "Nothing new to keep." });
});

test("a reply the provider filtered ends the run with nothing saved", async () => {
  const t = setup([step([create()]), { text: "", finishReason: "content-filter" }]);
  const { id } = t.request();
  await t.job.tick();
  expect(t.learned.review(id)?.status).toBe("failed");
  expect(t.learned.getByName("cert-renewal")).toBeNull();
  expect(t.learned.reviewMark(t.workerThread.id)).toBeNull();
});

test("a patch with no replacement text is refused, not taken as a deletion", async () => {
  const t = setup([
    step([readSkill("cert-renewal")]),
    step([{ toolName: "manage_skill", args: { action: "patch", name: "cert-renewal", revision: 1, old_text: "2. Renew.", reason: "x" } }]),
    step([finish("none", "x")])
  ]);
  const made = t.learned.create({ name: "cert-renewal", description: "Renew.", body: RENEWAL, where: { scope: "user" }, by: "agent" });
  if (!made.ok) throw new Error(made.message);
  t.request();
  await t.job.tick();
  expect(JSON.stringify(t.model.streamCalls[2]!.prompt)).toContain("Give `new_text`.");
  expect(t.learned.getByName("cert-renewal")!.body).toBe(RENEWAL);
});

test("a filtered reply with no output and no usage still ends the run, not a retry that saves", async () => {
  const t = setup([
    step([create()]),
    { text: "", finishReason: "content-filter", usage: { promptTokens: 0, completionTokens: 0 } },
    step([finish("created", "x")])
  ]);
  const { id } = t.request();
  await t.job.tick();
  expect(t.learned.review(id)?.status).toBe("failed");
  expect(t.learned.getByName("cert-renewal")).toBeNull();
  expect(t.model.callsMade).toBe(2);
});

test("a filtered or cut-off reply's call record keeps what the reply showed of itself", async () => {
  for (const ending of [
    { text: "", reasoning: ["Thinking it over."], finishReason: "content-filter" as const, usage: { promptTokens: 0, completionTokens: 0 } },
    { text: "Partly…", finishReason: "length" as const }
  ]) {
    const finished: Array<{ status: string; error?: unknown }> = [];
    const recorder = { startCall: () => "llm_x", finishCall: (_id: string, input: { status: string; error?: unknown }) => { finished.push(input); } };
    const t = setup([step([create()]), ending]);
    const job = createSkillReviewJob({
      store: t.learned, agentStore: t.env.agentStore, workersStore: t.env.workers, projectsStore: t.env.projects, backgroundTasks: new BackgroundTaskStore(t.env.store.db),
      projectIdsOfThread: () => [], fileSkillNames: () => new Set(), lookupTools: () => [],
      candidates: () => [{ model: t.model, provider: "mock", modelName: "mock-1", recorder: recorder as never }]
    });
    const { id } = t.request();
    await job.tick();
    expect([ending.finishReason, t.learned.review(id)?.status, t.learned.getByName("cert-renewal")]).toEqual([ending.finishReason, "failed", null]);
    const failed = finished.find((f) => f.status === "failed")!;
    expect([ending.finishReason, typeof (failed.error as { firstOutputMs?: unknown }).firstOutputMs]).toEqual([ending.finishReason, "number"]);
  }
});

test("read opens files as far as the reviewed worker could, no farther, and leaves the worker's own reads alone", async () => {
  const savedArgs = { path: "" };
  const outside = "/md-review-outside/notes.txt";
  const t = setup([step([{ toolName: "read", args: savedArgs }, { toolName: "read", args: { path: outside } }]), step([finish("none", "x")])]);
  // A file the work saved, inside the worker's reach.
  savedArgs.path = path.join(t.env.dir, "renewal-output.txt");
  fs.writeFileSync(savedArgs.path, "renewed 3 certificates\n");
  t.request();
  await t.job.tick();
  const after = JSON.stringify(t.model.streamCalls[1]!.prompt);
  expect(after).toContain("renewed 3 certificates");
  expect(after).toContain("path is outside worker scope");
  expect(hasThreadReadFile(t.workerThread.id, savedArgs.path)).toBe(false);
});

test("a manager's review reads as far as the manager could", async () => {
  const t = setup([step([{ toolName: "read", args: { path: "/md-review-outside/notes.txt" } }]), step([finish("none", "x")])]);
  t.env.agentStore.appendMessage({ threadId: t.manager.id, role: "user", source: "user", content: { type: "text", text: "Plan the renewals." } });
  t.learned.requestReview({ threadId: t.manager.id, requestedBy: t.manager.id, focus: "x", fromSeq: 1, toSeq: 1 });
  await t.job.tick();
  const after = JSON.stringify(t.model.streamCalls[1]!.prompt);
  expect(after).toContain("File does not exist.");
  expect(after).not.toContain("outside worker scope");
});

test("a review looks the chat history up as the agent that asked for it", async () => {
  const { reviewLookupTools } = await import("../src/server/modules/skills/skill-review-tools.js");
  const { buildChatHistoryTools } = await import("../src/server/modules/agent/tools/chat-history.js");
  let db: import("bun:sqlite").Database | null = null;
  const t = setup([
    step([{ toolName: "chat_history_search", args: { query: "till", timeRange: { preset: "all" } } }]),
    step([finish("none", "Nothing new.")])
  ], { lookupTools: () => reviewLookupTools({ memoryTools: [], historyTools: buildChatHistoryTools({ db: db!, scope: "manager" }) }) });
  db = t.env.store.db;
  t.request();
  await t.job.tick();
  const answer = JSON.stringify(t.model.streamCalls[1]!.prompt);
  expect(answer).toContain("chat_history_search");
  expect(answer).not.toContain("caller_thread_not_found");
});

// The tidy of all skills rides on the reviews' job: one model run at a time,
// a due review first, the tidy only when no review is due.
test("a tick runs a due review first, a due tidy only when no review is due, never both at once", async () => {
  const order: string[] = [];
  let release: () => void = () => {};
  const tidy = {
    due: () => true,
    run: () => { order.push("tidy"); return new Promise<void>((resolve) => { release = resolve; }); }
  };
  const t = setup([step([finish("none", "Nothing to keep.")])], { tidy });
  t.request();
  await t.job.tick();
  expect([order, t.learned.recentReviews(1)[0]?.status]).toEqual([[], "succeeded"]);
  const tidying = t.job.tick();
  await Promise.resolve();
  expect(order).toEqual(["tidy"]);
  // While the tidy runs, a review of another thread waits and no second tidy starts.
  const queued = t.learned.requestReview({ threadId: t.manager.id, requestedBy: t.manager.id, focus: "the plan", fromSeq: 1, toSeq: 1 });
  await t.job.tick();
  expect([order, t.learned.review(queued.id)?.status]).toEqual([["tidy"], "queued"]);
  release();
  await tidying;
});
