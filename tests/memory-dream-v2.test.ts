import { expect, test } from "bun:test";
import { createMockLLM } from "./helpers/mock-llm.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { FeatureRecordStore } from "../src/server/modules/plans/record-store.js";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import type { MemoryEntry } from "../src/server/modules/memory/types.js";
import { MemoryManager } from "../src/server/modules/memory/manager.js";
import { closeInterruptedDreamRuns, dreamRoomTokens, MemoryDreamer } from "../src/server/modules/memory/dream.js";
import { buildDreamSystemPrompt, buildOpeningMessage } from "../src/server/modules/memory/dream-prompt.js";
import { MemoryDreamJob } from "../src/server/modules/memory/dream-job.js";
import { listMemoryDreamRuns } from "../src/server/modules/memory/dream-runs.js";
import { entriesDigest } from "../src/server/modules/memory/briefs.js";

type Call = { toolName: string; args: Record<string, unknown> };
const step = (...calls: Call[]) => ({
  toolCalls: calls.map((call, i) => ({ toolCallId: `c${i}`, toolName: call.toolName, args: call.args })),
  finishReason: "tool-calls" as const
});

function setup() {
  const env = freshStoresEnv("md-dream-v2-");
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
  const project1 = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
  const dreamer = (script: Parameters<typeof createMockLLM>[0], opts: { contextLimitTokens?: number } = {}) => {
    const model = createMockLLM(script);
    return { model, dreamer: new MemoryDreamer({ db: env.store.db, records: new FeatureRecordStore(env.store.db), memory, agentStore: env.agentStore, projectsStore: env.projects, model, provider: "openai", maxSteps: script.length, contextLimitTokens: opts.contextLimitTokens ?? 200_000 }) };
  };
  const toolResults = (model: ReturnType<typeof createMockLLM>, stepIndex: number) =>
    (model.streamCalls[stepIndex]?.prompt as Array<{ content?: unknown }>)
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((part: { type?: string }) => part.type === "tool-result") as Array<{ toolName: string; output: { value: Record<string, unknown> } }>;
  return { env, memory, project1, dreamer, toolResults };
}

test("a first run sees every entry, curates, and stores the brief with the digest of what it left", async () => {
  const t = setup();
  try {
    const keep = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "Export API is rows-only." });
    const dup = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "extraction", content: "The export API returns rows only." });
    const { model, dreamer } = t.dreamer([
      step({ toolName: "apply_action", args: { type: "merge", memoryId: dup.id, targetMemoryId: keep.id, reason: "same fact" } }),
      step({ toolName: "write_brief", args: { content: "project-1: what agents need.\n- Export API is rows-only.", summary: "merged one" } })
    ]);
    expect(dreamer.needsRun({ kind: "project", projectId: t.project1 })).toBe(true);

    const result = await dreamer.run("manual", { kind: "project", projectId: t.project1 });

    expect(result).toMatchObject({ processed: true, status: "succeeded", appliedCount: 1, candidateCount: 2 });
    const opening = JSON.stringify(model.streamCalls[0]?.prompt);
    expect(opening).toContain(keep.id);
    expect(opening).toContain(dup.id);
    expect(await t.memory.get(dup.id)).toMatchObject({ status: "archived", metadata: expect.objectContaining({ mergedInto: keep.id }) });
    expect(t.memory.getBrief("project", t.project1)?.content).toBe("project-1: what agents need.\n- Export API is rows-only.");
    expect(dreamer.needsRun({ kind: "project", projectId: t.project1 })).toBe(false);
    // What the run did, in the model's words, for the activity log.
    const row = t.env.store.db.prepare("select metadata_json from memory_dream_runs where id = ?").get(result.runId) as { metadata_json: string };
    expect(JSON.parse(row.metadata_json).finishReason).toBe("finished: merged one");
  } finally {
    t.env.cleanup();
  }
});

test("the opening says when the user said their memories, and a later run starts from what changed", async () => {
  const t = setup();
  try {
    const said = await t.memory.remember({ scope: "user", type: "preference", source: "user", userQuote: "always back up", content: "Back up before deploying." });
    // A brief is built from when its run started, and a memory written in that
    // same millisecond counts as changed; in use the two are minutes apart.
    await Bun.sleep(2);
    const first = t.dreamer([
      step({ toolName: "write_brief", args: { content: "The user: careful deployer.\n- Back up before deploying." } })
    ]);
    expect(await first.dreamer.run("manual", { kind: "user" })).toMatchObject({ status: "succeeded" });

    const later = await t.memory.remember({ scope: "user", type: "preference", source: "agent", content: "Replies stay short." });
    const second = t.dreamer([
      step({ toolName: "write_brief", args: { content: "The user: careful deployer.\n- Back up before deploying.\n- Short replies." } })
    ]);
    await second.dreamer.run("idle", { kind: "user" });
    const opening = JSON.stringify(second.model.streamCalls[0]?.prompt);
    // Every memory is there to review; only what changed is marked.
    expect(opening).toContain(`★ [${later.id}]`);
    expect(opening).toContain(`[${said.id}]`);
    expect(opening).not.toContain(`★ [${said.id}]`);
    // The prompt asks the model to let the later statement hold.
    expect(JSON.stringify(first.model.streamCalls[0]?.prompt)).toContain(`[${said.id}] preference, user, stated ${said.createdAt}, updated`);
  } finally {
    t.env.cleanup();
  }
});

test("a run that applies actions and writes no brief fails, keeps the old brief, and runs again next time", async () => {
  const t = setup();
  try {
    const a = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "one-off event" });
    await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "project-1 uses project-2." });
    t.memory.putBrief({ scope: "project", projectId: t.project1, content: "OLD BRIEF", inputDigest: "stale", builtAt: "2026-01-01T00:00:00.000Z", runId: null });
    const { dreamer } = t.dreamer([
      step({ toolName: "apply_action", args: { type: "archive", memoryId: a.id, reason: "one-off" } }),
      { text: "Done.", finishReason: "stop" }
    ]);
    const result = await dreamer.run("idle", { kind: "project", projectId: t.project1 });
    expect(result).toMatchObject({ status: "failed", appliedCount: 1 });
    expect((await t.memory.get(a.id))?.status).toBe("archived");
    expect(t.memory.getBrief("project", t.project1)?.content).toBe("OLD BRIEF");
    // The old brief does not stand for what is there now, so the next tick runs again.
    expect(dreamer.needsRun({ kind: "project", projectId: t.project1 })).toBe(true);
  } finally {
    t.env.cleanup();
  }
});

test("an over-long brief is refused until it fits", async () => {
  const t = setup();
  try {
    await t.memory.remember({ scope: "user", type: "preference", source: "agent", content: "x" });
    const { model, dreamer } = t.dreamer([
      step({ toolName: "write_brief", args: { content: "word ".repeat(4000) } }),
      step({ toolName: "write_brief", args: { content: "Short brief." } })
    ]);
    await dreamer.run("manual", { kind: "user" });
    // A tool that throws reaches the model as its error text.
    expect(String(t.toolResults(model, 1)[0]?.output.value)).toMatch(/the limit is 3000: shorten it/);
    expect(t.memory.getBrief("user", null)?.content).toBe("Short brief.");
  } finally {
    t.env.cleanup();
  }
});

test("read_entry shows similar memories by embedding and the entry's sources", async () => {
  const env = freshStoresEnv("md-dream-v2-read-");
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db, {
    embedder: { model: "test", async embed(text) { return /\p{Script=Han}/u.test(text) ? [0.8, 0.6] : [1, 0]; } }
  }));
  const thread = env.agentStore.createManagerThread("t");
  const asked = env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "keep a root pane alive while it runs" } });
  const english = await memory.remember({ scope: "user", type: "preference", source: "agent", content: "Keep a second terminal open.", sourceThreadId: thread.id, sourceMessageId: asked.id });
  const chinese = await memory.remember({ scope: "user", type: "preference", source: "agent", content: "另外保留一个独立的终端窗口。" });
  const model = createMockLLM([
    step({ toolName: "read_entry", args: { memoryId: english.id } }),
    step({ toolName: "write_brief", args: { content: "Brief." } })
  ]);
  await new MemoryDreamer({ contextLimitTokens: 200_000, db: env.store.db, records: new FeatureRecordStore(env.store.db), memory, agentStore: env.agentStore, projectsStore: env.projects, model, provider: "openai", maxSteps: 3 })
    .run("manual", { kind: "user" });
  const read = (model.streamCalls[1]?.prompt as Array<{ content?: unknown }>)
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((part: { type?: string; toolName?: string }) => part.type === "tool-result" && part.toolName === "read_entry") as { output: { value: { similar: Array<{ id: string }>; sources: unknown[] } } };
  expect(read.output.value.similar.map((s) => s.id)).toEqual([chinese.id]);
  expect(JSON.stringify(read.output.value.sources)).toContain("keep a root pane alive while it runs");
});

// The version a change replaced is kept for the Memory page only: a
// correction made without the user's words must not bring their old words
// back into the dream's reading.
test("read_entry leaves out the version a change of the text replaced", async () => {
  const env = freshStoresEnv("md-dream-v2-read-previous-");
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
  const stated = await memory.remember({ scope: "user", type: "preference", source: "user", userQuote: "always back up first", content: "Back up before deploying.", metadata: { statedAt: "2026-10-01T00:00:00.000Z", note: "kept" } });
  await memory.update({ id: stated.id, content: "Deploy without a backup.", source: "agent", userQuote: null, metadata: { note: "kept" } });
  const model = createMockLLM([
    step({ toolName: "read_entry", args: { memoryId: stated.id } }),
    step({ toolName: "write_brief", args: { content: "Brief." } })
  ]);
  await new MemoryDreamer({ contextLimitTokens: 200_000, db: env.store.db, records: new FeatureRecordStore(env.store.db), memory, agentStore: env.agentStore, projectsStore: env.projects, model, provider: "openai", maxSteps: 3 })
    .run("manual", { kind: "user" });
  const read = (model.streamCalls[1]?.prompt as Array<{ content?: unknown }>)
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((part: { type?: string; toolName?: string }) => part.type === "tool-result" && part.toolName === "read_entry") as { output: { value: { memory: { content: string; metadata: Record<string, unknown> | null } } } };
  expect(read.output.value.memory.content).toBe("Deploy without a backup.");
  expect(read.output.value.memory.metadata).toEqual({ note: "kept" });
  expect(JSON.stringify(read.output.value)).not.toContain("always back up first");
  expect(JSON.stringify(read.output.value)).not.toContain("Back up before deploying.");
});

