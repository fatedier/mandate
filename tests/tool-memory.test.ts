import { expect, test } from "bun:test";
import { ToolDispatcher, ToolRegistry } from "../src/server/modules/agent/tool-registry.js";
import { buildMemoryTools } from "../src/server/modules/memory/tools/memory.js";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { MemoryManager } from "../src/server/modules/memory/manager.js";
import { FeatureRecordStore } from "../src/server/modules/plans/record-store.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { toolContext } from "./helpers/typed.js";
import { VOICE_TOOL_WAKE_ID } from "../src/server/modules/global/handoff-service.js";

function setup(scope: "worker" | "manager", quoteWaitMs?: number) {
  const env = freshStoresEnv("md-memory-tools-");
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
  const project1 = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
  const project4 = seedProject(env.projects, { name: "project-4", tmuxSessionName: "md-project-4" });
  const featureId = seedFeature(env.features, project1, { name: "csv-export", tmuxWindowName: "csv-export" });
  const thread = env.agentStore.createManagerThread("t");
  // Records written a minute apart, so "newest first" is defined.
  let tick = 0;
  const records = new FeatureRecordStore(env.store.db, () => new Date(Date.now() - 3_600_000 + 60_000 * tick++).toISOString());
  const registry = new ToolRegistry();
  for (const tool of buildMemoryTools({ memory, records, scope, agentStore: env.agentStore, projectsStore: env.projects, ...(quoteWaitMs === undefined ? {} : { quoteWaitMs }) })) {
    registry.register(tool);
  }
  const dispatcher = new ToolDispatcher(registry);
  const ctx = toolContext({
    threadId: thread.id,
    ...(scope === "worker"
      ? { project: env.projects.getById(project1)!, feature: env.features.getById(featureId)! }
      : {})
  });
  const call = (toolName: string, args: unknown) => dispatcher.dispatch({ toolCallId: "c", toolName, args }, ctx);
  const spoken = (toolName: string, args: unknown) => dispatcher.dispatch({ toolCallId: "c", toolName, args }, { ...ctx, wakeId: VOICE_TOOL_WAKE_ID });
  const say = (text: string) => env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text } });
  const writeRecord = (feature: string, content: string, projectId = project1) =>
    records.write({ featureId: feature, projectId, content, sourceThreadId: null, metadata: null }).record;
  return { env, memory, records, writeRecord, project1, project4, featureId, call, spoken, say, registry, thread };
}

test("the five tools are the whole set, and no memory tool counts or scores", () => {
  const t = setup("manager");
  try {
    expect(t.registry.definitions.map((tool) => tool.name).sort())
      .toEqual(["memory_forget", "memory_read", "memory_remember", "memory_search", "memory_update"]);
  } finally {
    t.env.cleanup();
  }
});

test("what to remember is said of the project's files, not only code", () => {
  const t = setup("manager");
  try {
    const remember = t.registry.definitions.find((tool) => tool.name === "memory_remember")!;
    expect(remember.description).toContain("Do not remember what the project's files or their history already show, temporary state, or one-off details of the current task.");
    const typeField = (remember.parameters as unknown as { shape: { type: { description?: string } } }).shape.type;
    expect(typeField.description).toContain("knowledge: a fact the project's files and their history do not show.");
  } finally {
    t.env.cleanup();
  }
});

test("remember marks the user's words only when they are in this thread", async () => {
  const t = setup("manager");
  try {
    t.say("From now on project-1 commit messages are written in English");
    const ok = await t.call("memory_remember", {
      type: "preference", scope: "project", project: "project-1",
      content: "project-1 commit messages are written in English.", userQuote: "project-1 commit messages are written in English"
    });
    expect(ok.isError).toBeFalsy();
    expect((ok.result as { memory: Record<string, unknown> }).memory)
      .toMatchObject({ type: "preference", scope: "project", project: "project-1", source: "user", userQuote: "project-1 commit messages are written in English" });

    const invented = await t.call("memory_remember", {
      type: "preference", scope: "user", content: "x", userQuote: "the user never said this"
    });
    expect(invented.isError).toBe(true);
    expect(invented.error).toContain("not in the user's messages");

    const agentOwn = await t.call("memory_remember", { type: "knowledge", scope: "user", content: "an agent's lesson" });
    expect((agentOwn.result as { memory: { source: string } }).memory.source).toBe("agent");
  } finally {
    t.env.cleanup();
  }
});

