import { expect, test } from "bun:test";
import { createMockLLM } from "./helpers/mock-llm.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { FeatureRecordStore } from "../src/server/modules/plans/record-store.js";
import { stub } from "./helpers/typed.js";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { MemoryManager } from "../src/server/modules/memory/manager.js";
import { EXTRACTION_SYSTEM_PROMPT, extractFromWindow, type ExtractionTrigger } from "../src/server/modules/memory/extraction.js";
import { OUTPUT_LIMIT_FAILURE } from "../src/server/modules/llm/output-limit-failure.js";
import type { AgentMessage } from "../src/server/modules/agent/agent-store.js";
import type { AgentLlmCallRecorder } from "../src/server/modules/activity/llm-call-recorder.js";

const said = (text: string) => stub<AgentMessage>({ id: `m_${text.length}`, threadId: "thr_1", role: "user", source: "user", seq: 1, createdAt: "2026-10-07T00:00:00.000Z", content: { type: "text", text } });
const projects = [{ id: "proj_project1", name: "project-1" }, { id: "proj_project4", name: "project-4" }];

// Each test's record store, by its memory manager (setup makes both).
const recordsOf = new Map<MemoryManager, FeatureRecordStore>();

function run(memory: MemoryManager, output: unknown, options: {
  messages?: AgentMessage[];
  worker?: { featureId: string; projectId: string; name: string } | null;
  trigger?: ExtractionTrigger;
  projectList?: typeof projects;
} = {}) {
  const model = createMockLLM([{ text: JSON.stringify(output) }]);
  const result = extractFromWindow({
    memory, records: recordsOf.get(memory)!, candidates: [{ model, provider: "openai", supportsReasoning: undefined }], repeatCheck: [],
    trigger: options.trigger ?? "compression", threadId: "thr_1",
    messages: options.messages ?? [said("From now on project-1 commit messages are written in English")],
    projects: options.projectList ?? projects, worker: options.worker ?? null, budgetTokens: 50_000
  });
  return { model, result };
}

function setup() {
  const env = freshStoresEnv("md-window-extract-");
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
  const records = new FeatureRecordStore(env.store.db);
  recordsOf.set(memory, records);
  // A worker of a real project: its record belongs to its feature.
  const projectId = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
  const worker = { featureId: seedFeature(env.features, projectId, { name: "UDP framing", tmuxWindowName: "udp" }), projectId, name: "UDP framing" };
  return { env, memory, records, worker };
}

test("a quote found in the window makes a user entry; one that is not becomes an extraction entry", async () => {
  const { env, memory } = setup();
  try {
    const { result } = run(memory, { entries: [
      { type: "preference", scope: "project", projectId: "proj_project1", content: "project-1 commit messages are in English.", userQuote: "project-1 commit messages are written in English" },
      { type: "preference", scope: "user", content: "Prefers short replies.", userQuote: "words nobody said" }
    ] });
    expect(await result).toMatchObject({ processed: true, created: 2, rejected: 0, taskRecord: null });
    const kept = memory.listAvailable({ scope: "project", projectId: "proj_project1" });
    expect(kept).toEqual([expect.objectContaining({ source: "user", userQuote: "project-1 commit messages are written in English", type: "preference" })]);
    expect(memory.listAvailable({ scope: "user", projectId: null }))
      .toEqual([expect.objectContaining({ source: "extraction", userQuote: null })]);
  } finally {
    env.cleanup();
  }
});

// A blank userQuote is no quote: the model filled the template's
// field with "" on entries without one, and the schema's non-empty rule threw
// the whole answer away, every entry in it included.
test("a blank userQuote is no quote: the entry is kept unquoted, and the rest of the answer with it", async () => {
  const { env, memory } = setup();
  try {
    const { result } = run(memory, { entries: [
      { type: "knowledge", scope: "project", projectId: "proj_project1", content: "project-1's release branch is cut on Fridays.", userQuote: "" },
      { type: "preference", scope: "user", content: "Prefers short replies.", userQuote: "   " },
      { type: "preference", scope: "project", projectId: "proj_project1", content: "project-1 commit messages are in English.", userQuote: "project-1 commit messages are written in English" }
    ] });
    expect(await result).toMatchObject({ processed: true, created: 3, rejected: 0 });
    const project1 = memory.listAvailable({ scope: "project", projectId: "proj_project1" });
    expect(project1).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "knowledge", source: "extraction", userQuote: null }),
      expect.objectContaining({ type: "preference", source: "user", userQuote: "project-1 commit messages are written in English" })
    ]));
    expect(memory.listAvailable({ scope: "user", projectId: null }))
      .toEqual([expect.objectContaining({ source: "extraction", userQuote: null })]);
  } finally {
    env.cleanup();
  }
});