// The brief must cover what its digest says it covers: entries written while
// the run was going, and the run's own actions after the brief, were not in it.
test("a memory written during the run is not marked as covered, and the next run sees it as changed", async () => {
  const t = setup();
  try {
    await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "project-1 uses project-2." });
    const { model, dreamer } = t.dreamer([
      step({ toolName: "list_entries", args: {} }),
      step({ toolName: "write_brief", args: { content: "project-1: project-2." } })
    ]);
    let calls = 0;
    let meanwhile: { id: string } | null = null;
    const stream = model.doStream.bind(model);
    model.doStream = async (options) => {
      calls += 1;
      if (calls === 2) meanwhile = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "extraction", content: "project-1 releases from main." });
      return stream(options);
    };
    expect(await dreamer.run("idle", { kind: "project", projectId: t.project1 })).toMatchObject({ status: "succeeded" });
    expect(t.memory.getBrief("project", t.project1)?.content).toBe("project-1: project-2.");
    expect(dreamer.needsRun({ kind: "project", projectId: t.project1 })).toBe(true);
    const next = t.dreamer([step({ toolName: "write_brief", args: { content: "project-1: project-2; releases from main." } })]);
    await next.dreamer.run("idle", { kind: "project", projectId: t.project1 });
    expect(JSON.stringify(next.model.streamCalls[0]?.prompt)).toContain(meanwhile!.id);
    expect(next.dreamer.needsRun({ kind: "project", projectId: t.project1 })).toBe(false);
  } finally {
    t.env.cleanup();
  }
});

// A conversation can correct a memory while the dream runs; merging another
// memory into it does not show the model the correction, so the brief does
// not cover it.
test("a memory changed outside the run stays uncovered even when the run then acts on it", async () => {
  const t = setup();
  try {
    const a = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "project-1 tags releases on stable." });
    const b = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "project-1 releases are tagged on stable." });
    const { model, dreamer } = t.dreamer([
      step({ toolName: "list_entries", args: {} }),
      step({ toolName: "apply_action", args: { type: "merge", memoryId: a.id, targetMemoryId: b.id, reason: "same fact" } }),
      step({ toolName: "write_brief", args: { content: "project-1: tags on stable." } })
    ]);
    let calls = 0;
    const stream = model.doStream.bind(model);
    model.doStream = async (options) => {
      calls += 1;
      if (calls === 2) await t.memory.update({ id: b.id, content: "project-1 releases are tagged on next, then merged to stable." });
      return stream(options);
    };
    expect(await dreamer.run("idle", { kind: "project", projectId: t.project1 })).toMatchObject({ status: "succeeded", appliedCount: 0, rejectedCount: 1 });
    expect(dreamer.needsRun({ kind: "project", projectId: t.project1 })).toBe(true);
  } finally {
    t.env.cleanup();
  }
});

test("a memory that arrived during the run stays uncovered when the run merges into it", async () => {
  const t = setup();
  try {
    const a = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "project-1 tags releases on stable." });
    const { model, dreamer } = t.dreamer([
      step({ toolName: "list_entries", args: {} }),
      step({ toolName: "apply_action", args: { type: "merge", memoryId: a.id, targetMemoryId: "mem_arrived", reason: "same fact" } }),
      step({ toolName: "write_brief", args: { content: "project-1: tags on stable." } })
    ]);
    let calls = 0;
    const stream = model.doStream.bind(model);
    model.doStream = async (options) => {
      calls += 1;
      if (calls === 2) {
        // Another writer adds a memory the model has not read.
        const at = new Date().toISOString();
        t.env.store.db.prepare(`insert into memory_entries (id, scope, project_id, feature_id, type, source, user_quote, content, status, source_thread_id, source_message_id, created_at, updated_at, metadata_json)
          values ('mem_arrived', 'project', ?, null, 'knowledge', 'extraction', null, 'project-1 deploys on Tuesdays, then posts the notes on the forum.', 'available', null, null, ?, ?, null)`).run(t.project1, at, at);
      }
      return stream(options);
    };
    expect(await dreamer.run("idle", { kind: "project", projectId: t.project1 })).toMatchObject({ status: "succeeded", appliedCount: 0, rejectedCount: 1 });
    expect(dreamer.needsRun({ kind: "project", projectId: t.project1 })).toBe(true);
  } finally {
    t.env.cleanup();
  }
});

// targetMemoryId belongs to a merge. Another action that names one (the model
// fills it with something) acts on its own memory alone: the named memory is
// not looked at, so it cannot hold the action back, and no target is recorded.
test("an update or split that names a target acts on its own memory, holds no target, and is not held back by it", async () => {
  const t = setup();
  try {
    const a = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "project-1 tags releases on stable." });
    const b = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "project-1 deploys on Tuesdays; notes go to the forum." });
    const { model, dreamer } = t.dreamer([
      step({ toolName: "list_entries", args: {} }),
      // mem_arrived exists but this run never read it (it came in during the run).
      step({ toolName: "apply_action", args: { type: "update", memoryId: a.id, targetMemoryId: "mem_arrived", content: "project-1 tags releases on stable, from main.", reason: "clearer" } }),
      step({ toolName: "apply_action", args: { type: "split", memoryId: b.id, targetMemoryId: "9ab", parts: ["project-1 deploys on Tuesdays.", "project-1 posts release notes on the forum."], reason: "two facts" } }),
      step({ toolName: "write_brief", args: { content: "project-1: tags on stable from main; deploys Tuesdays." } })
    ]);
    let calls = 0;
    const stream = model.doStream.bind(model);
    model.doStream = async (options) => {
      calls += 1;
      if (calls === 2) {
        const at = new Date().toISOString();
        t.env.store.db.prepare(`insert into memory_entries (id, scope, project_id, feature_id, type, source, user_quote, content, status, source_thread_id, source_message_id, created_at, updated_at, metadata_json)
          values ('mem_arrived', 'project', ?, null, 'knowledge', 'extraction', null, 'project-1 uses a release train.', 'available', null, null, ?, ?, null)`).run(t.project1, at, at);
      }
      return stream(options);
    };
    expect(await dreamer.run("idle", { kind: "project", projectId: t.project1 })).toMatchObject({ status: "succeeded", appliedCount: 2, rejectedCount: 0 });
    expect((await t.memory.get(a.id))?.content).toBe("project-1 tags releases on stable, from main.");
    expect(await t.memory.get(b.id)).toMatchObject({ status: "archived" });
    const rows = t.env.store.db.prepare("select action_type, target_memory_id from memory_dream_actions where memory_id in (?, ?) order by created_at").all(a.id, b.id);
    expect(rows).toEqual([{ action_type: "update", target_memory_id: null }, { action_type: "split", target_memory_id: null }]);
  } finally {
    t.env.cleanup();
  }
});

// A correction someone made while the dream ran stands: the run works on what
// it started from, and the next run takes the correction in.
test("an action on a memory changed during the run is refused for the rest of the run, and the correction stands", async () => {
  const t = setup();
  try {
    const b = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "The linter runs with --fix." });
    const { model, dreamer } = t.dreamer([
      step({ toolName: "list_entries", args: {} }),
      step({ toolName: "apply_action", args: { type: "update", memoryId: b.id, content: "The linter runs with --fix, always.", reason: "clearer" } }),
      step({ toolName: "read_entry", args: { memoryId: b.id } }),
      step({ toolName: "apply_action", args: { type: "update", memoryId: b.id, content: "The linter runs without --fix, always.", reason: "after reading" } }),
      step({ toolName: "write_brief", args: { content: "project-1: linter without --fix." } })
    ]);
    let calls = 0;
    const stream = model.doStream.bind(model);
    model.doStream = async (options) => {
      calls += 1;
      if (calls === 2) await t.memory.update({ id: b.id, content: "The linter runs without --fix." });
      return stream(options);
    };
    expect(await dreamer.run("idle", { kind: "project", projectId: t.project1 })).toMatchObject({ status: "succeeded", appliedCount: 0, rejectedCount: 2 });
    expect(t.toolResults(model, 2).find((r) => r.toolName === "apply_action")?.output.value)
      .toMatchObject({ status: "rejected", error: expect.stringContaining("changed during this run") });
    expect((await t.memory.get(b.id))?.content).toBe("The linter runs without --fix.");
    // The brief was written from what the run started with: it does not cover the correction.
    expect(dreamer.needsRun({ kind: "project", projectId: t.project1 })).toBe(true);
  } finally {
    t.env.cleanup();
  }
});

// What the model read never changes what the run knows; only its own writes do.
test("a read beside an action does not undo the action: the next action on that memory applies", async () => {
  const t = setup();
  try {
    const b = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "The linter runs with --fix." });
    const { dreamer } = t.dreamer([
      step(
        { toolName: "read_entry", args: { memoryId: b.id } },
        { toolName: "apply_action", args: { type: "update", memoryId: b.id, content: "The linter runs without --fix.", reason: "corrected" } }
      ),
      step({ toolName: "apply_action", args: { type: "update", memoryId: b.id, content: "The linter runs without --fix, ever.", reason: "clearer" } }),
      step({ toolName: "write_brief", args: { content: "project-1: linter without --fix." } })
    ]);
    expect(await dreamer.run("idle", { kind: "project", projectId: t.project1 })).toMatchObject({ status: "succeeded", appliedCount: 2, rejectedCount: 0 });
    expect((await t.memory.get(b.id))?.content).toBe("The linter runs without --fix, ever.");
    expect(dreamer.needsRun({ kind: "project", projectId: t.project1 })).toBe(false);
  } finally {
    t.env.cleanup();
  }
});

/** A store where a correction lands right after the dream reads one memory:
 *  between the dream's check and its write. */
class RacingProvider extends LocalMemoryProvider {
  raceOn: { id: string; write: () => Promise<unknown> } | null = null;
  override async get(id: string): Promise<MemoryEntry | null> {
    const entry = await super.get(id);
    const race = this.raceOn?.id === id ? this.raceOn : null;
    if (race) {
      this.raceOn = null;
      await race.write();
    }
    return entry;
  }
}

test("a correction landing between the dream's read of a memory and its write stands, and nothing of the action is written", async () => {
  const env = freshStoresEnv("md-dream-v2-race-");
  const provider = new RacingProvider(env.store.db);
  const memory = new MemoryManager(provider);
  const a = await memory.remember({ scope: "user", type: "preference", source: "agent", content: "short replies" });
  const b = await memory.remember({ scope: "user", type: "preference", source: "agent", content: "Replies stay short." });
  const model = createMockLLM([
    step({ toolName: "apply_action", args: { type: "merge", memoryId: a.id, targetMemoryId: b.id, content: "Merged words.", reason: "same" } }),
    step({ toolName: "write_brief", args: { content: "Brief." } })
  ]);
  provider.raceOn = { id: b.id, write: () => memory.update({ id: b.id, content: "Replies stay short, except for plans." }) };
  const dreamer = new MemoryDreamer({ contextLimitTokens: 200_000, db: env.store.db, records: new FeatureRecordStore(env.store.db), memory, agentStore: env.agentStore, projectsStore: env.projects, model, provider: "openai", maxSteps: 2 });
  expect(await dreamer.run("manual", { kind: "user" })).toMatchObject({ appliedCount: 0, rejectedCount: 1 });
  expect((await memory.get(b.id))?.content).toBe("Replies stay short, except for plans.");
  expect((await memory.get(a.id))?.status).toBe("available");
});