// What the user's agent sent for them carries its words, not theirs.
test("words the user's agent sent for them are not the user's words; the user's own are", async () => {
  const t = setup("manager");
  try {
    const args = { type: "preference", scope: "user", content: "Tags come from stable.", userQuote: "project-1 tags come from stable" };
    t.env.agentStore.appendMessage({
      threadId: t.thread.id, role: "user", source: "user",
      content: { type: "text", text: "From now on project-1 tags come from stable", relay: { by: "global", spoken: false, handoffId: "hof_1", name: "Juno" } }
    });
    const relayed = await t.call("memory_remember", args);
    expect(relayed.isError).toBe(true);
    expect(relayed.error).toContain("not in the user's messages");

    t.say("From now on project-1 tags come from stable");
    const own = await t.call("memory_remember", args);
    expect(own.isError).toBeFalsy();
    expect((own.result as { memory: Record<string, unknown> }).memory).toMatchObject({ source: "user", userQuote: "project-1 tags come from stable" });
  } finally {
    t.env.cleanup();
  }
});

// The realtime API can send a tool call before the transcript of the speech
// it answers: a spoken call waits for the user's words to reach the thread.
test("a spoken remember waits for the user's words; a typed one does not", async () => {
  const t = setup("manager", 2_000);
  try {
    const words = "From now on tag every release from main";
    const pending = t.spoken("memory_remember", { type: "preference", scope: "user", content: "Releases are tagged from main.", userQuote: words });
    setTimeout(() => t.env.agentStore.appendMessage({ threadId: t.thread.id, role: "user", source: "voice", content: { type: "text", text: words } }), 50);
    const spokenResult = await pending;
    expect(spokenResult.isError).toBeFalsy();
    expect((spokenResult.result as { memory: Record<string, unknown> }).memory).toMatchObject({ source: "user", userQuote: words });

    const started = Date.now();
    const typed = await t.call("memory_remember", { type: "preference", scope: "user", content: "x", userQuote: "words the user never typed" });
    expect(typed.error).toContain("not in the user's messages");
    expect(Date.now() - started).toBeLessThan(500);
  } finally {
    t.env.cleanup();
  }
});

// A → B → A: the renewed A must read as later than B. A spoken call answers
// what the user is saying now, even when an earlier message holds the words,
// and its own transcript may come after the call.
test("a spoken call is dated by when it was made, not by an earlier message holding the same words", async () => {
  const t = setup("manager", 2_000);
  try {
    const words = "From now on answer in bullet points";
    const earlier = t.say(words);
    t.env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run("2026-09-01T00:00:00.000Z", earlier.id);
    const correction = t.say("Never mind, answer in full sentences");
    // A minute ago: an earlier statement, not a tie within one millisecond.
    const correctedAt = new Date(Date.now() - 60_000).toISOString();
    t.env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(correctedAt, correction.id);
    const startedAt = new Date().toISOString();
    const result = await t.spoken("memory_remember", { type: "preference", scope: "user", content: "Replies are bullet points.", userQuote: words });
    expect(result.isError).toBeFalsy();
    const id = (result.result as { memory: { id: string } }).memory.id;
    const stored = (await t.memory.get(id))?.metadata?.statedAt;
    expect(typeof stored).toBe("string");
    const statedAt = stored as string;
    expect(Number.isFinite(Date.parse(statedAt))).toBe(true);
    expect(statedAt >= startedAt).toBe(true);
    expect(statedAt > correctedAt).toBe(true);
  } finally {
    t.env.cleanup();
  }
});

test("a spoken quote that never arrives is refused once the wait runs out", async () => {
  const t = setup("manager", 60);
  try {
    const r = await t.spoken("memory_remember", { type: "preference", scope: "user", content: "x", userQuote: "words nobody said aloud" });
    expect(r.error).toContain("not in the user's messages");
  } finally {
    t.env.cleanup();
  }
});