test("the answer's shape asks for userQuote only on a preference, and to leave it out without the user's words", () => {
  const shape = EXTRACTION_SYSTEM_PROMPT.split("\n").find((line) => line.startsWith("Return JSON only:"))!;
  expect(shape).not.toContain("userQuote");
  // A rewrite of a listed memory names it.
  expect(shape).toBe("Return JSON only: {\"entries\":[{\"type\":\"preference|knowledge\",\"scope\":\"user|project\",\"projectId\":\"...\",\"content\":\"...\",\"memoryId\":\"...\"}],\"taskRecord\":\"...\"}");
  expect(EXTRACTION_SYSTEM_PROMPT).toContain("Only a preference carries \"userQuote\"");
  expect(EXTRACTION_SYSTEM_PROMPT).toContain("leave userQuote out");
});

test("what extraction keeps out and how it words an entry: the prompt's lines", () => {
  const lines = EXTRACTION_SYSTEM_PROMPT.split("\n");
  for (const line of [
    "- preference: how the user wants things done — a standing rule or a correction, with the user's words in userQuote.",
    "Give memoryId only when an entry rewrites a memory listed under \"Already known\" with its id: its content is then that memory whole, with what this conversation adds to the same lesson. A different lesson, even on the same subject, is an entry of its own, and what a rewrite adds follows the same rules as a new entry.",
    "- What is listed under \"Already known\". When this conversation adds to or changes a memory listed there with an id, rewrite that memory: keep everything it says unless this conversation changed it; where they disagree, what this conversation says holds.",
    "- Events and status: what happened in this conversation (a deploy, a cleanup, an incident and its fix), progress, counts, sizes, versions, ids, hashes, links and anything described as current. From an event keep only a lasting lesson, stated as the rule or the fact itself.",
    "- knowledge: a fact the project's files and their history do not show — a decision and its reason, an agreed contract, a constraint, a verdict.",
    "- What the project's files or their history already show; the assistant's own plans unless the user accepted them or a tool verified the result.",
    "- Test each entry: will it still be true a month from now, and will an agent working here then act better for reading it? If not, leave it out.",
    "One lesson per entry: the rule or fact with its reason, where it applies and the cases this conversation shows, in the language the user used. Give an absolute date when a date matters, never \"now\" or \"currently\"."
  ]) expect(lines).toContain(line);
  // Replaced: their words alone, one thing per entry, and recording a new version beside the known one.
  expect(EXTRACTION_SYSTEM_PROMPT).not.toContain("The entry says what those words say, nothing more.");
  expect(EXTRACTION_SYSTEM_PROMPT).not.toContain("One thing per entry, in a few sentences");
  expect(EXTRACTION_SYSTEM_PROMPT).not.toContain("then record the new version");
  // Replaced: it let rewrites glue a second lesson on.
  expect(EXTRACTION_SYSTEM_PROMPT).not.toContain("with what this conversation adds.\n");
  // The memoryId line follows the userQuote one.
  expect(lines.indexOf("Give memoryId only when an entry rewrites a memory listed under \"Already known\" with its id: its content is then that memory whole, with what this conversation adds to the same lesson. A different lesson, even on the same subject, is an entry of its own, and what a rewrite adds follows the same rules as a new entry."))
    .toBe(lines.findIndex((line) => line.startsWith("Only a preference carries \"userQuote\"")) + 1);
  // Not only code: a project is its files, whatever they hold.
  expect(EXTRACTION_SYSTEM_PROMPT).not.toContain("the code");
  // The rest of the list stands.
  expect(EXTRACTION_SYSTEM_PROMPT).toContain("- A one-off request is not a preference.");
  expect(EXTRACTION_SYSTEM_PROMPT).toContain("- Nothing is the usual answer.");
});