test("an action on a memory that does not exist is refused and recorded, not thrown", async () => {
  const t = setup();
  try {
    await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "project-1 uses project-2." });
    const { model, dreamer } = t.dreamer([
      step({ toolName: "apply_action", args: { type: "archive", memoryId: "mem_nope", reason: "typo" } }),
      step({ toolName: "write_brief", args: { content: "project-1: project-2." } })
    ]);
    expect(await dreamer.run("idle", { kind: "project", projectId: t.project1 })).toMatchObject({ status: "succeeded", rejectedCount: 1, failedCount: 0 });
    expect(t.toolResults(model, 1).find((r) => r.toolName === "apply_action")?.output.value)
      .toMatchObject({ status: "rejected", error: "memory is not an available entry of this partition" });
  } finally {
    t.env.cleanup();
  }
});

test("the parts of a memory the user stated keep their words and when they said them", async () => {
  const t = setup();
  try {
    const said = await t.memory.remember({ scope: "user", type: "preference", source: "user", userQuote: "short replies, and tags from main", content: "Short replies; tag releases from main." });
    const { dreamer } = t.dreamer([
      step({ toolName: "apply_action", args: { type: "split", memoryId: said.id, parts: ["Short replies.", "Tag releases from main."], reason: "two rules" } }),
      step({ toolName: "write_brief", args: { content: "The user: short replies; tags from main." } })
    ]);
    await dreamer.run("manual", { kind: "user" });
    const parts = t.memory.listAvailable({ scope: "user", projectId: null });
    expect(parts.map((part) => [part.content, part.source, part.userQuote, part.metadata?.statedAt])).toEqual(expect.arrayContaining([
      ["Short replies.", "user", "short replies, and tags from main", said.createdAt],
      ["Tag releases from main.", "user", "short replies, and tags from main", said.createdAt]
    ]));
  } finally {
    t.env.cleanup();
  }
});

test("a model error after the last memory left still removes the brief", async () => {
  const t = setup();
  try {
    const only = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "one-off event" });
    t.memory.putBrief({ scope: "project", projectId: t.project1, content: "OLD BRIEF", inputDigest: "stale", builtAt: "2026-01-01T00:00:00.000Z", runId: null });
    const model = createMockLLM([
      step({ toolName: "apply_action", args: { type: "archive", memoryId: only.id, reason: "one-off" } }),
      { error: new Error("model down") },
      { error: new Error("model down") }
    ]);
    const dreamer = new MemoryDreamer({ contextLimitTokens: 200_000, db: t.env.store.db, records: new FeatureRecordStore(t.env.store.db), memory: t.memory, agentStore: t.env.agentStore, projectsStore: t.env.projects, model, provider: "openai", maxSteps: 3 });
    expect(await dreamer.run("idle", { kind: "project", projectId: t.project1 })).toMatchObject({ status: "failed", appliedCount: 1 });
    expect(t.memory.getBrief("project", t.project1)).toBeNull();
  } finally {
    t.env.cleanup();
  }
});

// The dream's own update waits for an embedding; a correction made during that
// wait is newer than what the dream wrote, so the brief does not cover it.
test("a correction made while the dream's own change waits for its embedding stays uncovered", async () => {
  const env = freshStoresEnv("md-dream-v2-embed-wait-");
  let memory!: MemoryManager;
  let targetId = "";
  let corrected = false;
  memory = new MemoryManager(new LocalMemoryProvider(env.store.db, {
    embedder: { model: "test", async embed(text) {
      if (text === "Merged words." && !corrected) {
        corrected = true;
        // An embedding request takes a while; the correction lands during it.
        await Bun.sleep(3);
        await memory.update({ id: targetId, content: "Corrected while the dream waited." });
      }
      return [1, 0];
    } }
  }));
  const a = await memory.remember({ scope: "user", type: "preference", source: "agent", content: "short replies" });
  const b = await memory.remember({ scope: "user", type: "preference", source: "agent", content: "Replies stay short." });
  targetId = b.id;
  const model = createMockLLM([
    step({ toolName: "apply_action", args: { type: "merge", memoryId: a.id, targetMemoryId: b.id, content: "Merged words.", reason: "same" } }),
    step({ toolName: "write_brief", args: { content: "Brief." } })
  ]);
  const dreamer = new MemoryDreamer({ contextLimitTokens: 200_000, db: env.store.db, records: new FeatureRecordStore(env.store.db), memory, agentStore: env.agentStore, projectsStore: env.projects, model, provider: "openai", maxSteps: 3 });
  expect(await dreamer.run("manual", { kind: "user" })).toMatchObject({ status: "succeeded" });
  expect(corrected).toBe(true);
  expect(dreamer.needsRun({ kind: "user" })).toBe(true);
});

test("a split writes every part before it waits for any embedding", async () => {
  const env = freshStoresEnv("md-dream-v2-split-");
  const partsWhenEmbedding: number[] = [];
  let originalId = "";
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db, {
    embedder: { model: "test", async embed(text) {
      if (text.startsWith("Part ")) {
        // Counted once the request is in flight, as a network call would be.
        await Bun.sleep(0);
        partsWhenEmbedding.push((env.store.db.prepare("select count(*) as n from memory_entries where json_extract(metadata_json, '$.splitFrom') = ?").get(originalId) as { n: number }).n);
      }
      return [1, 0];
    } }
  }));
  const original = await memory.remember({ scope: "user", type: "preference", source: "agent", content: "Short replies; tag releases from main." });
  originalId = original.id;
  const model = createMockLLM([
    step({ toolName: "apply_action", args: { type: "split", memoryId: original.id, parts: ["Part one: short replies.", "Part two: tag releases from main."], reason: "two rules" } }),
    step({ toolName: "write_brief", args: { content: "Brief." } })
  ]);
  await new MemoryDreamer({ contextLimitTokens: 200_000, db: env.store.db, records: new FeatureRecordStore(env.store.db), memory, agentStore: env.agentStore, projectsStore: env.projects, model, provider: "openai", maxSteps: 3 })
    .run("manual", { kind: "user" });
  expect(partsWhenEmbedding).toStrictEqual([2, 2]);
  expect(await memory.get(original.id)).toMatchObject({ status: "archived", metadata: expect.objectContaining({ splitInto: expect.any(Array) }) });
});

test("writing the brief ends the run: a second brief and any later action are refused", async () => {
  const t = setup();
  try {
    const a = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "project-1 uses project-2." });
    const { model, dreamer } = t.dreamer([
      step(
        { toolName: "write_brief", args: { content: "project-1: project-2." } },
        { toolName: "write_brief", args: { content: "project-1: rewritten." } },
        { toolName: "apply_action", args: { type: "archive", memoryId: a.id, reason: "late" } }
      ),
      step({ toolName: "write_brief", args: { content: "project-1: a step too many." } })
    ]);
    expect(await dreamer.run("manual", { kind: "project", projectId: t.project1 })).toMatchObject({ status: "succeeded", appliedCount: 0 });
    expect(model.streamCalls.length).toBe(1);
    expect(t.memory.getBrief("project", t.project1)?.content).toBe("project-1: project-2.");
    expect((await t.memory.get(a.id))?.status).toBe("available");
    expect(dreamer.needsRun({ kind: "project", projectId: t.project1 })).toBe(false);
  } finally {
    t.env.cleanup();
  }
});

test("a run that empties its partition without writing a brief removes the brief and fails", async () => {
  const t = setup();
  try {
    const only = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "one-off event" });
    t.memory.putBrief({ scope: "project", projectId: t.project1, content: "OLD BRIEF", inputDigest: "stale", builtAt: "2026-01-01T00:00:00.000Z", runId: null });
    const { dreamer } = t.dreamer([
      step({ toolName: "apply_action", args: { type: "archive", memoryId: only.id, reason: "one-off" } }),
      { text: "Done.", finishReason: "stop" }
    ]);
    expect(await dreamer.run("idle", { kind: "project", projectId: t.project1 })).toMatchObject({ status: "failed", appliedCount: 1 });
    expect(t.memory.getBrief("project", t.project1)).toBeNull();
  } finally {
    t.env.cleanup();
  }
});

test("a partition emptied between runs loses its brief without reporting a run that does not exist", async () => {
  const t = setup();
  try {
    t.memory.putBrief({ scope: "project", projectId: t.project1, content: "OLD BRIEF", inputDigest: "stale", builtAt: "2026-01-01T00:00:00.000Z", runId: null });
    const { dreamer } = t.dreamer([step({ toolName: "write_brief", args: { content: "never asked for" } })]);
    const job = new MemoryDreamJob({ db: t.env.store.db, dreamer, activeProjectIds: () => [t.project1] });
    expect(await job.tick("manual", { force: true })).toEqual({ skipped: true, reason: "nothing_due" });
    expect(t.memory.getBrief("project", t.project1)).toBeNull();
  } finally {
    t.env.cleanup();
  }
});

// A run can store a brief built from nothing it still holds (it archived all
// it started with while someone added one); once that one goes too, the
// partition is empty and the digests match, but the brief must still go.
test("an empty partition that still has a brief needs a run, whatever the brief's digest", async () => {
  const t = setup();
  try {
    t.memory.putBrief({ scope: "project", projectId: t.project1, content: "LEFT OVER", inputDigest: entriesDigest([]), builtAt: "2026-01-01T00:00:00.000Z", runId: null });
    const { dreamer } = t.dreamer([step({ toolName: "write_brief", args: { content: "never asked for" } })]);
    expect(dreamer.needsRun({ kind: "project", projectId: t.project1 })).toBe(true);
    const job = new MemoryDreamJob({ db: t.env.store.db, dreamer, activeProjectIds: () => [t.project1] });
    await job.tick("manual", { force: true });
    expect(t.memory.getBrief("project", t.project1)).toBeNull();
    expect(dreamer.needsRun({ kind: "project", projectId: t.project1 })).toBe(false);
  } finally {
    t.env.cleanup();
  }
});

test("an action whose write fails is counted and recorded as failed, and changes nothing", async () => {
  const env = freshStoresEnv("md-dream-v2-write-fails-");
  class FailingProvider extends LocalMemoryProvider {
    override async writeIfUnchanged<T>(): Promise<T | null> { throw new Error("disk I/O error"); }
  }
  const memory = new MemoryManager(new FailingProvider(env.store.db));
  const a = await memory.remember({ scope: "user", type: "preference", source: "agent", content: "one-off event" });
  const model = createMockLLM([
    step({ toolName: "apply_action", args: { type: "archive", memoryId: a.id, reason: "one-off" } }),
    step({ toolName: "write_brief", args: { content: "Brief." } })
  ]);
  const dreamer = new MemoryDreamer({ contextLimitTokens: 200_000, db: env.store.db, records: new FeatureRecordStore(env.store.db), memory, agentStore: env.agentStore, projectsStore: env.projects, model, provider: "openai", maxSteps: 2 });
  expect(await dreamer.run("manual", { kind: "user" })).toMatchObject({ actionCount: 1, appliedCount: 0, rejectedCount: 0, failedCount: 1 });
  const recorded = env.store.db.prepare("select status, error_json from memory_dream_actions where memory_id = ?").get(a.id) as { status: string; error_json: string };
  expect(recorded.status).toBe("failed");
  expect(JSON.parse(recorded.error_json).message).toContain("disk I/O error");
  expect((await memory.get(a.id))?.status).toBe("available");
});