test("a manager names the project; an unknown one is refused with the list", async () => {
  const t = setup("manager");
  try {
    const missing = await t.call("memory_remember", { type: "knowledge", scope: "project", content: "x" });
    expect(missing.error).toContain("Name the project");
    const unknown = await t.call("memory_remember", { type: "knowledge", scope: "project", project: "project-2", content: "x" });
    expect(unknown.error).toContain("No active project named project-2. Projects:");
    expect(unknown.error).toContain("project-1");
    expect(unknown.error).toContain("project-4");
  } finally {
    t.env.cleanup();
  }
});

// Project names are unique only as written, so "project-1" and "PROJECT-1" can both exist.
test("a project named exactly wins; a name matching several projects only by case is refused", async () => {
  const t = setup("manager");
  try {
    const upper = seedProject(t.env.projects, { name: "PROJECT-1", tmuxSessionName: "md-project-1-upper" });
    const placed = async (project: string) => {
      const r = await t.call("memory_remember", { type: "knowledge", scope: "project", project, content: `x ${project}` });
      return r.isError ? r.error : (await t.memory.get((r.result as { memory: { id: string } }).memory.id))?.projectId;
    };
    expect(await placed("PROJECT-1")).toBe(upper);
    expect(await placed("project-1")).toBe(t.project1);
    expect(await placed("PROJECT-4")).toBe(t.project4);
    expect(await placed("Project-1")).toMatch(/^Project-1 matches more than one project: (project-1, PROJECT-1|PROJECT-1, project-1)\. Name it exactly\.$/);
  } finally {
    t.env.cleanup();
  }
});

test("a worker writes project memories to its own project only", async () => {
  const t = setup("worker");
  try {
    const own = await t.call("memory_remember", { type: "knowledge", scope: "project", content: "project-1 builds with make" });
    expect((own.result as { memory: { project: string } }).memory.project).toBe("project-1");
    const other = await t.call("memory_remember", { type: "knowledge", scope: "project", project: "project-4", content: "x" });
    expect(other.error).toContain("its own project (project-1)");
  } finally {
    t.env.cleanup();
  }
});

test("update refuses a merged-away memory and names where it went", async () => {
  const t = setup("manager");
  try {
    const target = await t.memory.remember({ scope: "user", type: "preference", source: "agent", content: "run the linter" });
    const merged = await t.memory.remember({ scope: "user", type: "preference", source: "agent", content: "run the linter with --fix" });
    await t.memory.archive(merged.id, { mergedInto: target.id });
    const result = await t.call("memory_update", { id: merged.id, content: "run the linter" });
    expect(result.error).toContain(`was merged into ${target.id}; update that one`);
  } finally {
    t.env.cleanup();
  }
});

// A memory the user stated is changed as any other: with their words the
// change is theirs; without, the memory becomes the agent's, so their old
// words never stand beside text they did not say.
test("a memory the user stated is changed like any other; without their words it becomes the agent's", async () => {
  const t = setup("manager");
  try {
    const stated = await t.memory.remember({ scope: "user", type: "preference", source: "user", userQuote: "always back up first", content: "Back up first.", metadata: { statedAt: "2026-10-01T00:00:00.000Z", note: "kept" } });
    const without = await t.call("memory_update", { id: stated.id, content: "No backup needed." });
    expect(without.isError).toBeFalsy();
    const changed = (await t.memory.get(stated.id))!;
    expect(changed).toMatchObject({ content: "No backup needed.", source: "agent", userQuote: null });
    // Their stated time leaves with their words; the version replaced is kept as such.
    expect(changed.metadata).toEqual({ note: "kept", previous: expect.objectContaining({ content: "Back up first.", userQuote: "always back up first" }) });
    t.say("No need to back up any more, just deploy");
    const withWords = await t.call("memory_update", { id: stated.id, content: "No backup needed.", userQuote: "No need to back up any more" });
    expect(withWords.isError).toBeFalsy();
    expect(await t.memory.get(stated.id)).toMatchObject({ content: "No backup needed.", source: "user", userQuote: "No need to back up any more" });
  } finally {
    t.env.cleanup();
  }
});