// Absolute dates need to know when each thing was said: "starting tomorrow"
// said on the 15th is not the same day as said on the 16th.
test("the extraction model reads the day each part of the conversation was said", async () => {
  const { env, memory } = setup();
  try {
    const at = (createdAt: string, id: string, text: string) => stub<AgentMessage>({ id, threadId: "thr_1", role: "user", source: "user", seq: 1, createdAt, content: { type: "text", text } });
    const { model, result } = run(memory, { entries: [] }, { messages: [
      at("2026-10-15T09:00:00.000Z", "m1", "Let us plan the release"),
      at("2026-10-15T10:00:00.000Z", "m2", "Fine"),
      at("2026-10-16T09:00:00.000Z", "m3", "Starting tomorrow every release gets a security review"),
      at("2026-10-17T18:00:00.000Z", "m4", "ok")
    ] });
    await result;
    const prompt = String((model.streamCalls[0]?.prompt as Array<{ role: string; content: Array<{ text?: string }> }>)
      .find((m) => m.role === "user")!.content.map((part) => part.text ?? "").join(""));
    const transcript = prompt.slice(prompt.indexOf("## The conversation leaving context"));
    expect(transcript).toContain("--- 2026-10-15 ---\n[user] Let us plan the release\n[user] Fine\n--- 2026-10-16 ---\n[user] Starting tomorrow every release gets a security review\n--- 2026-10-17 ---\n[user] ok");
  } finally {
    env.cleanup();
  }
});

// A window can leave context long after the user spoke; their statement is
// dated by their message, so a later correction still reads as later.
test("a quoted entry is dated by the latest message holding the user's words, not by the extraction", async () => {
  const { env, memory } = setup();
  try {
    const at = (createdAt: string, id: string) => stub<AgentMessage>({ id, threadId: "thr_1", role: "user", source: "user", seq: 1, createdAt, content: { type: "text", text: "From now on project-1 commit messages are written in English" } });
    const { result } = run(memory, { entries: [
      { type: "preference", scope: "project", projectId: "proj_project1", content: "project-1 commit messages are in English.", userQuote: "project-1 commit messages are written in English" }
    ] }, { messages: [at("2026-09-01T08:00:00.000Z", "m_a"), at("2026-09-02T08:00:00.000Z", "m_b")] });
    await result;
    const [kept] = memory.listAvailable({ scope: "project", projectId: "proj_project1" });
    expect(kept?.metadata?.statedAt).toBe("2026-09-02T08:00:00.000Z");
  } finally {
    env.cleanup();
  }
});

test("an extracted memory's source is the user's message it rests on, not the window's first row", async () => {
  const { env, memory } = setup();
  try {
    const context = stub<AgentMessage>({ id: "m_context", threadId: "thr_1", role: "user", source: "runtime-context", seq: 1, createdAt: "2026-09-01T07:00:00.000Z", content: { type: "text", text: "RUNTIME" } });
    const other = stub<AgentMessage>({ id: "m_other", threadId: "thr_1", role: "user", source: "user", seq: 2, createdAt: "2026-09-01T07:30:00.000Z", content: { type: "text", text: "look at the release script" } });
    const statement = stub<AgentMessage>({ id: "m_said", threadId: "thr_1", role: "user", source: "user", seq: 3, createdAt: "2026-09-01T08:00:00.000Z", content: { type: "text", text: "From now on project-1 commit messages are written in English" } });
    const { result } = run(memory, { entries: [
      { type: "preference", scope: "project", projectId: "proj_project1", content: "project-1 commit messages are in English.", userQuote: "project-1 commit messages are written in English" },
      { type: "knowledge", scope: "project", projectId: "proj_project4", content: "project-4 releases from a script." }
    ] }, { messages: [context, other, statement] });
    await result;
    expect(memory.listAvailable({ scope: "project", projectId: "proj_project1" })[0]?.sourceMessageId).toBe("m_said");
    expect(memory.listAvailable({ scope: "project", projectId: "proj_project4" })[0]?.sourceMessageId).toBe("m_other");
  } finally {
    env.cleanup();
  }
});