test("a run whose brief cannot be stored is recorded failed, not left running", async () => {
  const env = freshStoresEnv("md-dream-v2-brief-fails-");
  class FailingProvider extends LocalMemoryProvider {
    override putBrief(): void { throw new Error("disk I/O error"); }
  }
  const memory = new MemoryManager(new FailingProvider(env.store.db));
  await memory.remember({ scope: "user", type: "preference", source: "agent", content: "Short replies." });
  const model = createMockLLM([step({ toolName: "write_brief", args: { content: "Brief." } })]);
  const dreamer = new MemoryDreamer({ contextLimitTokens: 200_000, db: env.store.db, records: new FeatureRecordStore(env.store.db), memory, agentStore: env.agentStore, projectsStore: env.projects, model, provider: "openai", maxSteps: 1 });
  const result = await dreamer.run("manual", { kind: "user" });
  expect(result.status).toBe("failed");
  const row = env.store.db.prepare("select status, finished_at, error_json from memory_dream_runs where id = ?").get(result.runId) as { status: string; finished_at: string | null; error_json: string };
  expect(row.status).toBe("failed");
  expect(row.finished_at).not.toBeNull();
  expect(JSON.parse(row.error_json).message).toContain("disk I/O error");
  const metadata = env.store.db.prepare("select metadata_json from memory_dream_runs where id = ?").get(result.runId) as { metadata_json: string };
  expect(JSON.parse(metadata.metadata_json).finishReason).toBe("store_error");
});

test("a run's end the database refuses is written when tried again; refused every time, the run still returns", async () => {
  for (const refusals of [2, Number.POSITIVE_INFINITY]) {
    const env = freshStoresEnv("md-dream-v2-finish-refused-");
    const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
    await memory.remember({ scope: "user", type: "preference", source: "agent", content: "Short replies." });
    // The run's end is refused `refusals` times, as by another writer holding the database.
    let left = refusals;
    const prepare = env.store.db.prepare.bind(env.store.db);
    env.store.db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (!/update memory_dream_runs set\s+status/.test(sql)) return statement;
      return { run: (...params: Parameters<typeof statement.run>) => {
        if (left > 0) { left -= 1; throw new Error("database is locked"); }
        return statement.run(...params);
      } };
    }) as typeof prepare;
    const model = createMockLLM([step({ toolName: "write_brief", args: { content: "Brief." } })]);
    const dreamer = new MemoryDreamer({ contextLimitTokens: 200_000, db: env.store.db, records: new FeatureRecordStore(env.store.db), memory, agentStore: env.agentStore, projectsStore: env.projects, model, provider: "openai", maxSteps: 1, finishRetryDelaysMs: [1, 1, 1, 1] });
    const result = await dreamer.run("manual", { kind: "user" });
    expect(result.status).toBe("succeeded");
    expect(memory.getBrief("user", null)?.content).toBe("Brief.");
    env.store.db.prepare = prepare;
    const row = env.store.db.prepare("select status from memory_dream_runs where id = ?").get(result.runId) as { status: string };
    // Refused every time, it stays as it was until the next start closes it.
    expect([refusals, row.status]).toEqual([refusals, refusals === 2 ? "succeeded" : "running"]);
  }
});

test("a project archived while its run goes gets no brief back, even with a memory written after", async () => {
  const t = setup();
  try {
    await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "project-1 uses project-2." });
    const { model, dreamer } = t.dreamer([
      step({ toolName: "list_entries", args: {} }),
      step({ toolName: "write_brief", args: { content: "project-1: project-2." } })
    ]);
    let calls = 0;
    const stream = model.doStream.bind(model);
    model.doStream = async (options) => {
      calls += 1;
      if (calls === 2) {
        t.env.projects.archive(t.project1);
        // An extraction already under way still writes into the project.
        await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "extraction", content: "project-1 releases from main." });
      }
      return stream(options);
    };
    await dreamer.run("idle", { kind: "project", projectId: t.project1 });
    expect(t.memory.getBrief("project", t.project1)).toBeNull();
  } finally {
    t.env.cleanup();
  }
});

test("a failed run is recorded failed even when its cleanup fails too", async () => {
  const env = freshStoresEnv("md-dream-v2-cleanup-fails-");
  class FailingProvider extends LocalMemoryProvider {
    override deleteBrief(): void { throw new Error("disk I/O error"); }
  }
  const memory = new MemoryManager(new FailingProvider(env.store.db));
  const only = await memory.remember({ scope: "user", type: "preference", source: "agent", content: "one-off event" });
  const model = createMockLLM([
    step({ toolName: "apply_action", args: { type: "archive", memoryId: only.id, reason: "one-off" } }),
    { error: new Error("model down") },
    { error: new Error("model down") }
  ]);
  const dreamer = new MemoryDreamer({ contextLimitTokens: 200_000, db: env.store.db, records: new FeatureRecordStore(env.store.db), memory, agentStore: env.agentStore, projectsStore: env.projects, model, provider: "openai", maxSteps: 3 });
  const result = await dreamer.run("idle", { kind: "user" });
  expect(result).toMatchObject({ status: "failed", appliedCount: 1 });
  const row = env.store.db.prepare("select status, finished_at from memory_dream_runs where id = ?").get(result.runId) as { status: string; finished_at: string | null };
  expect(row.status).toBe("failed");
  expect(row.finished_at).not.toBeNull();
});

test("a merge into a memory the user stated takes the merged text and keeps their quote", async () => {
  const t = setup();
  try {
    const said = await t.memory.remember({ scope: "user", type: "preference", source: "user", userQuote: "always back up first", content: "Back up before deploying." });
    const dup = await t.memory.remember({ scope: "user", type: "preference", source: "extraction", content: "The user wants a backup before every deploy." });
    const { model, dreamer } = t.dreamer([
      step({ toolName: "apply_action", args: { type: "merge", memoryId: dup.id, targetMemoryId: said.id, content: "Back up before deploying, every time.", reason: "duplicate" } }),
      step({ toolName: "write_brief", args: { content: "The user: careful deployer." } })
    ]);
    expect(await dreamer.run("manual", { kind: "user" })).toMatchObject({ status: "succeeded", appliedCount: 1, rejectedCount: 0 });
    expect(t.toolResults(model, 1).find((r) => r.toolName === "apply_action")?.output.value)
      .toEqual({ status: "applied", memoryId: dup.id, actionType: "merge" });
    expect(await t.memory.get(said.id)).toMatchObject({ status: "available", source: "user", content: "Back up before deploying, every time.", userQuote: "always back up first" });
    expect((await t.memory.get(dup.id))?.status).toBe("archived");
    const recorded = t.env.store.db.prepare("select source_json from memory_dream_actions where memory_id = ?").get(dup.id) as { source_json: string };
    expect(JSON.parse(recorded.source_json)).toMatchObject({ content: "Back up before deploying, every time." });
  } finally {
    t.env.cleanup();
  }
});

test("a run that leaves its partition empty removes the brief", async () => {
  const t = setup();
  try {
    const only = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "one-off event" });
    t.memory.putBrief({ scope: "project", projectId: t.project1, content: "OLD BRIEF", inputDigest: "stale", builtAt: "2026-01-01T00:00:00.000Z", runId: null });
    const { dreamer } = t.dreamer([
      step({ toolName: "apply_action", args: { type: "archive", memoryId: only.id, reason: "one-off" } }),
      step({ toolName: "write_brief", args: { content: "project-1: nothing left." } })
    ]);
    expect(await dreamer.run("idle", { kind: "project", projectId: t.project1 })).toMatchObject({ status: "succeeded", appliedCount: 1 });
    expect(t.memory.getBrief("project", t.project1)).toBeNull();
    expect(dreamer.needsRun({ kind: "project", projectId: t.project1 })).toBe(false);
  } finally {
    t.env.cleanup();
  }
});

test("a step cut off at the output token limit fails the run, once, as a model error", async () => {
  const t = setup();
  try {
    const a = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "project-1 uses project-2" });
    const model = createMockLLM([
      step({ toolName: "apply_action", args: { type: "update", memoryId: a.id, content: "project-1 uses project-2 for caching.", reason: "clearer" } }),
      { text: "Now the brief: project-1 is", finishReason: "length" },
      step({ toolName: "write_brief", args: { content: "never reached" } })
    ]);
    const dreamer = new MemoryDreamer({ contextLimitTokens: 200_000, db: t.env.store.db, records: new FeatureRecordStore(t.env.store.db), memory: t.memory, agentStore: t.env.agentStore, projectsStore: t.env.projects, model, provider: "openai", maxSteps: 3 });
    const result = await dreamer.run("idle", { kind: "project", projectId: t.project1 });
    expect(result).toMatchObject({ status: "failed", appliedCount: 1 });
    expect(model.streamCalls).toHaveLength(2);
    const row = t.env.store.db.prepare("select metadata_json from memory_dream_runs where id = ?").get(result.runId) as { metadata_json: string };
    expect(JSON.parse(row.metadata_json)).toMatchObject({ finishReason: "model_error" });
  } finally {
    t.env.cleanup();
  }
});

test("a model error after actions keeps the run's counts and reports a failed run", async () => {
  const t = setup();
  try {
    const a = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "project-1 uses project-2" });
    const model = createMockLLM([
      step({ toolName: "apply_action", args: { type: "update", memoryId: a.id, content: "project-1 uses project-2 for caching.", reason: "clearer" } }),
      { error: new Error("model down") },
      { error: new Error("model down") }
    ]);
    const dreamer = new MemoryDreamer({ contextLimitTokens: 200_000, db: t.env.store.db, records: new FeatureRecordStore(t.env.store.db), memory: t.memory, agentStore: t.env.agentStore, projectsStore: t.env.projects, model, provider: "openai", maxSteps: 3 });
    const result = await dreamer.run("idle", { kind: "project", projectId: t.project1 });
    expect(result).toMatchObject({ status: "failed", appliedCount: 1, actionCount: 1 });
    const row = t.env.store.db.prepare("select status, applied_count, metadata_json from memory_dream_runs where id = ?").get(result.runId) as { status: string; applied_count: number; metadata_json: string };
    expect(row).toMatchObject({ status: "failed", applied_count: 1 });
    expect(JSON.parse(row.metadata_json)).toMatchObject({ actionCount: 1, finishReason: "model_error" });
  } finally {
    t.env.cleanup();
  }
});