// A task record is a worker's history beside its plan, not a memory: a search
// of memory does not find it; memory_read opens it by the id lists show.
test("memory_read opens a task record by its mem_ id", async () => {
  const t = setup("manager");
  try {
    const record = t.writeRecord(t.featureId, "Export rows to CSV: done, shipped in the export module.\nDetails of every step taken.\nMore detail.");
    const read = (await t.call("memory_read", { target: "memory", id: record.id })).result;
    expect(read).toEqual({ memory: { id: record.id, type: "task", scope: "project", project: "project-1", worker: "csv-export", updated: "today", content: record.content } });
    expect((await t.call("memory_read", { target: "memory", id: "mem_missing" })).error).toContain("memory not found: mem_missing");
  } finally {
    t.env.cleanup();
  }
});

// Which memories are used, for the statistics that may later decide what to
// archive: each one a search hands an agent (with where it ranked) and each
// one opened by id. A brief or a task record read is no memory's use.
const usesOf = (t: ReturnType<typeof setup>) => t.env.store.db.prepare("select memory_id, kind, thread_id, agent, rank from memory_uses order by rowid").all();

test("memory_search and memory_read note each memory they hand an agent, where it ranked, and the thread", async () => {
  const t = setup("manager");
  try {
    const rule = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "Export rows to CSV through the export module." });
    await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "CSV exports are UTF-8 with a header row." });
    const found = ((await t.call("memory_search", { query: "CSV export", project: "project-1" })).result as { memories: Array<{ id: string }> }).memories.map((m) => m.id);
    expect(found).toHaveLength(2);
    await t.call("memory_read", { target: "memory", id: rule.id });
    const record = t.writeRecord(t.featureId, "Export rows to CSV: done.");
    await t.call("memory_read", { target: "memory", id: record.id });
    await t.call("memory_read", { target: "project", project: "project-1" });
    await t.call("memory_read", { target: "user" });
    expect(usesOf(t)).toEqual([
      ...found.map((id, i) => ({ memory_id: id, kind: "search", thread_id: t.thread.id, agent: "manager", rank: i + 1 })),
      { memory_id: rule.id, kind: "read", thread_id: t.thread.id, agent: "manager", rank: null }
    ]);
  } finally {
    t.env.cleanup();
  }
});

test("a worker's use says worker; a use that cannot be noted leaves the tool's answer as it was", async () => {
  const t = setup("worker");
  try {
    const rule = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "Export rows to CSV through the export module." });
    await t.call("memory_read", { target: "memory", id: rule.id });
    expect(usesOf(t)).toEqual([{ memory_id: rule.id, kind: "read", thread_id: t.thread.id, agent: "worker", rank: null }]);
    t.env.store.db.exec("drop table memory_uses");
    const searched = await t.call("memory_search", { query: "CSV export", project: "project-1" });
    expect(searched.isError).toBeFalsy();
    expect((searched.result as { memories: Array<{ id: string }> }).memories.map((m) => m.id)).toEqual([rule.id]);
    expect((await t.call("memory_read", { target: "memory", id: rule.id })).isError).toBeFalsy();
  } finally {
    t.env.cleanup();
  }
});

test("while another process writes the database, a search answers at once and drops its note; other writes still wait as before", async () => {
  const t = setup("manager");
  const { Database } = await import("bun:sqlite");
  const other = new Database(`${t.env.dir}/mandate.db`);
  try {
    const rule = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "Export rows to CSV through the export module." });
    other.exec("begin immediate");
    const started = performance.now();
    const searched = await t.call("memory_search", { query: "CSV export", project: "project-1" });
    expect(performance.now() - started).toBeLessThan(1000);
    expect((searched.result as { memories: Array<{ id: string }> }).memories.map((m) => m.id)).toEqual([rule.id]);
    other.exec("rollback");
    expect(usesOf(t)).toEqual([]);
    // The connection's own wait for ordinary writes is as it was.
    expect(t.env.store.db.prepare("pragma busy_timeout").get()).toEqual({ timeout: 5000 });
  } finally {
    other.close();
    t.env.cleanup();
  }
});

