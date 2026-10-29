import { expect, test } from "bun:test";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { ensureOpenOwner, ownerRefusal } from "../src/server/modules/features/ownership.js";
import { buildFeatureMessageSendTool } from "../src/server/modules/agent/tools/feature-message-tools.js";
import { buildWorkItemTools } from "../src/server/modules/agent/tools/work-item-tools.js";
import { buildListFeaturesTool } from "../src/server/modules/features/tools/list-features.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { toolContext } from "./helpers/typed.js";

function setup(prefix: string) {
  const e = freshStoresEnv(prefix);
  const projectId = seedProject(e.projects, { name: "project-1" });
  const a = e.agentStore.createManagerThread("project-1 3.21 release");
  const b = e.agentStore.createManagerThread("Sidebar");
  const featureId = seedFeature(e.features, projectId, { name: "pr-33" });
  e.features.setOwner(featureId, a.id);
  const ctx = (threadId: string) => toolContext({ threadId, wakeId: "wk" });
  return { ...e, projectId, a, b, featureId, ctx };
}

test("features store: owner is stored, read back, and listed by owner", () => {
  const s = setup("md-own-store-");
  try {
    expect(s.features.getById(s.featureId)?.ownerThreadId).toBe(s.a.id);
    expect(s.features.listActiveOwnedBy(s.a.id).map((f) => f.id)).toEqual([s.featureId]);
    expect(s.features.listActiveOwnedBy(s.b.id)).toEqual([]);
    s.features.archive(s.featureId);
    expect(s.features.listActiveOwnedBy(s.a.id)).toEqual([]);
  } finally { s.cleanup(); }
});

test("ownerRefusal: the owner passes; another thread is told whose it is", () => {
  const s = setup("md-own-refuse-");
  try {
    expect(ownerRefusal({ featuresStore: s.features, agentStore: s.agentStore }, s.featureId, s.a.id)).toBe(null);
    expect(ownerRefusal({ featuresStore: s.features, agentStore: s.agentStore }, s.featureId, s.b.id))
      .toBe('Worker "pr-33" belongs to the thread "project-1 3.21 release". Ask the user to continue there.');
  } finally { s.cleanup(); }
});

test("feature_message_send refuses another thread's worker and sends to its own", async () => {
  const s = setup("md-own-msg-");
  try {
    const tool = buildFeatureMessageSendTool({ agentStore: s.agentStore, featuresStore: s.features, wakeScheduler: { wake: () => "wk" } });
    expect(await tool.handler({ featureId: s.featureId, message: "go" }, s.ctx(s.b.id)))
      .toEqual({ error: 'Worker "pr-33" belongs to the thread "project-1 3.21 release". Ask the user to continue there.' });
    expect((await tool.handler({ featureId: s.featureId, message: "go" }, s.ctx(s.a.id))).status).toBe("started");
  } finally { s.cleanup(); }
});

test("dismiss_work_item refuses another thread's worker and clears its own's questions", async () => {
  const s = setup("md-own-wi-");
  try {
    const workStore = new WorkItemStore(s.store.db);
    const planStore = new PlanStore(s.store.db);
    planStore.update(s.featureId, { openQuestions: ["Tag the release?"], steps: [{ title: "Tag" }] });
    const [dismiss] = buildWorkItemTools({ workStore, sse: new AgentSseEmitter(), featuresStore: s.features, agentStore: s.agentStore, planStore });
    const id = workStore.getByFeature(s.featureId)!.id;
    const refusal = { error: 'Worker "pr-33" belongs to the thread "project-1 3.21 release". Ask the user to continue there.' };
    expect(await dismiss!.handler({ id }, s.ctx(s.b.id))).toEqual(refusal);
    expect(planStore.get(s.featureId).openQuestions).toEqual(["Tag the release?"]);
    expect(await dismiss!.handler({ id }, s.ctx(s.a.id))).toEqual({ ok: true });
    expect(planStore.get(s.featureId).openQuestions).toEqual([]);
  } finally { s.cleanup(); }
});

test("list_features names each worker's thread and marks the caller's own", async () => {
  const s = setup("md-own-list-");
  try {
    const tool = buildListFeaturesTool({ featuresStore: s.features, projectsStore: s.projects, agentStore: s.agentStore });
    const other = await tool.handler({}, s.ctx(s.b.id));
    expect(other.features[0]).toMatchObject({ id: s.featureId, ownerThreadId: s.a.id, ownerThreadTitle: "project-1 3.21 release", yours: false });
    const mine = await tool.handler({}, s.ctx(s.a.id));
    expect(mine.features[0]!.yours).toBe(true);
  } finally { s.cleanup(); }
});

test("ensureOpenOwner: keeps a usable owner, takes a usable preferred one, else opens a thread named after the worker", () => {
  const s = setup("md-own-ensure-");
  try {
    const deps = { featuresStore: s.features, agentStore: s.agentStore };
    expect(ensureOpenOwner(deps, s.featureId)).toEqual({ ownerThreadId: s.a.id, changed: false });
    expect(ensureOpenOwner(deps, s.featureId, s.b.id)).toEqual({ ownerThreadId: s.b.id, changed: true });
    // A stale or non-manager preferred id is ignored.
    const worker = s.agentStore.getOrCreateThread("worker", s.featureId);
    expect(ensureOpenOwner(deps, s.featureId, worker.id)).toEqual({ ownerThreadId: s.b.id, changed: false });
    s.agentStore.archiveThread(s.b.id);
    const r = ensureOpenOwner(deps, s.featureId, "thr_missing")!;
    expect(r.changed).toBe(true);
    expect(s.agentStore.getThreadById(r.ownerThreadId)?.title).toBe("pr-33");
    expect(s.features.getById(s.featureId)?.ownerThreadId).toBe(r.ownerThreadId);
  } finally { s.cleanup(); }
});

test("setOwner announces the worker as changed, so its new owner's sweep arms", () => {
  const s = setup("md-own-event-");
  try {
    const seen: string[] = [];
    s.features.onWorkItemChange((e) => seen.push(`${e.kind}:${e.featureId}`));
    s.features.setOwner(s.featureId, s.b.id);
    expect(seen).toStrictEqual([`updated:${s.featureId}`]);
  } finally { s.cleanup(); }
});