// The merged-away memory is archived before anything waits, so a change made
// to it meanwhile (the user's words through memory_update) cannot slip past
// the check that allowed the merge.
test("a merge archives the merged memory before the target's new text is embedded", async () => {
  const env = freshStoresEnv("md-dream-v2-order-");
  const statusWhenEmbedding: string[] = [];
  let a: { id: string } | null = null;
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db, {
    embedder: { model: "test", async embed(text) {
      if (text === "Merged words.") statusWhenEmbedding.push((env.store.db.prepare("select status from memory_entries where id = ?").get(a!.id) as { status: string }).status);
      return [1, 0];
    } }
  }));
  a = await memory.remember({ scope: "user", type: "preference", source: "agent", content: "short replies" });
  const b = await memory.remember({ scope: "user", type: "preference", source: "agent", content: "Replies stay short." });
  const model = createMockLLM([
    step({ toolName: "apply_action", args: { type: "merge", memoryId: a.id, targetMemoryId: b.id, content: "Merged words.", reason: "same" } }),
    step({ toolName: "write_brief", args: { content: "Brief." } })
  ]);
  await new MemoryDreamer({ contextLimitTokens: 200_000, db: env.store.db, records: new FeatureRecordStore(env.store.db), memory, agentStore: env.agentStore, projectsStore: env.projects, model, provider: "openai", maxSteps: 3 })
    .run("manual", { kind: "user" });
  expect(statusWhenEmbedding).toStrictEqual(["archived"]);
});

test("the job runs changed partitions only, each at most every six hours unless forced, and only after an idle hour", async () => {
  let now = Date.parse("2026-10-07T12:00:00.000Z");
  const runs: string[] = [];
  const changed = new Set(["user", "project:proj_1"]);
  const env = freshStoresEnv("md-dream-v2-job-");
  const job = new MemoryDreamJob({
    db: env.store.db,
    activeProjectIds: () => ["proj_1", "proj_2"],
    dreamer: {
      needsRun: (p) => changed.has(p.kind === "user" ? "user" : `project:${p.projectId}`),
      unusedSinceBrief: () => null,
      run: async (trigger, p) => {
        const key = p.kind === "user" ? "user" : `project:${p.projectId}`;
        runs.push(key);
        changed.delete(key);
        env.store.db.prepare(`insert into memory_dream_runs (id, trigger, status, phase, project_id, started_at, finished_at)
            values (?, ?, 'succeeded', ?, ?, ?, ?)`).run(`drm_${runs.length}`, trigger, p.kind, p.kind === "project" ? p.projectId : null, new Date(now).toISOString(), new Date(now).toISOString());
        return { runId: `drm_${runs.length}`, trigger, phase: p.kind, projectId: p.kind === "project" ? p.projectId : null, processed: true, status: "succeeded", candidateCount: 1, actionCount: 0, appliedCount: 0, rejectedCount: 0, failedCount: 0 };
      }
    },
    idleMs: 60 * 60 * 1000,
    partitionIntervalMs: 6 * 60 * 60 * 1000,
    now: () => now
  });
  // Inside the first idle hour, and within an hour of the user's last words, nothing runs.
  now += 30 * 60 * 1000;
  expect(await job.tick("idle")).toEqual({ skipped: true, reason: "not_idle_long_enough" });
  now += 90 * 60 * 1000;
  const thread = env.agentStore.createManagerThread("t");
  const said = env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "hi" } });
  env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(new Date(now - 10 * 60 * 1000).toISOString(), said.id);
  expect(await job.tick("idle")).toEqual({ skipped: true, reason: "not_idle_long_enough" });
  expect(runs).toStrictEqual([]);
  now += 60 * 60 * 1000;
  await job.tick("idle");
  expect(runs).toStrictEqual(["user", "project:proj_1"]);

  changed.add("user");
  now += 60 * 60 * 1000;
  expect(await job.tick("idle")).toEqual({ skipped: true, reason: "nothing_due" });
  await job.tick("manual", { force: true });
  expect(runs).toStrictEqual(["user", "project:proj_1", "user"]);
});

test("by default the job waits for half an hour after the user's last words", async () => {
  let now = Date.parse("2026-10-07T12:00:00.000Z");
  const runs: string[] = [];
  const env = freshStoresEnv("md-dream-v2-idle-");
  const job = new MemoryDreamJob({
    db: env.store.db,
    activeProjectIds: () => [],
    dreamer: {
      needsRun: () => runs.length === 0,
      unusedSinceBrief: () => null,
      run: async (trigger, p) => {
        runs.push(p.kind);
        return { runId: "drm_1", trigger, phase: p.kind, projectId: null, processed: true, status: "succeeded", candidateCount: 1, actionCount: 0, appliedCount: 0, rejectedCount: 0, failedCount: 0 };
      }
    },
    now: () => now
  });
  const thread = env.agentStore.createManagerThread("t");
  const said = env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "hi" } });
  env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(new Date(now).toISOString(), said.id);
  now += 29 * 60 * 1000;
  expect(await job.tick("idle")).toEqual({ skipped: true, reason: "not_idle_long_enough" });
  now += 60 * 1000;
  await job.tick("idle");
  expect(runs).toStrictEqual(["user"]);
});

// A user who never pauses for half an hour still gets their memory curated:
// a change waits for a quiet moment at most six hours.
function overdueJob(env: ReturnType<typeof freshStoresEnv>, now: () => number, changed: Set<string>, runs: Array<[string, string]>) {
  const keyOf = (p: { kind: "user" } | { kind: "project"; projectId: string }) => p.kind === "user" ? "user" : `project:${p.projectId}`;
  return new MemoryDreamJob({
    db: env.store.db,
    activeProjectIds: () => ["proj_1"],
    dreamer: {
      needsRun: (p) => changed.has(keyOf(p)),
      unusedSinceBrief: () => null,
      run: async (trigger, p) => {
        runs.push([trigger, keyOf(p)]);
        changed.delete(keyOf(p));
        return { runId: `drm_${runs.length}`, trigger, phase: p.kind, projectId: p.kind === "project" ? p.projectId : null, processed: true, status: "succeeded", candidateCount: 1, actionCount: 0, appliedCount: 0, rejectedCount: 0, failedCount: 0 };
      }
    },
    now
  });
}

function userSays(env: ReturnType<typeof freshStoresEnv>, at: number) {
  const thread = env.agentStore.createManagerThread("t");
  const said = env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "go on" } });
  env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(new Date(at).toISOString(), said.id);
}

const HOUR = 60 * 60 * 1000;
const NOT_QUIET = { skipped: true, reason: "not_idle_long_enough" } as const;

test("while the user keeps talking, a change that has waited six hours is curated anyway, and one that has not waits", async () => {
  let now = Date.parse("2026-10-07T12:00:00.000Z");
  const runs: Array<[string, string]> = [];
  const changed = new Set(["user"]);
  const env = freshStoresEnv("md-dream-v2-overdue-");
  const job = overdueJob(env, () => now, changed, runs);
  const busyTick = async (at: number) => { now = at; userSays(env, now - 5 * 60 * 1000); return job.tick("idle"); };
  const start = now;
  expect(await busyTick(start)).toEqual(NOT_QUIET);
  changed.add("project:proj_1");
  expect(await busyTick(start + HOUR)).toEqual(NOT_QUIET);
  // Ticks in between leave the wait where it began.
  expect(await busyTick(start + 3 * HOUR)).toEqual(NOT_QUIET);
  expect(await busyTick(start + 6 * HOUR - 60 * 1000)).toEqual(NOT_QUIET);
  await busyTick(start + 6 * HOUR);
  // Not "idle": the user was talking when it ran.
  expect(runs).toStrictEqual([["overdue", "user"]]);
  // When the user does pause, what is due runs as before.
  now += 40 * 60 * 1000;
  await job.tick("idle");
  expect(runs).toStrictEqual([["overdue", "user"], ["idle", "project:proj_1"]]);
});

test("the wait starts when a tick first sees the change, outlives a job rebuilt on the same database, and starts over after a run", async () => {
  let now = Date.parse("2026-10-07T12:00:00.000Z");
  const runs: Array<[string, string]> = [];
  const changed = new Set(["user"]);
  const env = freshStoresEnv("md-dream-v2-overdue-rebuilt-");
  const busyTick = async (job: MemoryDreamJob, at: number) => { now = at; userSays(env, now - 5 * 60 * 1000); return job.tick("idle"); };
  const start = now;
  expect(await busyTick(overdueJob(env, () => now, changed, runs), start)).toEqual(NOT_QUIET);
  // The config reloaded: a new job on the same database.
  const rebuilt = overdueJob(env, () => now, changed, runs);
  await busyTick(rebuilt, start + 6 * HOUR);
  expect(runs).toStrictEqual([["overdue", "user"]]);
  const ran = now;
  changed.add("user");
  expect(await busyTick(rebuilt, ran + 5 * 60 * 1000)).toEqual(NOT_QUIET);
  expect(await busyTick(rebuilt, ran + 6 * HOUR)).toEqual(NOT_QUIET);
  await busyTick(rebuilt, ran + 6 * HOUR + 5 * 60 * 1000);
  expect(runs).toStrictEqual([["overdue", "user"], ["overdue", "user"]]);
});

// A partition with no brief whose only memory was forgotten needs no run, and
// none came; a memory added later has not waited.
test("a partition that stops needing a run without one waits afresh when it needs one again", async () => {
  let now = Date.parse("2026-10-07T12:00:00.000Z");
  const runs: Array<[string, string]> = [];
  const changed = new Set(["user"]);
  const env = freshStoresEnv("md-dream-v2-overdue-gone-");
  const job = overdueJob(env, () => now, changed, runs);
  const busyTick = async (at: number) => { now = at; userSays(env, now - 5 * 60 * 1000); return job.tick("idle"); };
  const start = now;
  expect(await busyTick(start)).toEqual(NOT_QUIET);
  changed.delete("user");
  expect(await busyTick(start + HOUR)).toEqual({ skipped: true, reason: "nothing_due" });
  changed.add("user");
  expect(await busyTick(start + 6 * HOUR)).toEqual(NOT_QUIET);
  await busyTick(start + 12 * HOUR);
  expect(runs).toStrictEqual([["overdue", "user"]]);
});

// The job is rebuilt when the config reloads; a dream still running in the old
// one must keep the new one from starting another.
test("a second job on the same database does not start while a dream runs", async () => {
  const env = freshStoresEnv("md-dream-v2-guard-");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const dreamer = {
    needsRun: () => true,
    unusedSinceBrief: () => null,
    run: async (trigger: string, p: { kind: "user" } | { kind: "project"; projectId: string }) => {
      await held;
      return { runId: "drm_1", trigger, phase: p.kind, projectId: null, processed: true, status: "succeeded" as const, candidateCount: 0, actionCount: 0, appliedCount: 0, rejectedCount: 0, failedCount: 0 };
    }
  };
  const first = new MemoryDreamJob({ db: env.store.db, activeProjectIds: () => [], dreamer });
  const second = new MemoryDreamJob({ db: env.store.db, activeProjectIds: () => [], dreamer });
  const running = first.tick("manual", { force: true });
  expect(await second.tick("manual", { force: true })).toEqual({ skipped: true, reason: "already_running" });
  release();
  await running;
  const again = second.tick("manual", { force: true });
  release();
  expect(await again).toMatchObject({ runCount: 1 });
});