// What the user's agent sent for them carries its words, not theirs: a quote
// found only there is no quote. The message is still what the memory rests on.
test("a quote found only in a message the user's agent sent for them is no quote; that message is still the source", async () => {
  const { env, memory } = setup();
  try {
    const reply = stub<AgentMessage>({ id: "m_reply", threadId: "thr_1", role: "assistant", source: "self", seq: 1, createdAt: "2026-09-01T07:10:00.000Z", content: { type: "assistant", text: "Looking at the release script.", toolCalls: [] } });
    const relayed = stub<AgentMessage>({
      id: "m_relayed", threadId: "thr_1", role: "user", source: "user", seq: 2, createdAt: "2026-09-01T08:00:00.000Z",
      content: { type: "text", text: "The user decided: project-1 commit messages are written in English", relay: { by: "global", spoken: false, handoffId: "hof_1", name: "Juno" } }
    });
    const { result } = run(memory, { entries: [
      { type: "preference", scope: "project", projectId: "proj_project1", content: "project-1 commit messages are in English.", userQuote: "project-1 commit messages are written in English" }
    ] }, { messages: [reply, relayed] });
    expect(await result).toMatchObject({ processed: true, created: 1, rejected: 0 });
    const kept = memory.listAvailable({ scope: "project", projectId: "proj_project1" });
    expect(kept).toEqual([expect.objectContaining({ source: "extraction", userQuote: null, sourceMessageId: "m_relayed" })]);
    expect(kept[0]?.metadata?.statedAt).toBeUndefined();
  } finally {
    env.cleanup();
  }
});

test("a window without the user's words takes its first conversation row as the source, never a context row", async () => {
  const { env, memory } = setup();
  try {
    const context = stub<AgentMessage>({ id: "m_context", threadId: "thr_1", role: "user", source: "runtime-context", seq: 1, createdAt: "2026-09-01T07:00:00.000Z", content: { type: "text", text: "RUNTIME" } });
    const reply = stub<AgentMessage>({ id: "m_reply", threadId: "thr_1", role: "assistant", source: "self", seq: 2, createdAt: "2026-09-01T07:10:00.000Z", content: { type: "assistant", text: "project-4 releases from a script.", toolCalls: [] } });
    const { result } = run(memory, { entries: [{ type: "knowledge", scope: "project", projectId: "proj_project4", content: "project-4 releases from a script." }] }, { messages: [context, reply] });
    await result;
    expect(memory.listAvailable({ scope: "project", projectId: "proj_project4" })[0]?.sourceMessageId).toBe("m_reply");
  } finally {
    env.cleanup();
  }
});

test("a project entry needs a listed project; with one project listed it goes there", async () => {
  const { env, memory } = setup();
  try {
    const unknown = run(memory, { entries: [{ type: "knowledge", scope: "project", projectId: "proj_x", content: "x" }] });
    expect(await unknown.result).toMatchObject({ created: 0, rejected: 1 });
    const single = run(memory, { entries: [{ type: "knowledge", scope: "project", content: "project-1 uses project-2." }] },
      { projectList: [projects[0]!] });
    expect(await single.result).toMatchObject({ created: 1 });
    expect(memory.listAvailable({ scope: "project", projectId: "proj_project1" })).toHaveLength(1);
  } finally {
    env.cleanup();
  }
});

test("a worker's task record is created once and then rewritten, and the model sees the earlier one", async () => {
  const { env, memory, records, worker } = setup();
  try {
    await run(memory, { entries: [], taskRecord: "Asked: fix UDP framing. Done: patch 1." }, { worker }).result;
    const first = records.get(worker.featureId)!;
    expect(first).toMatchObject({ projectId: worker.projectId, sourceThreadId: "thr_1", content: "Asked: fix UDP framing. Done: patch 1." });
    expect(first.metadata).toMatchObject({ extractionTrigger: "compression", workerName: "UDP framing" });

    // An earlier window's id that no extraction makes (two in one millisecond share one).
    env.store.db.prepare("update feature_records set metadata_json = json_set(metadata_json, '$.extractionId', 'extract_earlier') where feature_id = ?").run(worker.featureId);
    const second = run(memory, { entries: [], taskRecord: "Asked: fix UDP framing. Done: patches 1 and 2. Open: e2e." }, { worker, trigger: "worker_archive" });
    expect(await second.result).toMatchObject({ taskRecord: "updated" });
    expect(JSON.stringify(second.model.streamCalls[0]?.prompt)).toContain("Done: patch 1.");
    const rewritten = records.get(worker.featureId)!;
    expect(rewritten).toMatchObject({ id: first.id, content: "Asked: fix UDP framing. Done: patches 1 and 2. Open: e2e." });
    // The earlier keys stay; the window's own id and trigger replace theirs.
    expect(rewritten.metadata).toMatchObject({ extractionTrigger: "worker_archive", workerName: "UDP framing" });
    expect(rewritten.metadata!.extractionId).toMatch(/^extract_/);
    expect(rewritten.metadata!.extractionId).not.toBe("extract_earlier");
  } finally {
    env.cleanup();
  }
});

