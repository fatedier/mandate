import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { LearnedSkillStore, type LearnedSkillWhere } from "../src/server/modules/skills/learned-skill-store.js";
import { createSkillTidy, type SkillTidyDeps } from "../src/server/modules/skills/skill-tidy.js";
import { AgentLlmCallRecorder } from "../src/server/modules/activity/llm-call-recorder.js";
import type { NotifyRequest } from "../src/server/modules/notifications/notification-service.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { freshStoresEnv, seedProject } from "./helpers/fixtures.js";
import { runCleanups } from "./helpers/cleanup.js";
import { llmCallDetails } from "./helpers/llm-calls.js";

// A tidy of all learned skills: one model run over every skill, its changes
// written together when it ends well, each by the tidy with its reason, and
// the owner told of each.

afterEach(() => runCleanups());

type Call = { toolName: string; args: unknown };
let callId = 0;
const step = (calls: Call[]) => ({ toolCalls: calls.map((c) => ({ toolCallId: `c${++callId}`, toolName: c.toolName, args: c.args })), finishReason: "tool-calls" as const });
const read = (name: string): Call => ({ toolName: "read_skill", args: { name } });
const done = (reason: string): Call => ({ toolName: "finish", args: { reason } });

function setup(scripted: Parameters<typeof createMockLLM>[0], over: Partial<SkillTidyDeps> = {}) {
  const env = freshStoresEnv("md-skill-tidy-");
  const project = seedProject(env.projects, { name: "kitchen", tmuxSessionName: "md-kt" });
  const learned = new LearnedSkillStore(env.store.db, () => new Set());
  const model = createMockLLM(scripted, { mode: "stream" });
  const recorder = new AgentLlmCallRecorder({ store: env.store, logRequests: "metadata", provider: "mock", model: "mock-1", baseURL: "", apiMode: "streamText" });
  const sent: NotifyRequest[] = [];
  const tidy = createSkillTidy({
    store: learned,
    candidates: () => [{ model, provider: "mock", modelName: "mock-1", recorder }],
    lookupTools: () => [],
    projects: () => [{ id: project, name: "kitchen" }],
    projectName: (id) => (id === project ? "kitchen" : null),
    notify: (n) => { sent.push(n); },
    ...over
  });
  const make = (name: string, body: string, where: LearnedSkillWhere = { scope: "user" }) => {
    const made = learned.create({ name, description: `The ${name} work.`, body, where, by: "review", reason: "Created." });
    if (!made.ok) throw new Error(made.message);
    return made.skill;
  };
  return { env, project, learned, model, sent, tidy, make };
}

test("a tidy merges, rewrites and archives as staged, in one write, each change by the tidy with its reason, and tells the owner of each", async () => {
  const t = setup([
    step([read("named-order"), read("nightly-order"), read("release-diary"), read("old-check")]),
    step([
      { toolName: "manage_skill", args: { action: "merge", name: "named-order", revision: 1, absorbed: [{ name: "nightly-order", revision: 1 }], body: "1. Read the order.\n2. Bake at the set time.", reason: "Both take an order the same way." } },
      { toolName: "manage_skill", args: { action: "rewrite", name: "release-diary", revision: 1, body: "1. Tag.\n2. Watch the first batch.", reason: "It had become a record of one release." } },
      { toolName: "manage_skill", args: { action: "archive", name: "old-check", revision: 1, reason: "The scale it checks is gone." } }
    ]),
    step([done("Merged the order skills, rewrote the release skill, archived the old check.")])
  ]);
  const named = t.make("named-order", "1. Take it.");
  const nightly = t.make("nightly-order", "1. Take it at night.");
  const diary = t.make("release-diary", "Round 1: ...\nRound 2: ...");
  const probe = t.make("old-check", "1. Check.");
  await t.tidy.run();
  const [run] = t.learned.recentTidies(1);
  expect(run && [run.status, run.changes, run.reason]).toEqual(["succeeded", 3, "Merged the order skills, rewrote the release skill, archived the old check."]);
  expect(t.learned.get(named.id)?.body).toBe("1. Read the order.\n2. Bake at the set time.");
  expect([t.learned.get(nightly.id)?.status, t.learned.get(nightly.id)?.absorbedInto]).toEqual(["archived", named.id]);
  expect(t.learned.get(diary.id)?.body).toBe("1. Tag.\n2. Watch the first batch.");
  expect(t.learned.get(probe.id)?.status).toBe("archived");
  for (const s of [named, nightly, diary, probe]) {
    expect(t.learned.history(s.id).find((v) => v.revision === 2)).toMatchObject({ by: "tidy", runId: run!.id });
  }
  expect(t.sent.map((n) => [n.title, n.text])).toEqual([
    ["Skill updated: named-order", "Both take an order the same way."],
    ["Skill archived: nightly-order", "Both take an order the same way."],
    ["Skill updated: release-diary", "It had become a record of one release."],
    ["Skill archived: old-check", "The scale it checks is gone."]
  ]);
  // The opening named every skill, available ones first.
  const opening = JSON.stringify(t.model.streamCalls[0]!.prompt);
  expect(opening).toContain("A tidy of the learned skills.");
  expect(opening).toContain("- named-order — The named-order work. (global; revision 1;");
});