test("a run reviews its whole partition: every memory listed, the changed ones marked", async () => {
  const t = setup();
  try {
    const old = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "Releases are tagged from main." });
    // A memory written in the millisecond a run starts counts as changed.
    await Bun.sleep(2);
    const first = t.dreamer([step({ toolName: "write_brief", args: { content: "project-1: memory." } })]);
    await first.dreamer.run("manual", { kind: "project", projectId: t.project1 });
    await Bun.sleep(2);
    const fresh = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "CI runs on push." });
    const second = t.dreamer([step({ toolName: "write_brief", args: { content: "project-1: memory." } })]);
    await second.dreamer.run("manual", { kind: "project", projectId: t.project1 });
    const opening = String((second.model.streamCalls[0]?.prompt as Array<{ role: string; content: Array<{ text?: string }> }>)
      .find((m) => m.role === "user")!.content.map((part) => part.text ?? "").join(""));
    expect(opening).toContain("## This partition's memories (2; ★ = changed since the brief)");
    expect(opening).toContain(`★ [${fresh.id}] knowledge, agent`);
    expect(opening).toContain(`- [${old.id}] knowledge, agent`);
    expect(opening).toContain("Review every memory, act, then write the brief: writing it ends the run.");
  } finally {
    t.env.cleanup();
  }
});

test("a project run reads the user's memories, read-only; a user run does not list the projects'", async () => {
  const t = setup();
  try {
    const rule = await t.memory.remember({ scope: "user", type: "preference", source: "user", userQuote: "clean it up", content: "Clean a closed thread's worktree." });
    const local = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "Closing a thread does not authorize cleanup." });
    const project = t.dreamer([step({ toolName: "write_brief", args: { content: "project-1: memory." } })]);
    await project.dreamer.run("manual", { kind: "project", projectId: t.project1 });
    const projectOpening = JSON.stringify(project.model.streamCalls[0]?.prompt);
    expect(projectOpening).toContain("## The user's memories (1; read-only in this run)");
    expect(projectOpening).toContain(`[${rule.id}] preference, user, stated`);
    const user = t.dreamer([step({ toolName: "write_brief", args: { content: "The user: memory." } })]);
    await user.dreamer.run("manual", { kind: "user" });
    const userOpening = JSON.stringify(user.model.streamCalls[0]?.prompt);
    expect(userOpening).not.toContain("read-only in this run");
    expect(userOpening).not.toContain(local.id);
  } finally {
    t.env.cleanup();
  }
});

test("a run keeps, per step, each tool it called: its arguments in short, the size of what the model got back, and its status", async () => {
  const t = setup();
  try {
    const keep = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "Export API is rows-only." });
    const dup = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "extraction", content: "The export API returns rows only." });
    const brief = `project-1: what agents need.\n- ${"Export API is rows-only. ".repeat(20)}`;
    const { model, dreamer } = t.dreamer([
      step(
        { toolName: "read_entry", args: { memoryId: keep.id } },
        { toolName: "apply_action", args: { type: "merge", memoryId: dup.id, targetMemoryId: keep.id, reason: "same fact" } },
        { toolName: "apply_action", args: { type: "archive", memoryId: "mem_missing", reason: "gone" } },
        { toolName: "read", args: { path: "notes.md" } }
      ),
      step({ toolName: "write_brief", args: { content: brief } })
    ]);
    const result = await dreamer.run("manual", { kind: "project", projectId: t.project1 });
    expect(result).toMatchObject({ status: "succeeded" });
    const row = t.env.store.db.prepare("select metadata_json from memory_dream_runs where id = ?").get(result.runId) as { metadata_json: string };
    const steps = JSON.parse(row.metadata_json).steps as Array<{ step: number; tools: Array<{ name: string; args: string; chars: number; status?: string; error?: boolean }> }>;
    expect(steps.map((s) => [s.step, s.tools.map((x) => [x.name, x.status ?? null, x.error ?? false])])).toEqual([
      [1, [["read_entry", null, false], ["apply_action", "applied", false], ["apply_action", "rejected", false], ["read", null, true]]],
      [2, [["write_brief", steps[1]!.tools[0]!.status ?? null, false]]]
    ]);
    // What the model got back, as it got it.
    const got = t.toolResults(model, 1).map((r) => (typeof r.output.value === "string" ? (r.output.value as string).length : JSON.stringify(r.output.value).length));
    expect(steps[0]!.tools.map((x) => x.chars)).toEqual(got);
    // The arguments as they were called, cut short.
    expect(steps[0]!.tools[0]!.args).toBe(JSON.stringify({ memoryId: keep.id }));
    expect(steps[1]!.tools[0]!.args).toBe(JSON.stringify({ content: brief }).slice(0, 300));
    // The Memory page's runs do not carry it.
    const listed = listMemoryDreamRuns(t.env.store.db).find((r) => r.id === result.runId);
    expect(listed?.metadata).not.toHaveProperty("steps");
  } finally {
    t.env.cleanup();
  }
});

test("a run's step log keeps every step: one that called nothing, and one whose model call failed", async () => {
  const t = setup();
  try {
    const keep = await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "Export API is rows-only." });
    const partition = { kind: "project" as const, projectId: t.project1 };
    const stepsOf = (runId: string) => (JSON.parse((t.env.store.db.prepare("select metadata_json from memory_dream_runs where id = ?").get(runId) as { metadata_json: string }).metadata_json).steps as Array<{ step: number; tools: Array<{ name: string }>; failed?: boolean }>)
      .map((s) => [s.step, s.tools.map((x) => x.name), s.failed ?? false]);
    const quiet = t.dreamer([step({ toolName: "read_entry", args: { memoryId: keep.id } }), { text: "Done.", finishReason: "stop" }]);
    const stopped = await quiet.dreamer.run("manual", partition);
    expect(stepsOf(stopped.runId)).toEqual([[1, ["read_entry"], false], [2, [], false]]);
    const down = t.dreamer([step({ toolName: "read_entry", args: { memoryId: keep.id } }), { error: new Error("model down") }, { error: new Error("model down") }]);
    const failed = await down.dreamer.run("manual", partition).catch(() => null);
    const runId = failed?.runId ?? (t.env.store.db.prepare("select id from memory_dream_runs order by started_at desc limit 1").get() as { id: string }).id;
    expect(stepsOf(runId)).toEqual([[1, ["read_entry"], false], [2, [], true]]);
  } finally {
    t.env.cleanup();
  }
});

test("a change to the user's memories leaves every project's brief current; a change of its own does not", async () => {
  const t = setup();
  try {
    await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "Releases are tagged from main." });
    const rule = await t.memory.remember({ scope: "user", type: "preference", source: "user", userQuote: "keep it", content: "Keep worktrees." });
    const project = t.dreamer([step({ toolName: "write_brief", args: { content: "project-1: memory." } })]);
    const partition = { kind: "project" as const, projectId: t.project1 };
    await project.dreamer.run("manual", partition);
    // The brief stands for the project's own memories only.
    expect(t.memory.getBrief("project", t.project1)?.inputDigest).toBe(entriesDigest(t.memory.listAvailable({ scope: "project", projectId: t.project1 })));
    expect(project.dreamer.needsRun(partition)).toBe(false);
    // The Memory page says the same, throughout.
    const { listMemoryBriefs } = await import("../src/server/modules/memory/browse.js");
    const projectStale = () => listMemoryBriefs(t.env.store.db).briefs.find((b) => b.scope === "project")?.stale;
    expect(projectStale()).toBe(false);
    await t.memory.update({ id: rule.id, content: "Clean worktrees when a thread closes." });
    await t.memory.remember({ scope: "user", type: "preference", source: "agent", content: "Replies stay short." });
    expect(project.dreamer.needsRun(partition)).toBe(false);
    expect(projectStale()).toBe(false);
    await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "Exports are UTF-8." });
    expect(project.dreamer.needsRun(partition)).toBe(true);
    expect(projectStale()).toBe(true);
  } finally {
    t.env.cleanup();
  }
});

test("the system prompt is the same for every partition up to its last lines", () => {
  const projects = [{ id: "proj_1", name: "project-1" }];
  const user = buildDreamSystemPrompt({ kind: "user" }, projects, 370_000);
  const project = buildDreamSystemPrompt({ kind: "project", projectId: "proj_1" }, projects, 370_000);
  const shared = user.split("\n").filter((line, i) => project.split("\n")[i] === line).length;
  expect(shared).toBeGreaterThan(user.split("\n").length - 4);
  expect(project).toContain("This run keeps project project-1");
  // The brief is read by agents: its first line names whose memory it is, not "this partition".
  expect(user).toContain("- Its first line is one sentence saying whose memory this is and what it covers.");
  expect(user).not.toContain("what this partition is about");
  // The prompt's wording, line by line.
  for (const line of [
    "1. Review every memory in the first message, not only the changed ones (marked ★): is it still true, still useful to an agent a month from now, in the right partition, consistent with the others and with the user's memories? Read related memories (search_memory, read_entry), and check what names something in the project's files against them (bash, read).",
    "   Use the shell only to look: ls, cat, grep, find, and in a git repository git log, git show <branch>:<path> and git grep <text> <branch>. Change nothing: no writing files, and no checkout, stash, pull, fetch or anything else that changes a branch, the folder or reaches the network.",
    "   - Events, incidents, status snapshots and one-off records are not memories. Before you archive one, keep what still matters in it: a decision and its reason, a risk that was accepted, a problem known and left open, something the user said. A one-off exception or a finished piece of work is not a lasting decision. Update it to state only that, or move that into the memory it belongs with; archive it when nothing lasting is left. Never merge events into a bigger one, and never add ids, hashes, sizes, counts or versions.",
    "   - A memory that names something in the project's files — a document, a file, a setting, a tool, a function — is checked against them before it stays. Update the memory when the files show the thing changed; archive it only when they show it removed or replaced. Not finding a name proves nothing: it may sit where you cannot look. In a git repository the files exist in several versions (see \"Where the work is\"): go by the newest; git log -S finds the commit that removed a name. Say what you checked, and where, in the reason.",
    "   - A memory that only repeats what the project's files show — where something is, what a document or a setting says, how the code works — is not a memory: agents read the files. Archive it, unless it also says what the files cannot (why it is so, a decision, a convention, a pitfall); then update it to say only that. What is left must itself be lasting: when it is status, a step still to take or a check of one change, archive the memory whole.",
    "   - One lesson is one memory: a rule with its reason, where it applies, its cases and what the user said about it. Merge the memories that hold parts of one lesson — the same rule or fact however worded, a case of it, its reason, a restatement — into the one that should remain. Compare them sentence by sentence first: whatever the source holds that the one that remains does not (a fact, a reason, a case, a name) goes into the merged content.",
    "   - Split a memory that holds several lessons; a lesson's rule, reason and cases stay together.",
    "   - A memory belongs where the agents who act on it work. One that matters in one project belongs to that project, whatever system it is about; one that matters in several projects but not all is kept in each of them. Only what holds in every project belongs to the user's memories: move the rest out.",
    "- User brief: who the user is — what the memories and the projects show of them: the projects they work on, their roles, the languages they work in — then their preferences and working rules, grouped, most important first.",
    "   - Archive memories proved wrong or obsolete.",
    "Each memory is one of: preference (how the user wants things done), knowledge (a fact the project's files and their history do not show).",
    "The first message lists the project's recent task records, what workers did: they are history, not memories, and nothing changes them; use them to tell when later work changed what a memory says.",
    "Make tool calls that do not depend on each other's results together, in one response; a call that needs another's result waits for it.",
    "- One rule or fact per bullet, never several joined by semicolons, in full sentences an agent new to this can follow; spell out every abbreviation and term the first time it appears.",
    "- No events, progress or status; when a date matters, give it as a date.",
    "- When a topic holds more than the brief has room for, keep its most important rules and end it with one line saying what to search for the rest: the words to give memory_search.",
    "- Project brief: the project's conventions and key knowledge. Agents get the project's recent work beside it, so the brief does not list task records. When a project rule departs from one of the user's, say it is this project's exception."
  ]) expect(user.split("\n")).toContain(line);
  // Replaced: merging without a sentence check, the move-out line, "in their wording".
  expect(user).not.toContain("give merged content when the source adds something");
  // Replaced: merging by the same rule only, splitting by "several things".
  expect(user).not.toContain("   - Merge duplicates");
  expect(user.split("\n")).not.toContain("   - Split a memory that holds several things.");
  expect(user).not.toContain("such as a rule that applies to one project, out of the user's memories");
  expect(user).not.toContain("in their wording");
  // How much a run may do is its room, the compaction threshold less what the brief needs.
  expect(user.split("\n")).toContain("This run has room until its conversation reaches about 370000 tokens; when apply_action says the room is used up, write the brief next. The brief must fit in 3000 tokens; write_brief refuses a longer one.");
  expect(user).not.toContain("At most");
  // A memory the user stated is judged as any other: no rule of its own.
  expect(user).not.toContain("A memory the user stated");
  expect(user).not.toContain("their words");
  expect(user).not.toContain("Archive one-off events");
  expect(user).not.toContain("search_code");
  expect(user).not.toContain("Only the user can weaken their own rule");
  // Task records are not memory: no task type, no index of them in the brief.
  expect(user).not.toContain("Task records are history: never change them");
  expect(user).not.toContain("an index of recent task records");
  expect(project).toContain("This run keeps project project-1 (proj_1). The user's memories are listed in the first message, read-only here: archive a project memory that repeats one of them; when one contradicts a user memory, the later statement holds — update or archive the project memory, unless it is an exception for this project, which then says so. Move a rule that holds everywhere to the user's memories. It may move a memory to another project:");
  expect(user).toContain("This run keeps the user's memories. A rule that holds for one project only moves to that project:");
});