test("memory_search no longer returns task records and refuses type task", async () => {
  const t = setup("manager");
  try {
    t.writeRecord(t.featureId, "Export rows to CSV: done, shipped in the export module.");
    const rule = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "Export rows to CSV through the export module." });
    const found = ((await t.call("memory_search", { query: "export rows", project: "project-1" })).result as { memories: Array<{ id: string }> }).memories;
    expect(found.map((m) => m.id)).toEqual([rule.id]);
    expect((await t.call("memory_search", { query: "export rows", type: "task" })).isError).toBe(true);
    const search = t.registry.definitions.find((tool) => tool.name === "memory_search")!;
    expect(search.description).toBe(
      "Search Mandate's memory: the user's preferences and working rules, and project knowledge. Workers' task records are found with chat_history_search. Use it before working in a project, and when the user refers to something from an earlier conversation."
    );
  } finally {
    t.env.cleanup();
  }
});

test("memory_read project lists recentTasks from feature_records", async () => {
  const t = setup("manager");
  try {
    const ids: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const feature = seedFeature(t.env.features, t.project1, { name: `worker-${i}`, tmuxWindowName: `worker-${i}` });
      if (i === 6) t.env.features.archive(feature);
      ids.push(t.writeRecord(feature, `Record ${i}\ndetail ${i}`).id);
    }
    t.writeRecord(seedFeature(t.env.features, t.project4, { name: "elsewhere", tmuxWindowName: "elsewhere" }), "Other project's record", t.project4);
    const read = (await t.call("memory_read", { target: "project", project: "project-1" })).result as { recentTasks: Array<{ id: string; written: string; firstLine: string }> };
    expect(read.recentTasks.map((task) => task.id)).toEqual(ids.slice(1).reverse());
    expect(read.recentTasks[0]).toEqual({ id: ids[5], written: "today", firstLine: "Record 6" });
  } finally {
    t.env.cleanup();
  }
});

// The dream orders the user's statements by when they were said; a
// correction through memory_update is said now.
test("an update with the user's words records when they said them", async () => {
  const t = setup("manager");
  try {
    const own = await t.memory.remember({ scope: "user", type: "preference", source: "agent", content: "Replies are full sentences.", sourceThreadId: "thr_old", sourceMessageId: "m_old" });
    const message = t.say("From now on answer in bullet points");
    // Said an hour before the agent got to it: the statement is dated by the message.
    const saidAt = new Date(Date.now() - 3_600_000).toISOString();
    t.env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(saidAt, message.id);
    const r = await t.call("memory_update", { id: own.id, content: "Replies are bullet points.", userQuote: "From now on answer in bullet points" });
    expect(r.isError).toBeFalsy();
    const stored = (await t.memory.get(own.id))!;
    expect(stored.source).toBe("user");
    expect(stored.metadata?.statedAt).toBe(saidAt);
    // Their words come from this conversation now, as memory_remember records it.
    expect([stored.sourceThreadId, stored.sourceMessageId]).toEqual([t.thread.id, null]);

    const said = t.say("project-1 tags come from stable");
    t.env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(saidAt, said.id);
    const remembered = await t.call("memory_remember", { type: "preference", scope: "user", content: "Tags come from stable.", userQuote: "project-1 tags come from stable" });
    const id = (remembered.result as { memory: { id: string } } | undefined)?.memory.id ?? "";
    expect((await t.memory.get(id))?.metadata?.statedAt).toBe(saidAt);
  } finally {
    t.env.cleanup();
  }
});

/** The dream writes `race` right after the tool reads `id`: between the
 *  tool's checks and its write. */
function raceAfterRead(memory: MemoryManager, id: string, race: () => Promise<unknown>) {
  const get = memory.get.bind(memory);
  let pending = true;
  memory.get = async (wanted: string) => {
    const entry = await get(wanted);
    if (pending && wanted === id) {
      pending = false;
      await race();
    }
    return entry;
  };
}