test("a tidy whose change no longer applies saves nothing and ends failed", async () => {
  const box: { change?: () => void } = {};
  // A lookup the tidy makes after staging stands for an agent changing a skill meanwhile.
  const meanwhile = { name: "memory_search", description: "Search memory.", parameters: z.object({}), handler: async () => { box.change!(); return []; } };
  const t = setup([
    step([read("deploy-check"), read("check-ovens")]),
    step([
      { toolName: "manage_skill", args: { action: "rewrite", name: "check-ovens", revision: 1, body: "1. Check.", reason: "Shorter." } },
      { toolName: "manage_skill", args: { action: "rewrite", name: "deploy-check", revision: 1, body: "1. Check.", reason: "Shorter." } }
    ]),
    step([{ toolName: "memory_search", args: {} }]),
    step([done("Rewrote both.")])
  ], { lookupTools: () => [meanwhile] });
  const check = t.make("deploy-check", "1. Look.");
  const probe = t.make("check-ovens", "1. Look.");
  box.change = () => { t.learned.change(check.id, 1, { body: "1. Look again.", change: "patch", by: "agent", reason: "A step." }); };
  await t.tidy.run();
  const [run] = t.learned.recentTidies(1);
  expect(run?.status).toBe("failed");
  expect([t.learned.get(probe.id)?.revision, t.learned.get(check.id)?.body]).toEqual([1, "1. Look again."]);
  expect(t.sent).toEqual([]);
});

test("an agent's revert of a tidy's merge puts both skills back", async () => {
  const t = setup([
    step([read("a-steps"), read("b-steps")]),
    step([{ toolName: "manage_skill", args: { action: "merge", name: "a-steps", revision: 1, absorbed: [{ name: "b-steps", revision: 1 }], body: "1. Both.", reason: "Same work." } }]),
    step([done("Merged.")])
  ]);
  const a = t.make("a-steps", "1. A.");
  const b = t.make("b-steps", "1. B.");
  await t.tidy.run();
  expect(t.learned.revert(a.id, { by: "agent", reason: "The user asked." }).ok).toBe(true);
  expect([t.learned.get(a.id)?.body, t.learned.get(b.id)?.status]).toEqual(["1. A.", "available"]);
});

test("a tidy's model calls are recorded as skill_tidy against its run", async () => {
  const t = setup([step([done("Nothing needed to change.")])]);
  t.make("a-steps", "1. A.");
  await t.tidy.run();
  const [run] = t.learned.recentTidies(1);
  expect(run && [run.status, run.changes]).toEqual(["succeeded", 0]);
  const calls = llmCallDetails(t.env.store, 10).filter((c) => c.purpose === "skill_tidy");
  expect(calls.map((c) => [c.scopeType, c.scopeId])).toEqual([["skill_tidy", run!.id]]);
});