// A run in flight when the server stops (a restart, a deploy) was left
// "running" for good: the Memory page drew it as live and kept polling. At
// startup such runs are closed as failed, saying why; what they applied stands.

function insertRun(db: ReturnType<typeof freshStoresEnv>["store"]["db"], id: string, status: string, startedAt: string) {
  db.prepare(`insert into memory_dream_runs (id, trigger, status, provider, model, candidate_count, applied_count, error_json, metadata_json, started_at, finished_at, available_count_before, available_count_after, phase, project_id)
    values (?, 'idle', ?, 'openai', 'gpt-6.1-sol', 3, 0, null, ?, ?, ?, 3, null, 'user', null)`)
    .run(id, status, status === "running" ? null : JSON.stringify({ finishReason: "finished: tidied" }), startedAt, status === "running" ? null : startedAt);
}
function insertAction(db: ReturnType<typeof freshStoresEnv>["store"]["db"], id: string, runId: string, status: string) {
  db.prepare(`insert into memory_dream_actions (id, run_id, action_type, status, memory_id, target_memory_id, before_json, after_json, reason, source_json, error_json, created_at, applied_at)
    values (?, ?, 'update', ?, 'mem_x', null, null, null, 'clearer', null, null, '2026-10-16T07:20:00.000Z', null)`).run(id, runId, status);
}

test("a run left running is closed as failed, saying the server restarted, with what it applied counted; finished runs are left alone", () => {
  const env = freshStoresEnv("md-dream-restart-");
  const db = env.store.db;
  insertRun(db, "drm_cut", "running", "2026-10-16T07:16:53.000Z");
  insertAction(db, "dma_1", "drm_cut", "applied");
  insertAction(db, "dma_2", "drm_cut", "applied");
  insertAction(db, "dma_3", "drm_cut", "rejected");
  insertRun(db, "drm_done", "succeeded", "2026-10-16T06:00:00.000Z");

  expect(closeInterruptedDreamRuns(db)).toBe(1);
  const runs = Object.fromEntries(listMemoryDreamRuns(db).map((run) => [run.id, run]));
  expect(runs.drm_cut).toMatchObject({
    status: "failed",
    appliedCount: 2,
    finishReason: "The server restarted during this run.",
    error: { message: "The server restarted during this run." }
  });
  expect(runs.drm_cut!.finishedAt).not.toBeNull();
  expect(runs.drm_done).toMatchObject({ status: "succeeded", finishReason: "finished: tidied", finishedAt: "2026-10-16T06:00:00.000Z" });
  // Nothing left to close.
  expect(closeInterruptedDreamRuns(db)).toBe(0);
});

// The memory change committed first, then its new text was embedded (network
// calls), and only then was the action recorded: a restart in between left
// the memory changed with no record of it in the run or its history.
test("an applied action is recorded in the write that changes the memory, before its new text is embedded", async () => {
  const env = freshStoresEnv("md-dream-v2-record-with-write-");
  const recordedAtEmbed: number[] = [];
  const provider = new LocalMemoryProvider(env.store.db, {
    embedder: { model: "test", async embed() {
      recordedAtEmbed.push((env.store.db.prepare("select count(*) as n from memory_dream_actions where status = 'applied'").get() as { n: number }).n);
      return [1, 0];
    } }
  });
  const memory = new MemoryManager(provider);
  const a = await memory.remember({ scope: "user", type: "preference", source: "agent", content: "Prefers short replies" });
  recordedAtEmbed.length = 0;
  const model = createMockLLM([
    step({ toolName: "apply_action", args: { type: "update", memoryId: a.id, content: "Prefers short replies in chat", reason: "sharper" } }),
    step({ toolName: "write_brief", args: { content: "Brief." } })
  ]);
  const dreamer = new MemoryDreamer({ contextLimitTokens: 200_000, db: env.store.db, records: new FeatureRecordStore(env.store.db), memory, agentStore: env.agentStore, projectsStore: env.projects, model, provider: "openai", maxSteps: 2 });
  expect(await dreamer.run("manual", { kind: "user" })).toMatchObject({ appliedCount: 1, failedCount: 0 });
  expect(recordedAtEmbed).toStrictEqual([1]);
  expect((env.store.db.prepare("select count(*) as n from memory_dream_actions where status = 'applied'").get() as { n: number }).n).toBe(1);
});

test("a project is unused since its brief while no worker of the project has spoken since the brief was built", async () => {
  const t = setup();
  try {
    const { dreamer } = t.dreamer([]);
    const project = { kind: "project" as const, projectId: t.project1 };
    await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "Export API is rows-only." });
    // No brief yet: never curated, so not unused since one.
    expect(dreamer.unusedSinceBrief(project)).toBe(null);
    const builtAt = "2026-10-20T00:00:00.000Z";
    t.memory.putBrief({ scope: "project", projectId: t.project1, content: "project-1 brief", inputDigest: "older", builtAt, runId: null });
    expect(dreamer.unusedSinceBrief(project)).toBe(Date.parse(builtAt));
    const say = (featureId: string, at: string) => {
      const thread = t.env.agentStore.getOrCreateThread("worker", featureId);
      const message = t.env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "text", text: "Working on it." } });
      t.env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(at, message.id);
    };
    // A worker of another project after the brief, and one of this project before it: still unused.
    const other = seedProject(t.env.projects, { name: "project-2", tmuxSessionName: "md-project-2" });
    say(seedFeature(t.env.features, other, { name: "elsewhere", tmuxWindowName: "elsewhere" }), "2026-10-21T00:00:00.000Z");
    const here = seedFeature(t.env.features, t.project1, { name: "here", tmuxWindowName: "here" });
    say(here, "2026-10-19T00:00:00.000Z");
    expect(dreamer.unusedSinceBrief(project)).toBe(Date.parse(builtAt));
    // A project with a brief and no memories left is not held back, though no worker spoke since.
    t.memory.putBrief({ scope: "project", projectId: other, content: "project-2 brief", inputDigest: "older", builtAt: "2026-10-22T00:00:00.000Z", runId: null });
    expect(dreamer.unusedSinceBrief({ kind: "project", projectId: other })).toBe(null);
    // Its worker speaks after the brief: used, and still once the worker is archived.
    say(here, "2026-10-21T00:00:00.000Z");
    t.env.features.archive(here);
    expect(dreamer.unusedSinceBrief(project)).toBe(null);
    // The user's memories are nobody's project, brief or not.
    await t.memory.remember({ scope: "user", type: "preference", source: "agent", content: "Replies stay short." });
    t.memory.putBrief({ scope: "user", projectId: null, content: "user brief", inputDigest: "older", builtAt, runId: null });
    expect(dreamer.unusedSinceBrief({ kind: "user" })).toBe(null);
  } finally {
    t.env.cleanup();
  }
});

test("a project no worker has used since its brief keeps its change waiting, a week at most; Dream now runs it anyway", async () => {
  let now = Date.parse("2026-10-07T12:00:00.000Z");
  const runs: string[] = [];
  const needs = new Set<string>();
  let unusedSince: number | null = now;
  const env = freshStoresEnv("md-dream-v2-unused-");
  const keyOf = (p: { kind: "user" } | { kind: "project"; projectId: string }) => (p.kind === "user" ? "user" : `project:${p.projectId}`);
  const job = new MemoryDreamJob({
    db: env.store.db,
    activeProjectIds: () => ["proj_1"],
    dreamer: {
      needsRun: (p) => needs.has(keyOf(p)),
      unusedSinceBrief: (p) => (p.kind === "project" ? unusedSince : null),
      run: async (trigger, p) => {
        runs.push(keyOf(p));
        needs.delete(keyOf(p));
        env.store.db.prepare(`insert into memory_dream_runs (id, trigger, status, phase, project_id, started_at, finished_at)
            values (?, ?, 'succeeded', ?, ?, ?, ?)`).run(`drm_${runs.length}`, trigger, p.kind, p.kind === "project" ? p.projectId : null, new Date(now).toISOString(), new Date(now).toISOString());
        return { runId: `drm_${runs.length}`, trigger, phase: p.kind, projectId: p.kind === "project" ? p.projectId : null, processed: true, status: "succeeded", candidateCount: 1, actionCount: 0, appliedCount: 0, rejectedCount: 0, failedCount: 0 };
      }
    },
    idleMs: 60 * 1000,
    now: () => now
  });
  try {
    const hours = (n: number) => { now += n * 60 * 60 * 1000; };
    // Both change; the user's memories run, the unused project waits.
    needs.add("user");
    needs.add("project:proj_1");
    hours(7);
    await job.tick("idle");
    expect(runs).toStrictEqual(["user"]);
    // Six days and twenty-three hours after its brief: still waiting.
    hours(6 * 24 + 16);
    expect(await job.tick("idle")).toEqual({ skipped: true, reason: "nothing_due" });
    // A week after its brief it runs, used or not.
    hours(1);
    await job.tick("idle");
    expect(runs).toStrictEqual(["user", "project:proj_1"]);
    // Its new brief, then a change: waiting again, until Dream now.
    unusedSince = now;
    needs.add("project:proj_1");
    hours(7);
    expect(await job.tick("idle")).toEqual({ skipped: true, reason: "nothing_due" });
    await job.tick("manual", { force: true });
    expect(runs).toStrictEqual(["user", "project:proj_1", "project:proj_1"]);
    // A worker works there: its next change takes the six hours, as before.
    unusedSince = null;
    needs.add("project:proj_1");
    hours(5);
    expect(await job.tick("idle")).toEqual({ skipped: true, reason: "nothing_due" });
    hours(1);
    await job.tick("idle");
    expect(runs).toStrictEqual(["user", "project:proj_1", "project:proj_1", "project:proj_1"]);
  } finally {
    env.cleanup();
  }
});