test("extraction writes a worker's record into feature_records", async () => {
  const { env, memory, records, worker } = setup();
  try {
    const { result } = run(memory, { entries: [], taskRecord: "Asked: fix UDP framing. Done: patch 1." }, { worker });
    expect(await result).toMatchObject({ processed: true, taskRecord: "created" });
    expect(records.get(worker.featureId)?.content).toBe("Asked: fix UDP framing. Done: patch 1.");
    const count = (sql: string) => (env.store.db.prepare(sql).get() as { n: number }).n;
    expect(count("select count(*) as n from memory_entries where type = 'task'")).toBe(0);
    expect(count("select count(*) as n from memory_embeddings")).toBe(0);
  } finally {
    env.cleanup();
  }
});

// A worker's window extracted right after the move: its record is the one
// the move put in feature_records, rewritten, never started again.
test("extraction rewrites the record already in feature_records", async () => {
  const { env, memory, records, worker } = setup();
  try {
    const moved = records.write({ featureId: worker.featureId, projectId: worker.projectId, content: "Asked: fix UDP framing. Done: patch 1.", sourceThreadId: "thr_0", metadata: { extractionId: "extract_old", extractionTrigger: "compression", workerName: "UDP framing" } }).record;
    const { model, result } = run(memory, { entries: [], taskRecord: "Asked: fix UDP framing. Done: patches 1 and 2." }, { worker, trigger: "worker_archive" });
    expect(await result).toMatchObject({ taskRecord: "updated" });
    expect(JSON.stringify(model.streamCalls[0]?.prompt)).toContain('## Task record of worker \\"UDP framing\\"\\nAsked: fix UDP framing. Done: patch 1.');
    expect(records.get(worker.featureId)).toMatchObject({ id: moved.id, sourceThreadId: "thr_0", content: "Asked: fix UDP framing. Done: patches 1 and 2." });
  } finally {
    env.cleanup();
  }
});

// An archive can hand over a worker's window while a compression's
// extraction is still waiting on its model.
test("two windows of one worker extracted at once keep one task record, and the second sees the first", async () => {
  const { env, memory, records, worker } = setup();
  try {
    const first = run(memory, { entries: [], taskRecord: "Done: patch 1." }, { worker });
    const second = run(memory, { entries: [], taskRecord: "Done: patches 1 and 2." }, { worker, trigger: "worker_archive" });
    expect(await Promise.all([first.result, second.result])).toMatchObject([{ taskRecord: "created" }, { taskRecord: "updated" }]);
    expect(JSON.stringify(second.model.streamCalls[0]?.prompt)).toContain("Done: patch 1.");
    expect(records.get(worker.featureId)?.content).toBe("Done: patches 1 and 2.");
    expect((env.store.db.prepare("select count(*) as n from feature_records").get() as { n: number }).n).toBe(1);
  } finally {
    env.cleanup();
  }
});

// One entry that does not fit the shape (a scope written as a project's name,
// a null taskRecord) does not throw the whole answer away, every other entry
// in it included.
test("an entry that does not fit the shape is rejected, and the rest of the answer is kept", async () => {
  const { env, memory } = setup();
  try {
    const { result } = run(memory, { entries: [
      { type: "knowledge", scope: "project-1", content: "project-1's release branch is cut on Fridays." },
      { type: "knowledge", scope: "project", projectId: "proj_project1", content: "project-1 deploys from main." },
      { type: "fact", scope: "user", content: "Prefers short replies." },
      { type: "knowledge", scope: "project", projectId: "proj_project1", content: "" },
      "not an entry"
    ] });
    expect(await result).toMatchObject({ processed: true, created: 1, rejected: 4 });
    expect(memory.listAvailable({ scope: "project", projectId: "proj_project1" }).map((m) => m.content)).toEqual(["project-1 deploys from main."]);
  } finally {
    env.cleanup();
  }
});