test("an update that lands after the dream merged the memory away is refused and names where it went", async () => {
  const t = setup("manager");
  try {
    const target = await t.memory.remember({ scope: "user", type: "preference", source: "agent", content: "run the linter" });
    const merged = await t.memory.remember({ scope: "user", type: "preference", source: "agent", content: "run the linter with --fix" });
    raceAfterRead(t.memory, merged.id, () => t.memory.writeIfUnchanged([merged], (tx) => tx.archive(merged.id, { mergedInto: target.id })));
    const result = await t.call("memory_update", { id: merged.id, content: "run the linter without --fix" });
    expect(result.error).toContain(`was merged into ${target.id}; update that one`);
    expect((await t.memory.get(merged.id))?.content).toBe("run the linter with --fix");
  } finally {
    t.env.cleanup();
  }
});

test("a forget that lands after the dream split the memory is refused and names the parts", async () => {
  const t = setup("manager");
  try {
    const whole = await t.memory.remember({ scope: "user", type: "preference", source: "agent", content: "Short replies; tag from main." });
    let parts: string[] = [];
    raceAfterRead(t.memory, whole.id, () => t.memory.writeIfUnchanged([whole], (tx) => {
      parts = ["Short replies.", "Tag from main."].map((content) => tx.remember({ scope: "user", type: "preference", source: "agent", content, metadata: { splitFrom: whole.id } }).id);
      return tx.archive(whole.id, { splitInto: parts });
    }));
    const result = await t.call("memory_forget", { id: whole.id, reason: "wrong" });
    expect(result.error).toContain(`was split into ${parts.join(", ")}; forget those`);
    expect((await t.memory.get(whole.id))?.metadata?.forgottenReason).toBeUndefined();
  } finally {
    t.env.cleanup();
  }
});

test("an update that lands after someone else changed the memory is refused: it never overwrites a correction it did not see", async () => {
  const t = setup("manager");
  try {
    const own = await t.memory.remember({ scope: "user", type: "preference", source: "agent", content: "Replies are full sentences." });
    // Another conversation records the user's correction between this tool's read and its write.
    raceAfterRead(t.memory, own.id, () => t.memory.update({ id: own.id, content: "Replies are bullet points.", source: "user", userQuote: "From now on answer in bullet points", metadata: { statedAt: new Date().toISOString() } }));
    const result = await t.call("memory_update", { id: own.id, content: "Replies are full sentences, always." });
    expect(result.error).toContain(`memory ${own.id} changed since you read it`);
    expect(await t.memory.get(own.id)).toMatchObject({ content: "Replies are bullet points.", source: "user" });
  } finally {
    t.env.cleanup();
  }
});

test("memory_update and memory_forget refuse a task record id", async () => {
  const t = setup("manager");
  try {
    const task = t.writeRecord(t.featureId, "did X");
    expect((await t.call("memory_update", { id: task.id, content: "y" })).error).toContain("Task records are history and cannot be changed.");
    expect((await t.call("memory_forget", { id: task.id, reason: "r" })).error).toContain("Task records are history and cannot be forgotten.");
    expect(t.records.getById(task.id)?.content).toBe("did X");
  } finally {
    t.env.cleanup();
  }
});

test("forget archives with the reason; read and search show what is there", async () => {
  const t = setup("manager");
  try {
    const entry = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "project-1 uses project-2 v0.2" });
    const found = await t.call("memory_search", { query: "project-2", project: "project-1" });
    expect((found.result as { memories: Array<{ id: string; written: string }> }).memories)
      .toEqual([expect.objectContaining({ id: entry.id, written: "today" })]);
    const forgot = await t.call("memory_forget", { id: entry.id, reason: "the user said it is wrong" });
    expect(forgot.isError).toBeFalsy();
    expect(await t.memory.get(entry.id)).toMatchObject({ status: "archived", metadata: { forgottenReason: "the user said it is wrong" } });
    expect(((await t.call("memory_search", { query: "project-2" })).result as { memories: unknown[] }).memories).toEqual([]);

    t.memory.putBrief({ scope: "project", projectId: t.project1, content: "project-1 brief", inputDigest: "d", builtAt: new Date().toISOString(), runId: null });
    const brief = await t.call("memory_read", { target: "project", project: "project-1" });
    expect(brief.result).toMatchObject({ project: "project-1", brief: "project-1 brief", built: "today" });
    const one = await t.call("memory_read", { target: "memory", id: entry.id });
    expect((one.result as { memory: { status: string } }).memory.status).toBe("archived");
  } finally {
    t.env.cleanup();
  }
});