test("a run acts while its conversation has room; past it every tool but write_brief is refused", async () => {
  const t = setup();
  try {
    const first = await t.memory.remember({ scope: "user", type: "preference", source: "agent", content: "One-off: the build broke on Tuesday." });
    const second = await t.memory.remember({ scope: "user", type: "preference", source: "agent", content: "One-off: the deploy waited for review." });
    // A threshold of 1250 leaves room for 1000 (1250 less a fifth).
    const { model, dreamer } = t.dreamer([
      { ...step({ toolName: "apply_action", args: { type: "archive", memoryId: first.id, reason: "one-off" } }), usage: { promptTokens: 999, completionTokens: 10 } },
      { ...step({ toolName: "apply_action", args: { type: "archive", memoryId: second.id, reason: "one-off" } }, { toolName: "search_memory", args: { query: "deploy" } }), usage: { promptTokens: 1000, completionTokens: 10 } },
      { ...step({ toolName: "write_brief", args: { content: "The user's memory.\n- Nothing lasting yet." } }), usage: { promptTokens: 1100, completionTokens: 10 } }
    ], { contextLimitTokens: 1250 });
    const result = await dreamer.run("manual", { kind: "user" });
    expect(result).toMatchObject({ status: "succeeded", appliedCount: 1 });
    expect((await t.memory.get(first.id))?.status).toBe("archived");
    expect((await t.memory.get(second.id))?.status).toBe("available");
    // The second step's two calls, the last results the third step read.
    const refused = t.toolResults(model, 2).slice(-2).map((r) => [r.toolName, r.output.value]);
    expect(refused).toEqual([
      ["apply_action", { status: "rejected", error: "This run's room is used up: write the brief now." }],
      ["search_memory", { status: "rejected", error: "This run's room is used up: write the brief now." }]
    ]);
    // The run's step log keeps the refused calls too.
    const row = t.env.store.db.prepare("select metadata_json from memory_dream_runs where id = ?").get(result.runId) as { metadata_json: string };
    const logged = (JSON.parse(row.metadata_json).steps as Array<{ step: number; tools: Array<{ name: string; status?: string }> }>)
      .find((s) => s.step === 2)?.tools.map((x) => [x.name, x.status]);
    expect(logged).toEqual([["apply_action", "rejected"], ["search_memory", "rejected"]]);
    expect(t.memory.getBrief("user", null)?.content).toBe("The user's memory.\n- Nothing lasting yet.");
    // The opening names the room.
    expect(JSON.stringify(model.streamCalls[0]?.prompt)).toContain("This run has room until its conversation reaches about 1000 tokens");
  } finally {
    t.env.cleanup();
  }
});

test("a run's room is the threshold less the smaller of 30000 tokens and a fifth of it", () => {
  expect([400_000, 200_000, 100_000, 50_000, 1250].map(dreamRoomTokens)).toEqual([370_000, 170_000, 80_000, 40_000, 1000]);
});

// A project run's opening shows the recent work it is given, in order, after
// the memories; with none, no section.
test("the opening lists the recent work it is given, read-only, after the memories", () => {
  const rule: MemoryEntry = {
    id: "mem_rule", scope: "project", projectId: "proj_1", featureId: null, type: "knowledge", source: "agent", userQuote: null,
    content: "A rule.", status: "available", sourceThreadId: null, sourceMessageId: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", metadata: null
  };
  const work = [2, 1].map((day) => ({ id: `mem_rec${day}`, featureId: `feat_${day}`, workerName: `worker-${day}`, projectId: "proj_1", updatedAt: `2026-10-0${day}T00:00:00.000Z`, firstLine: `Work of day ${day}` }));
  const opening = buildOpeningMessage({ brief: null, changed: [], archived: [], entries: [rule], userEntries: null, recentWork: work, places: "" });
  expect(opening).toContain("## Recent work in this project (task records, newest first; read-only, not memories)\n- [mem_rec2] 2026-10-02, worker-2: Work of day 2\n- [mem_rec1] 2026-10-01, worker-1: Work of day 1");
  expect(opening.indexOf("## This partition's memories")).toBeLessThan(opening.indexOf("## Recent work"));
  expect(buildOpeningMessage({ brief: null, changed: [], archived: [], entries: [rule], userEntries: null, recentWork: [], places: "" })).not.toContain("## Recent work");
});

// ---- Workers' task records: read-only recent work, not memories ----

function openingOf(model: ReturnType<typeof createMockLLM>): string {
  return String((model.streamCalls[0]?.prompt as Array<{ role: string; content: Array<{ text?: string }> }>)
    .find((m) => m.role === "user")!.content.map((part) => part.text ?? "").join(""));
}

test("a project run's opening lists the 15 newest records as read-only recent work", async () => {
  const t = setup();
  try {
    await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "Releases are tagged from main." });
    let day = 0;
    const records = new FeatureRecordStore(t.env.store.db, () => new Date(Date.UTC(2026, 9, 1 + day++)).toISOString());
    const written = Array.from({ length: 16 }, (_, i) => {
      const featureId = seedFeature(t.env.features, t.project1, { name: `worker-${i}`, tmuxWindowName: `worker-${i}` });
      return { name: `worker-${i}`, record: records.write({ featureId, projectId: t.project1, content: `Shipped part ${i}\nDone: details ${i}`, sourceThreadId: null, metadata: null }).record };
    });
    const run = t.dreamer([step({ toolName: "write_brief", args: { content: "project-1: memory." } })]);
    await run.dreamer.run("manual", { kind: "project", projectId: t.project1 });
    const opening = openingOf(run.model);
    expect(opening).toContain([
      "## Recent work in this project (task records, newest first; read-only, not memories)",
      ...written.slice(1).reverse().map((w) => `- [${w.record.id}] ${w.record.updatedAt.slice(0, 10)}, ${w.name}: Shipped part ${w.name.slice(7)}`)
    ].join("\n"));
    expect(opening).not.toContain(written[0]!.record.id);
    expect(opening).not.toContain("Done: details");
    expect(opening).toContain("## This partition's memories (1; ★ = changed since the brief)");
    expect(opening).toContain("This partition holds 1 memories: 0 preference, 1 knowledge.");
    expect(opening).not.toContain("older task records");
    expect(opening).not.toContain("] task, ");
  } finally {
    t.env.cleanup();
  }
});

test("a user run's opening has no recent-work section", async () => {
  const t = setup();
  try {
    await t.memory.remember({ scope: "user", type: "preference", source: "agent", content: "Prefers short replies." });
    const featureId = seedFeature(t.env.features, t.project1);
    new FeatureRecordStore(t.env.store.db).write({ featureId, projectId: t.project1, content: "Shipped part 1", sourceThreadId: null, metadata: null });
    const run = t.dreamer([step({ toolName: "write_brief", args: { content: "The user's memory." } })]);
    await run.dreamer.run("manual", { kind: "user" });
    expect(openingOf(run.model)).not.toContain("## Recent work");
    expect(openingOf(run.model)).not.toContain("Shipped part 1");
  } finally {
    t.env.cleanup();
  }
});

test("worker activity does not make a project brief stale", async () => {
  const t = setup();
  try {
    await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "Releases are tagged from main." });
    const run = t.dreamer([step({ toolName: "write_brief", args: { content: "project-1: memory." } })]);
    await run.dreamer.run("manual", { kind: "project", projectId: t.project1 });
    const partition = { kind: "project" as const, projectId: t.project1 };
    expect(run.dreamer.needsRun(partition)).toBe(false);
    const records = new FeatureRecordStore(t.env.store.db);
    const featureId = seedFeature(t.env.features, t.project1);
    records.write({ featureId, projectId: t.project1, content: "Started the export", sourceThreadId: null, metadata: null });
    records.write({ featureId, projectId: t.project1, content: "Started the export\nDone: shipped", sourceThreadId: null, metadata: null });
    expect(run.dreamer.needsRun(partition)).toBe(false);
  } finally {
    t.env.cleanup();
  }
});

test("read_entry opens a record of this project whole, not another project's", async () => {
  const t = setup();
  try {
    await t.memory.remember({ scope: "project", projectId: t.project1, type: "knowledge", source: "agent", content: "Releases are tagged from main." });
    const records = new FeatureRecordStore(t.env.store.db);
    const mine = records.write({ featureId: seedFeature(t.env.features, t.project1, { name: "export", tmuxWindowName: "export" }), projectId: t.project1, content: "Export rows\nDone: every step", sourceThreadId: null, metadata: null }).record;
    const project2 = seedProject(t.env.projects, { name: "project-2", tmuxSessionName: "md-project-2" });
    const theirs = records.write({ featureId: seedFeature(t.env.features, project2, { name: "billing", tmuxWindowName: "billing" }), projectId: project2, content: "Billing work", sourceThreadId: null, metadata: null }).record;
    const run = t.dreamer([
      step({ toolName: "read_entry", args: { memoryId: mine.id } }, { toolName: "read_entry", args: { memoryId: theirs.id } }),
      step({ toolName: "write_brief", args: { content: "project-1: memory." } })
    ]);
    await run.dreamer.run("manual", { kind: "project", projectId: t.project1 });
    const results = t.toolResults(run.model, 1);
    expect(results[0]!.output.value).toMatchObject({ record: { id: mine.id, worker: "export", content: "Export rows\nDone: every step" } });
    expect(JSON.stringify(results[1]!.output)).toContain(`memory not in this partition: ${theirs.id}`);
    const tools = (run.model.streamCalls[0]?.tools ?? []) as Array<{ name: string; description?: string }>;
    expect(tools.find((tool) => tool.name === "read_entry")?.description).toBe("Read one memory whole, the memories most like it, the conversation it came from, and what earlier runs did to it. It also opens a task record from the recent work list, whole.");
    expect(tools.find((tool) => tool.name === "search_memory")?.description).toBe("Search this partition's memories for duplicates, contradictions or related entries.");
  } finally {
    t.env.cleanup();
  }
});