test("a null taskRecord or null entries is none, and the window is kept", async () => {
  const { env, memory, records, worker } = setup();
  try {
    const { result } = run(memory, { entries: [{ type: "knowledge", scope: "project", projectId: "proj_project1", content: "project-1 deploys from main." }], taskRecord: null }, { worker });
    expect(await result).toMatchObject({ processed: true, created: 1, taskRecord: null });
    expect(records.get(worker.featureId)).toBeNull();
    const empty = run(memory, { entries: null, taskRecord: "Done: patch 1." }, { worker, trigger: "worker_archive" });
    expect(await empty.result).toMatchObject({ processed: true, created: 0, taskRecord: "created" });
  } finally {
    env.cleanup();
  }
});

test("a failed extraction does not hold up the same worker's next window", async () => {
  const { env, memory, worker } = setup();
  try {
    const failed = run(memory, { entries: "not a list" }, { worker });
    const next = run(memory, { entries: [], taskRecord: "Done: patch 1." }, { worker, trigger: "worker_archive" });
    await expect(failed.result).rejects.toThrow("did not match schema");
    expect(await next.result).toMatchObject({ taskRecord: "created" });
  } finally {
    env.cleanup();
  }
});

test("the same rule for two projects is two entries; a repeat for the same project is one", async () => {
  const { env, memory } = setup();
  try {
    const rule = "Commit messages are always in English.";
    const { result } = run(memory, { entries: [
      { type: "preference", scope: "project", projectId: "proj_project1", content: rule },
      { type: "preference", scope: "project", projectId: "proj_project4", content: rule },
      { type: "preference", scope: "project", projectId: "proj_project4", content: rule }
    ] });
    expect(await result).toMatchObject({ created: 2, rejected: 1 });
    expect(memory.listAvailable({ scope: "project", projectId: "proj_project4" })).toHaveLength(1);
  } finally {
    env.cleanup();
  }
});

test("the model is told what is already known and which projects exist; an empty answer writes nothing", async () => {
  const { env, memory } = setup();
  try {
    memory.putBrief({ scope: "user", projectId: null, content: "USER BRIEF TEXT", inputDigest: "d", builtAt: "2026-10-07T00:00:00.000Z", runId: null });
    memory.putBrief({ scope: "project", projectId: "proj_project1", content: "PROJECT-1 BRIEF TEXT", inputDigest: "d", builtAt: "2026-10-07T00:00:00.000Z", runId: null });
    const { model, result } = run(memory, { entries: [] });
    expect(await result).toMatchObject({ processed: true, created: 0 });
    const prompt = JSON.stringify(model.streamCalls[0]?.prompt);
    for (const expected of ["USER BRIEF TEXT", "PROJECT-1 BRIEF TEXT", "proj_project4", "project-4"]) expect(prompt).toContain(expected);
    expect(memory.listAvailable({ scope: "user", projectId: null })).toEqual([]);
  } finally {
    env.cleanup();
  }
});

test("a window with nothing to read calls no model", async () => {
  const { env, memory } = setup();
  try {
    const empty = run(memory, { entries: [] }, { messages: [] });
    expect(await empty.result).toMatchObject({ processed: false });
    expect(empty.model.streamCalls).toHaveLength(0);
  } finally {
    env.cleanup();
  }
});