test("a worker changes or forgets project memories of its own project only", async () => {
  const t = setup("worker");
  try {
    const other = await t.memory.remember({ scope: "project", projectId: t.project4, type: "knowledge", source: "agent", content: "project-4 fact" });
    const own = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "project-1 fact" });
    const user = await t.memory.remember({ scope: "user", type: "preference", source: "agent", content: "short replies" });
    expect((await t.call("memory_update", { id: other.id, content: "changed" })).error).toContain("its own project (project-1)");
    expect((await t.call("memory_forget", { id: other.id, reason: "r" })).error).toContain("its own project (project-1)");
    expect((await t.memory.get(other.id))).toMatchObject({ content: "project-4 fact", status: "available" });
    expect((await t.call("memory_update", { id: own.id, content: "project-1 fact, corrected" })).isError).toBeFalsy();
    expect((await t.call("memory_update", { id: user.id, content: "shorter replies" })).isError).toBeFalsy();
  } finally {
    t.env.cleanup();
  }
});

test("memory_read reads what its target names, and only that target's field", async () => {
  const t = setup("manager");
  try {
    const tool = t.registry.definitions.find((d) => d.name === "memory_read")!;
    expect(tool.description).toBe(
      "Read one memory or task record by id, a project's whole brief with its recent task records, or the user brief. Set target to say which; only that target's field is read."
    );
    const idField = (tool.parameters as unknown as { shape: { id: { description?: string } } }).shape.id;
    expect(idField.description).toBe("For target \"memory\": the memory's or task record's id.");
    const entry = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "project-1 deploys on Tuesdays" });
    t.memory.putBrief({ scope: "project", projectId: t.project1, content: "project-1 brief", inputDigest: "d", builtAt: new Date().toISOString(), runId: null });
    t.memory.putBrief({ scope: "user", projectId: null, content: "user brief", inputDigest: "d", builtAt: new Date().toISOString(), runId: null });
    // As a model fills every field: placeholders beside the one it means.
    const project = await t.call("memory_read", { target: "project", id: "none", project: "project-1" });
    expect(project.result).toMatchObject({ project: "project-1", brief: "project-1 brief" });
    const user = await t.call("memory_read", { target: "user", id: "__unused__", project: "__unused__" });
    expect(user.result).toMatchObject({ brief: "user brief" });
    expect((await t.call("memory_read", { target: "user", id: "", project: "" })).result).toMatchObject({ brief: "user brief" });
    expect((await t.call("memory_read", { target: "user", project: null })).result).toMatchObject({ brief: "user brief" });
    expect((await t.call("memory_read", { target: "project", project: "project-1", id: null })).result).toMatchObject({ project: "project-1" });
    const memory = await t.call("memory_read", { target: "memory", id: entry.id, project: "" });
    expect((memory.result as { memory: { id: string } }).memory.id).toBe(entry.id);
    // A key the tool does not take is refused, as by the other memory tools.
    const old = await t.call("memory_read", { target: "project", project: "project-1", scope: "user" });
    expect(old.isError).toBe(true);
    // The target's own field missing or blank is said so.
    expect((await t.call("memory_read", { target: "memory", project: "project-1" })).error).toContain('target "memory" needs id');
    expect((await t.call("memory_read", { target: "project", project: "  " })).error).toContain('target "project" needs project');
    expect((await t.call("memory_read", { project: "project-1" })).isError).toBe(true);
  } finally {
    t.env.cleanup();
  }
});