// A model whose reasoning is off must not get it turned back on by
// extraction.
test("extraction keeps the model's reasoning-off setting", async () => {
  const { env, memory } = setup();
  try {
    const calls: Array<{ providerOptions?: { openai?: { forceReasoning?: unknown } }; reasoning?: unknown }> = [];
    const model = {
      specificationVersion: "v3" as const,
      provider: "mock-memory",
      modelId: "mock-memory",
      supportedUrls: {},
      async doGenerate(): Promise<never> { throw new Error("unused"); },
      async doStream(options: (typeof calls)[number]): Promise<never> { calls.push(options); return await new Promise<never>(() => {}); }
    };
    void extractFromWindow({
      memory, records: recordsOf.get(memory)!, candidates: [{ model, provider: "openai-compatible", reasoningEffort: "high", supportsReasoning: false }], repeatCheck: [],
      trigger: "compression", threadId: "thr_1", messages: [said("keep releases tagged from main")],
      projects, worker: null, budgetTokens: 50_000
    });
    for (let i = 0; i < 50 && calls.length === 0; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toHaveLength(1);
    expect([calls[0]!.providerOptions?.openai?.forceReasoning, calls[0]!.reasoning ?? null]).toEqual([undefined, null]);
  } finally {
    env.cleanup();
  }
});

test("a reply cut off at the output token limit fails, and the next model on the route reads the window", async () => {
  const { env, memory } = setup();
  try {
    // Readable as it is, but cut short: whatever it would have listed next is lost.
    const cut = createMockLLM([{ text: JSON.stringify({ entries: [
      { type: "knowledge", scope: "project", projectId: "proj_project1", content: "project-1 releases are tagged from main." }
    ] }), finishReason: "length" }]);
    const second = createMockLLM([{ text: JSON.stringify({ entries: [
      { type: "knowledge", scope: "project", projectId: "proj_project1", content: "project-1 releases are tagged from main." }
    ] }) }]);
    const outcomes: Array<{ name: string; status: string; error?: string }> = [];
    const recorder = (name: string) => stub<AgentLlmCallRecorder>({
      startCall: () => `${name}_call`,
      finishCall: (_id, outcome) => { outcomes.push({ name, status: outcome.status, ...(outcome.error ? { error: (outcome.error as Error).message } : {}) }); }
    });
    const result = await extractFromWindow({
      memory,
      records: recordsOf.get(memory)!,
      repeatCheck: [],
      candidates: [
        { model: cut, provider: "openai", supportsReasoning: undefined, recorder: recorder("first") },
        { model: second, provider: "openai", supportsReasoning: undefined, recorder: recorder("second") }
      ],
      trigger: "compression", threadId: "thr_1", messages: [said("keep project-1 releases tagged from main")],
      projects, worker: null, budgetTokens: 50_000
    });
    expect(result).toMatchObject({ processed: true, created: 1 });
    // Not tried again on the same model: it would stop at the same place.
    expect([cut.streamCalls.length, second.streamCalls.length]).toEqual([1, 1]);
    expect(outcomes).toStrictEqual([
      { name: "first", status: "failed", error: OUTPUT_LIMIT_FAILURE },
      { name: "second", status: "succeeded" }
    ]);
  } finally {
    env.cleanup();
  }
});

test("when the first model fails, the next one on the route reads the window; each attempt is recorded", async () => {
  const { env, memory } = setup();
  try {
    const first = createMockLLM([{ error: new Error("The operation timed out.") }]);
    const second = createMockLLM([{ text: JSON.stringify({ entries: [
      { type: "knowledge", scope: "project", projectId: "proj_project1", content: "project-1 releases are tagged from main." }
    ] }) }]);
    const calls: Array<{ recorder: string; status?: string; fallbackAttempt: unknown }> = [];
    const recorder = (name: string) => stub<AgentLlmCallRecorder>({
      startCall: (input) => {
        calls.push({ recorder: name, fallbackAttempt: input.metadata?.fallbackAttempt ?? false });
        return `${name}_call`;
      },
      finishCall: (id, outcome) => {
        const call = calls.find((c) => `${c.recorder}_call` === id && c.status === undefined);
        if (call) call.status = outcome.status;
      }
    });
    const result = await extractFromWindow({
      memory,
      records: recordsOf.get(memory)!,
      repeatCheck: [],
      candidates: [
        { model: first, provider: "openai", supportsReasoning: undefined, recorder: recorder("first") },
        { model: second, provider: "openai-compatible", supportsReasoning: undefined, recorder: recorder("second") }
      ],
      trigger: "compression", threadId: "thr_1", messages: [said("keep project-1 releases tagged from main")],
      projects, worker: null, budgetTokens: 50_000
    });
    expect(result).toMatchObject({ processed: true, created: 1 });
    // A timeout is not tried again on the same model.
    expect([first.streamCalls.length, second.streamCalls.length]).toEqual([1, 1]);
    expect(calls).toStrictEqual([
      { recorder: "first", status: "failed", fallbackAttempt: false },
      { recorder: "second", status: "succeeded", fallbackAttempt: true }
    ]);
  } finally {
    env.cleanup();
  }
});
