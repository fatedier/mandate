import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createMockLLM, createScriptedStreamLLM } from "./helpers/mock-llm.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { MemoryDreamer, MemoryDreamJob, MemoryDreamStepError } from "../src/server/modules/memory/dream.js";
import { MemoryManager } from "../src/server/modules/memory/manager.js";
import { AgentLlmCallRecorder } from "../src/server/modules/activity/llm-call-recorder.js";
import { memoryModule } from "../src/server/modules/memory/module.js";
import { initializeMemorySchema } from "../src/server/modules/memory/schema.js";

test("memory schema migrates legacy dream runs with partition columns", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      create table memory_dream_runs (
        id text primary key,
        trigger text not null,
        status text not null,
        provider text not null default '',
        model text not null default '',
        candidate_count integer not null default 0,
        applied_count integer not null default 0,
        error_json text,
        metadata_json text,
        started_at text not null,
        finished_at text
      )
    `);

    initializeMemorySchema(db);

    const columns = db.prepare("pragma table_info(memory_dream_runs)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    for (const name of ["phase", "project_id", "available_count_before", "available_count_after"]) {
      expect(names.has(name)).toBe(true);
    }
  } finally {
    db.close();
  }
});

test("MemoryDreamer archives only through audited dream actions with source context", async () => {
  const env = freshStoresEnv("md-memory-dream-");
  try {
    const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
    const thread = env.agentStore.getOrCreateThread("manager", null);
    const sourceMessage = env.agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "The old pane rule no longer applies; use the new scoped tmux pane helper." }
    });
    const entry = await memory.remember({
      scope: "global",
      kind: "procedural",
      content: "Use the old pane rule for every terminal action.",
      source: "agent_flush",
      sourceThreadId: thread.id,
      sourceMessageId: sourceMessage.id,
      strength: 0.4,
      confidence: 0.45
    });
    await memory.feedback({
      id: entry.id,
      outcome: "wrong",
      note: "The user corrected this procedure.",
      threadId: thread.id,
      wakeId: "wake-1"
    });

    const model = createMockLLM([{
      toolCalls: [{
        toolCallId: "call-archive",
        toolName: "apply_memory_action",
        args: {
          type: "archive",
          memoryId: entry.id,
          reason: "User source context says the old pane rule no longer applies.",
          confidence: 0.9
        }
      }],
      finishReason: "tool-calls"
    }, {
      toolCalls: [{
        toolCallId: "call-finish",
        toolName: "finish_memory_dream",
        args: { summary: "archived obsolete pane rule" }
      }],
      finishReason: "tool-calls"
    }]);
    const dreamer = new MemoryDreamer({
      db: env.store.db,
      memory,
      agentStore: env.agentStore,
      model,
      provider: "openai",
      maxSteps: 2
    });

    const result = await dreamer.run("manual");
    expect(result.appliedCount).toBe(1);
    expect((await memory.get(entry.id))?.status).toBe("archived");

    const action = env.store.db.prepare("select * from memory_dream_actions where memory_id = ?")
      .get(entry.id) as { status: string; action_type: string; source_json: string | null } | null;
    expect(action?.status).toBe("applied");
    expect(action?.action_type).toBe("archive");
    expect(JSON.parse(action?.source_json ?? "{}").sourceMessageIds).toEqual([sourceMessage.id]);
  } finally {
    env.cleanup();
  }
});

test("MemoryDreamer rejects unsafe archive of explicit user memory", async () => {
  const env = freshStoresEnv("md-memory-dream-explicit-");
  try {
    const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
    const entry = await memory.remember({
      scope: "user",
      kind: "preference",
      content: "The user prefers concise Chinese status updates.",
      source: "explicit_user",
      strength: 0.9,
      confidence: 0.95
    });
    const model = createMockLLM([{
      toolCalls: [{
        toolCallId: "call-archive",
        toolName: "apply_memory_action",
        args: {
          type: "archive",
          memoryId: entry.id,
          reason: "Looks old.",
          confidence: 0.95
        }
      }],
      finishReason: "tool-calls"
    }, {
      toolCalls: [{
        toolCallId: "call-finish",
        toolName: "finish_memory_dream",
        args: { summary: "unsafe archive rejected" }
      }],
      finishReason: "tool-calls"
    }]);
    const dreamer = new MemoryDreamer({
      db: env.store.db,
      memory,
      agentStore: env.agentStore,
      model,
      provider: "openai",
      maxSteps: 2
    });

    const result = await dreamer.run("manual");
    expect(result.rejectedCount).toBe(1);
    expect((await memory.get(entry.id))?.status).toBe("available");
    const action = env.store.db.prepare("select status from memory_dream_actions where memory_id = ?")
      .get(entry.id) as { status: string } | null;
    expect(action?.status).toBe("rejected");
  } finally {
    env.cleanup();
  }
});

test("MemoryDreamer merges duplicate memories and audits the decision", async () => {
  const env = freshStoresEnv("md-memory-dream-merge-");
  try {
    const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
    const target = await memory.remember({
      scope: "project",
      projectId: "project-1",
      kind: "procedural",
      content: "Use tmux send-keys when interacting with an existing pane.",
      source: "agent_flush",
      strength: 0.7,
      confidence: 0.8
    });
    const duplicate = await memory.remember({
      scope: "project",
      projectId: "project-1",
      kind: "procedural",
      content: "Use tmux send keys when interacting with existing panes.",
      source: "agent_flush",
      strength: 0.6,
      confidence: 0.75
    });
    const model = createMockLLM([{
      toolCalls: [{
        toolCallId: "call-merge",
        toolName: "apply_memory_action",
        args: {
          type: "merge",
          memoryId: duplicate.id,
          targetMemoryId: target.id,
          reason: "The two procedural memories describe the same tmux pane rule.",
          confidence: 0.88
        }
      }, {
        toolCallId: "call-keep",
        toolName: "apply_memory_action",
        args: {
          type: "keep",
          memoryId: target.id,
          reason: "The target is the clearer wording.",
          confidence: 0.8
        }
      }],
      finishReason: "tool-calls"
    }, {
      toolCalls: [{
        toolCallId: "call-finish",
        toolName: "finish_memory_dream",
        args: { summary: "merged duplicate memory" }
      }],
      finishReason: "tool-calls"
    }]);
    const dreamer = new MemoryDreamer({
      db: env.store.db,
      memory,
      agentStore: env.agentStore,
      model,
      provider: "openai",
      maxSteps: 2
    });

    const result = await dreamer.run("manual", { kind: "project", projectId: "project-1" });
    expect(result.appliedCount).toBe(2);
    expect((await memory.get(duplicate.id))?.status).toBe("archived");
    expect((await memory.get(duplicate.id))?.metadata?.mergedInto).toBe(target.id);
    expect((await memory.get(target.id))?.metadata?.dreamMergedMemoryIds).toEqual([duplicate.id]);
  } finally {
    env.cleanup();
  }
});

test("MemoryDreamer trusts agent-selected merge targets beyond lexical similarity", async () => {
  const env = freshStoresEnv("md-memory-dream-agent-merge-");
  try {
    const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
    const target = await memory.remember({
      scope: "project",
      projectId: "project-1",
      kind: "procedural",
      content: "For frp, prefer real process end to end scenarios over broad mock harness coverage.",
      source: "agent_flush",
      strength: 0.7,
      confidence: 0.8
    });
    const duplicate = await memory.remember({
      scope: "project",
      projectId: "project-1",
      kind: "procedural",
      content: "Proxy regression checks should launch actual daemons instead of relying on fake network fixtures.",
      source: "agent_flush",
      strength: 0.6,
      confidence: 0.75
    });
    const model = createMockLLM([{
      toolCalls: [{
        toolCallId: "call-merge",
        toolName: "apply_memory_action",
        args: {
          type: "merge",
          memoryId: duplicate.id,
          targetMemoryId: target.id,
          reason: "The agent determined these are the same durable frp testing preference despite different wording.",
          confidence: 0.86
        }
      }],
      finishReason: "tool-calls"
    }, {
      toolCalls: [{
        toolCallId: "call-finish",
        toolName: "finish_memory_dream",
        args: { summary: "trusted semantic merge" }
      }],
      finishReason: "tool-calls"
    }]);
    const dreamer = new MemoryDreamer({
      db: env.store.db,
      memory,
      agentStore: env.agentStore,
      model,
      provider: "openai",
      maxSteps: 2
    });

    const result = await dreamer.run("manual", { kind: "project", projectId: "project-1" });
    expect(result.appliedCount).toBe(1);
    expect(result.rejectedCount).toBe(0);
    expect((await memory.get(duplicate.id))?.status).toBe("archived");
    expect((await memory.get(duplicate.id))?.metadata?.mergedInto).toBe(target.id);
  } finally {
    env.cleanup();
  }
});

test("MemoryDreamer project partition isolates candidate listing and search", async () => {
  const env = freshStoresEnv("md-memory-dream-project-partition-");
  try {
    const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
    const projectEntry = await memory.remember({
      scope: "project",
      projectId: "project-1",
      kind: "procedural",
      content: "Scoped alpha project rule for deployment checks.",
      source: "agent_flush"
    });
    const featureEntry = await memory.remember({
      scope: "feature",
      projectId: "project-1",
      featureId: "feature-1",
      kind: "procedural",
      content: "Scoped alpha feature rule for deployment checks.",
      source: "agent_flush"
    });
    const otherProjectEntry = await memory.remember({
      scope: "project",
      projectId: "project-2",
      kind: "procedural",
      content: "Scoped alpha foreign project rule for deployment checks.",
      source: "agent_flush"
    });
    const globalEntry = await memory.remember({
      scope: "global",
      kind: "procedural",
      content: "Scoped alpha global rule for deployment checks.",
      source: "agent_flush"
    });
    const model = createMockLLM([{
      toolCalls: [{
        toolCallId: "call-list",
        toolName: "list_memory_candidates",
        args: { limit: 20 }
      }]
    }, {
      toolCalls: [{
        toolCallId: "call-search",
        toolName: "search_memory",
        args: { query: "scoped alpha deployment checks", scope: "all", maxResults: 20 }
      }]
    }, {
      toolCalls: [{
        toolCallId: "call-finish",
        toolName: "finish_memory_dream",
        args: { summary: "project partition checked" }
      }]
    }]);
    const dreamer = new MemoryDreamer({
      db: env.store.db,
      memory,
      agentStore: env.agentStore,
      model,
      provider: "openai",
      maxSteps: 3
    });

    const result = await dreamer.run("manual", { kind: "project", projectId: "project-1" });

    expect(result).toMatchObject({ phase: "project", projectId: "project-1", candidateCount: 2 });
    const listPrompt = JSON.stringify(model.streamCalls[1]?.prompt ?? []);
    expect(listPrompt).toContain(projectEntry.id);
    expect(listPrompt).toContain(featureEntry.id);
    expect(listPrompt).not.toContain(otherProjectEntry.id);
    expect(listPrompt).not.toContain(globalEntry.id);
    const searchPrompt = JSON.stringify(model.streamCalls[2]?.prompt ?? []);
    expect(searchPrompt).toContain(projectEntry.id);
    expect(searchPrompt).toContain(featureEntry.id);
    expect(searchPrompt).not.toContain(otherProjectEntry.id);
    expect(searchPrompt).not.toContain(globalEntry.id);
  } finally {
    env.cleanup();
  }
});

test("MemoryDreamer rejects merges across projects and features", async () => {
  const env = freshStoresEnv("md-memory-dream-merge-boundary-");
  try {
    const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
    const source = await memory.remember({
      scope: "feature",
      projectId: "project-1",
      featureId: "feature-1",
      kind: "procedural",
      content: "Keep feature one deployment checks scoped to feature one.",
      source: "agent_flush"
    });
    const otherFeature = await memory.remember({
      scope: "feature",
      projectId: "project-1",
      featureId: "feature-2",
      kind: "procedural",
      content: "Keep feature two deployment checks scoped to feature two.",
      source: "agent_flush"
    });
    const otherProject = await memory.remember({
      scope: "feature",
      projectId: "project-2",
      featureId: "feature-3",
      kind: "procedural",
      content: "Keep project two deployment checks in project two.",
      source: "agent_flush"
    });
    const model = createMockLLM([{
      toolCalls: [{
        toolCallId: "call-cross-feature",
        toolName: "apply_memory_action",
        args: {
          type: "merge",
          memoryId: source.id,
          targetMemoryId: otherFeature.id,
          reason: "Attempt a cross-feature merge.",
          confidence: 0.9
        }
      }, {
        toolCallId: "call-cross-project",
        toolName: "apply_memory_action",
        args: {
          type: "merge",
          memoryId: source.id,
          targetMemoryId: otherProject.id,
          reason: "Attempt a cross-project merge.",
          confidence: 0.9
        }
      }]
    }, {
      toolCalls: [{
        toolCallId: "call-finish",
        toolName: "finish_memory_dream",
        args: { summary: "unsafe merges rejected" }
      }]
    }]);
    const dreamer = new MemoryDreamer({
      db: env.store.db,
      memory,
      agentStore: env.agentStore,
      model,
      provider: "openai",
      maxSteps: 2
    });

    const result = await dreamer.run("manual", { kind: "project", projectId: "project-1" });

    expect(result.rejectedCount).toBe(2);
    expect((await memory.get(source.id))?.status).toBe("available");
    expect((await memory.get(otherFeature.id))?.status).toBe("available");
    expect((await memory.get(otherProject.id))?.status).toBe("available");
  } finally {
    env.cleanup();
  }
});

test("MemoryDreamer allows feature to project promotion but rejects project to global rescope", async () => {
  const env = freshStoresEnv("md-memory-dream-rescope-boundary-");
  try {
    const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
    const featureEntry = await memory.remember({
      scope: "feature",
      projectId: "project-1",
      featureId: "feature-1",
      kind: "procedural",
      content: "Promote this reusable feature procedure to its project.",
      source: "agent_flush"
    });
    const projectEntry = await memory.remember({
      scope: "project",
      projectId: "project-1",
      kind: "semantic",
      content: "Keep this project fact inside its project.",
      source: "agent_flush"
    });
    const model = createMockLLM([{
      toolCalls: [{
        toolCallId: "call-promote-feature",
        toolName: "apply_memory_action",
        args: {
          type: "rescope",
          memoryId: featureEntry.id,
          reason: "This procedure applies throughout the same project.",
          confidence: 0.85,
          patch: { scope: "project" }
        }
      }, {
        toolCallId: "call-promote-global",
        toolName: "apply_memory_action",
        args: {
          type: "rescope",
          memoryId: projectEntry.id,
          reason: "Attempt to move a project fact into global memory.",
          confidence: 0.9,
          patch: { scope: "global" }
        }
      }]
    }, {
      toolCalls: [{
        toolCallId: "call-finish",
        toolName: "finish_memory_dream",
        args: { summary: "rescope boundaries checked" }
      }]
    }]);
    const dreamer = new MemoryDreamer({
      db: env.store.db,
      memory,
      agentStore: env.agentStore,
      model,
      provider: "openai",
      maxSteps: 2
    });

    const result = await dreamer.run("manual", { kind: "project", projectId: "project-1" });

    expect(result.appliedCount).toBe(1);
    expect(result.rejectedCount).toBe(1);
    expect(await memory.get(featureEntry.id)).toMatchObject({
      scope: "project",
      projectId: "project-1",
      featureId: null
    });
    expect(await memory.get(projectEntry.id)).toMatchObject({
      scope: "project",
      projectId: "project-1"
    });
  } finally {
    env.cleanup();
  }
});

test("MemoryDreamer records agent LLM steps independently from rejected actions", async () => {
  const env = freshStoresEnv("md-memory-dream-parse-");
  try {
    const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
    const entry = await memory.remember({
      scope: "global",
      kind: "procedural",
      content: "Review this memory during dream maintenance.",
      source: "explicit_user",
      strength: 0.4,
      confidence: 0.45
    });
    const model = createMockLLM([{
      toolCalls: [{
        toolCallId: "call-reject-archive",
        toolName: "apply_memory_action",
        args: {
          type: "archive",
          memoryId: entry.id,
          reason: "One weak memory with no source context should be removed.",
          confidence: 0.7
        }
      }],
      finishReason: "tool-calls"
    }, {
      text: "No more useful maintenance."
    }]);
    const recorder = new AgentLlmCallRecorder({
      store: env.store,
      logRequests: "full",
      provider: "openai",
      model: "mock",
      baseURL: "",
      apiMode: "generateText"
    });
    const dreamer = new MemoryDreamer({
      db: env.store.db,
      memory,
      agentStore: env.agentStore,
      model,
      provider: "openai",
      recorder,
      maxSteps: 2
    });

    const result = await dreamer.run("manual");
    expect(result.rejectedCount).toBe(1);

    const calls = env.store.listLlmCalls(10, { purpose: "memory_dream" });
    expect(calls.length).toBe(2);
    expect(calls.every((call) => call.status === "succeeded")).toBe(true);
    expect(calls.every((call) => call.request !== null)).toBe(true);
    expect((calls.find((call) => (call.output as any)?.toolCalls?.length)?.output as any)?.toolCalls[0].toolName)
      .toBe("apply_memory_action");

    const run = env.store.db.prepare("select status, applied_count, metadata_json from memory_dream_runs order by started_at desc limit 1")
      .get() as { status: string; applied_count: number; metadata_json: string };
    expect(run.status).toBe("succeeded");
    expect(run.applied_count).toBe(0);
    expect(JSON.parse(run.metadata_json).rejectedCount).toBe(1);
  } finally {
    env.cleanup();
  }
});

test("MemoryDreamer considers up to 100 candidates by default", async () => {
  const env = freshStoresEnv("md-memory-dream-candidate-limit-");
  try {
    const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
    for (let i = 0; i < 110; i += 1) {
      await memory.remember({
        scope: "global",
        kind: "semantic",
        content: `Candidate memory ${i} with distinct durable context.`,
        source: "agent_flush",
        strength: 0.5,
        confidence: 0.7
      });
    }
    const model = createMockLLM([
      { text: "No useful maintenance this run." },
      { text: "No useful maintenance this run." }
    ]);
    const dreamer = new MemoryDreamer({
      db: env.store.db,
      memory,
      agentStore: env.agentStore,
      model,
      provider: "openai",
      maxSteps: 1
    });

    const result = await dreamer.run("manual");

    expect(result.candidateCount).toBe(100);
  } finally {
    env.cleanup();
  }
});

test("MemoryDreamer cools down recently reviewed memories until they receive new activity", async () => {
  const env = freshStoresEnv("md-memory-dream-review-cooldown-");
  try {
    const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
    const reviewed = await memory.remember({
      scope: "global",
      kind: "semantic",
      content: "A recently reviewed memory that should cool down.",
      source: "agent_flush"
    });
    await memory.remember({
      scope: "global",
      kind: "procedural",
      content: "A new memory that still needs its first review.",
      source: "agent_flush"
    });
    const reviewedAt = new Date(Date.now() - 60_000).toISOString();
    env.store.db.prepare(`
      update memory_entries
      set metadata_json = ?, updated_at = ?
      where id = ?
    `).run(JSON.stringify({ dreamLastReviewedAt: reviewedAt }), reviewedAt, reviewed.id);

    const model = createMockLLM([
      { text: "No useful maintenance this run." },
      { text: "No useful maintenance this run." }
    ]);
    const dreamer = new MemoryDreamer({
      db: env.store.db,
      memory,
      agentStore: env.agentStore,
      model,
      provider: "openai",
      maxSteps: 1
    });

    expect((await dreamer.run("manual")).candidateCount).toBe(1);
    await memory.feedback({
      id: reviewed.id,
      outcome: "wrong",
      note: "New evidence arrived after the review."
    });
    expect((await dreamer.run("manual")).candidateCount).toBe(2);
  } finally {
    env.cleanup();
  }
});

test("MemoryDreamer reserves candidate capacity for memories never reviewed", async () => {
  const env = freshStoresEnv("md-memory-dream-unreviewed-reserve-");
  try {
    const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
    const unreviewedIds: string[] = [];
    const reviewedIds: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const entry = await memory.remember({
        scope: "global",
        kind: "semantic",
        content: `Unreviewed candidate ${i} with unique context alpha ${i}.`,
        source: "agent_flush"
      });
      unreviewedIds.push(entry.id);
      const createdAt = new Date(Date.now() - (10 - i) * 60_000).toISOString();
      env.store.db.prepare(`
        update memory_entries set created_at = ?, updated_at = ? where id = ?
      `).run(createdAt, createdAt, entry.id);
    }
    const oldReview = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    for (let i = 0; i < 10; i += 1) {
      const entry = await memory.remember({
        scope: "global",
        kind: "procedural",
        content: `Reviewed high-score candidate ${i} with unique context beta ${i}.`,
        source: "agent_flush"
      });
      reviewedIds.push(entry.id);
      env.store.db.prepare(`
        update memory_entries
        set metadata_json = ?, recall_count = 10, use_count = 0, updated_at = ?
        where id = ?
      `).run(JSON.stringify({ dreamLastReviewedAt: oldReview }), oldReview, entry.id);
    }
    const model = createMockLLM([{
      toolCalls: [{
        toolCallId: "call-list",
        toolName: "list_memory_candidates",
        args: { limit: 10 }
      }]
    }, {
      toolCalls: [{
        toolCallId: "call-finish",
        toolName: "finish_memory_dream",
        args: { summary: "candidate priority checked" }
      }]
    }]);
    const dreamer = new MemoryDreamer({
      db: env.store.db,
      memory,
      agentStore: env.agentStore,
      model,
      provider: "openai",
      maxCandidates: 10,
      maxSteps: 2
    });

    await dreamer.run("manual");

    const prompt = model.streamCalls[1]?.prompt as Array<{ content?: unknown }>;
    const parts = prompt
      .flatMap((message) => Array.isArray(message.content) ? message.content : []) as Array<{
        type?: string;
        toolName?: string;
        output?: { value?: { candidates?: Array<{ id: string }> } };
      }>;
    const toolResult = parts.find(
      (part) => part.type === "tool-result" && part.toolName === "list_memory_candidates"
    );
    const listedIds = (toolResult?.output?.value?.candidates ?? [])
      .map((candidate: { id: string }) => candidate.id);
    expect(listedIds.filter((id: string) => unreviewedIds.includes(id))).toHaveLength(4);
    expect(listedIds.filter((id: string) => reviewedIds.includes(id))).toHaveLength(6);
    expect(listedIds.slice(0, 4)).toEqual(unreviewedIds.slice(0, 4));
  } finally {
    env.cleanup();
  }
});

test("MemoryDreamer falls back to the next provider when a dream step times out", async () => {
  const env = freshStoresEnv("md-memory-dream-fallback-");
  try {
    const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
    await memory.remember({
      scope: "global",
      kind: "procedural",
      content: "Review this memory during dream maintenance.",
      source: "agent_flush",
      strength: 0.4,
      confidence: 0.45
    });
    const primary = createScriptedStreamLLM([
      [{ type: "controller-error", error: new Error("The operation timed out.") }]
    ]);
    const fallback = createMockLLM([{ text: "No useful maintenance this run." }]);
    const primaryRecorder = new AgentLlmCallRecorder({
      store: env.store,
      logRequests: "metadata",
      provider: "codex",
      model: "gpt-5.5",
      baseURL: "",
      apiMode: "streamText"
    });
    const fallbackRecorder = new AgentLlmCallRecorder({
      store: env.store,
      logRequests: "metadata",
      provider: "openai-compatible",
      model: "anthropic/claude-sonnet-4.5",
      baseURL: "https://proxy.example/v1",
      apiMode: "streamText"
    });
    const dreamer = new MemoryDreamer({
      db: env.store.db,
      memory,
      agentStore: env.agentStore,
      model: primary,
      provider: "codex",
      modelName: "gpt-5.5",
      candidates: [
        {
          model: primary,
          provider: "codex",
          modelName: "gpt-5.5",
          recorder: primaryRecorder
        },
        {
          model: fallback,
          provider: "openai-compatible",
          modelName: "anthropic/claude-sonnet-4.5",
          baseURL: "https://proxy.example/v1",
          recorder: fallbackRecorder
        }
      ],
      maxSteps: 1
    });

    const result = await dreamer.run("manual");
    expect(result.processed).toBe(true);
    expect(primary.callsMade).toBe(1);
    expect(fallback.callsMade).toBe(1);

    const calls = env.store.db.prepare(`
      select provider, model, status, metadata_json, error_json
      from llm_calls
      where purpose = 'memory_dream'
      order by rowid
    `).all() as Array<{
      provider: string;
      model: string;
      status: string;
      metadata_json: string | null;
      error_json: string | null;
    }>;
    expect(calls.map((call) => [call.provider, call.model, call.status])).toEqual([
      ["codex", "gpt-5.5", "failed"],
      ["openai-compatible", "anthropic/claude-sonnet-4.5", "succeeded"]
    ]);
    expect(JSON.parse(calls[1]!.metadata_json ?? "{}")).toMatchObject({
      fallbackAttempt: true,
      candidateIndex: 1,
      attempt: 1,
      provider: "openai-compatible",
      model: "anthropic/claude-sonnet-4.5"
    });

    const run = env.store.db.prepare("select status, provider, model from memory_dream_runs order by started_at desc limit 1")
      .get() as { status: string; provider: string; model: string };
    expect(run).toEqual({ status: "succeeded", provider: "codex", model: "gpt-5.5" });
  } finally {
    env.cleanup();
  }
});

test("MemoryDreamStepError includes timeout cause and step context", () => {
  const error = new MemoryDreamStepError({
    cause: new Error("The operation timed out.", {
      cause: new DOMException("The operation timed out.", "TimeoutError")
    }),
    runId: "drm_timeout",
    trigger: "idle",
    step: 18,
    maxSteps: 100,
    latencyMs: 240876
  });

  expect(error.name).toBe("MemoryDreamStepError");
  expect(error.message).toBe(
    "memory dream step 18/100 failed after 240876ms: The operation timed out. (TimeoutError code=23)"
  );
  expect(error.runId).toBe("drm_timeout");
  expect(error.step).toBe(18);
});

test("MemoryDreamJob waits for one hour after human input and at least twelve hours between runs", () => {
  const env = freshStoresEnv("md-memory-dream-job-");
  try {
    const now = Date.parse("2026-05-12T00:00:00.000Z");
    let currentNow = now;
    const job = new MemoryDreamJob({
      db: env.store.db,
      dreamer: { async run() { throw new Error("not expected"); } },
      now: () => currentNow,
      idleMs: 60 * 60 * 1000,
      minIntervalMs: 12 * 60 * 60 * 1000
    });
    expect(job.eligibility()).toEqual({ ok: false, reason: "not_idle_long_enough" });
    currentNow = now + 61 * 60 * 1000;
    expect(job.eligibility()).toEqual({ ok: true });

    const thread = env.agentStore.getOrCreateThread("manager", null);
    const backgroundMessage = env.agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "watch",
      content: { type: "text", text: "recent watch activity" }
    });
    env.store.db.prepare("update agent_messages set created_at = ? where id = ?")
      .run(new Date(currentNow - 5 * 60 * 1000).toISOString(), backgroundMessage.id);
    env.agentStore.createWake({
      threadId: thread.id,
      reason: "user",
      triggerMessageId: backgroundMessage.id
    });
    env.store.db.prepare(`
      insert into llm_calls (
        id, purpose, scope_type, scope_id, status, started_at, created_at, updated_at
      )
      values ('llm-recent-background', 'agent_wake_step', 'agent_thread', 'thr-1', 'succeeded', ?, ?, ?)
    `).run(
      new Date(currentNow - 5 * 60 * 1000).toISOString(),
      new Date(currentNow - 5 * 60 * 1000).toISOString(),
      new Date(currentNow - 5 * 60 * 1000).toISOString()
    );
    expect(job.eligibility()).toEqual({ ok: true });

    const message = env.agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "recent activity" }
    });
    env.store.db.prepare("update agent_messages set created_at = ? where id = ?")
      .run(new Date(currentNow - 30 * 60 * 1000).toISOString(), message.id);
    expect(job.eligibility()).toEqual({ ok: false, reason: "not_idle_long_enough" });

    env.store.db.prepare("update agent_messages set created_at = ? where id = ?")
      .run(new Date(currentNow - 2 * 60 * 60 * 1000).toISOString(), message.id);
    expect(job.eligibility()).toEqual({ ok: true });

    const voiceMessage = env.agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "voice",
      content: { type: "text", text: "recent voice activity" }
    });
    env.store.db.prepare("update agent_messages set created_at = ? where id = ?")
      .run(new Date(currentNow - 30 * 60 * 1000).toISOString(), voiceMessage.id);
    expect(job.eligibility()).toEqual({ ok: false, reason: "not_idle_long_enough" });

    env.store.db.prepare("update agent_messages set created_at = ? where id = ?")
      .run(new Date(currentNow - 2 * 60 * 60 * 1000).toISOString(), voiceMessage.id);
    expect(job.eligibility()).toEqual({ ok: true });

    env.store.db.prepare(`
      insert into memory_dream_runs (id, trigger, status, candidate_count, applied_count, started_at, finished_at)
      values ('run-recent', 'idle', 'succeeded', 1, 1, ?, ?)
    `).run(
      new Date(currentNow - 2 * 60 * 60 * 1000).toISOString(),
      new Date(currentNow - 2 * 60 * 60 * 1000).toISOString()
    );
    expect(job.eligibility()).toEqual({ ok: false, reason: "dream_interval_not_elapsed" });
    currentNow = now + 13 * 60 * 60 * 1000;
    expect(job.eligibility()).toEqual({ ok: true });
  } finally {
    env.cleanup();
  }
});

test("MemoryDreamJob reports an empty batch as skipped", async () => {
  const env = freshStoresEnv("md-memory-dream-empty-batch-");
  try {
    const model = createMockLLM([]);
    const dreamer = new MemoryDreamer({
      db: env.store.db,
      memory: new MemoryManager(new LocalMemoryProvider(env.store.db)),
      agentStore: env.agentStore,
      model,
      provider: "openai",
      maxSteps: 1
    });
    const job = new MemoryDreamJob({ db: env.store.db, dreamer });

    const result = await job.tick("idle", { force: true });

    expect(result).toMatchObject({
      phase: "global",
      processed: false,
      candidateCount: 0
    });
  } finally {
    env.cleanup();
  }
});

test("MemoryDreamJob processes every project before one global run", async () => {
  const env = freshStoresEnv("md-memory-dream-rotation-");
  try {
    const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
    const projects = ["project-older", "project-middle", "project-newer"];
    for (const [index, projectId] of projects.entries()) {
      const entry = await memory.remember({
        scope: "project",
        projectId,
        kind: "procedural",
        content: `Review the ${projectId} deployment procedure.`,
        source: "agent_flush"
      });
      const createdAt = new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 60_000).toISOString();
      env.store.db.prepare("update memory_entries set created_at = ? where id = ?").run(createdAt, entry.id);
    }
    await memory.remember({
      scope: "global",
      kind: "semantic",
      content: "Review the global deployment convention.",
      source: "agent_flush"
    });
    const model = createMockLLM([
      { text: "No useful maintenance this run." },
      { text: "No useful maintenance this run." },
      { text: "No useful maintenance this run." },
      { text: "No useful maintenance this run." }
    ]);
    const dreamer = new MemoryDreamer({
      db: env.store.db,
      memory,
      agentStore: env.agentStore,
      model,
      provider: "openai",
      maxSteps: 1
    });
    const job = new MemoryDreamJob({
      db: env.store.db,
      dreamer,
      now: () => Date.parse("2026-07-23T00:00:00.000Z")
    });

    const result = await job.tick("idle", { force: true });

    expect("partitions" in result ? result.partitions?.map((partition) => partition.phase) : [])
      .toEqual(["project", "project", "project", "global"]);
    expect("partitions" in result ? result.partitions?.slice(0, 3).map((partition) => partition.projectId) : [])
      .toEqual(projects);
    expect("runCount" in result ? result.runCount : null).toBe(4);
    expect("candidateCount" in result ? result.candidateCount : null).toBe(4);
  } finally {
    env.cleanup();
  }
});

test("MemoryDreamJob selects the project with the oldest unreviewed memory first", async () => {
  const env = freshStoresEnv("md-memory-dream-project-priority-");
  try {
    const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
    const newer = await memory.remember({
      scope: "project",
      projectId: "project-newer",
      kind: "semantic",
      content: "Newer unreviewed project memory.",
      source: "agent_flush"
    });
    const older = await memory.remember({
      scope: "project",
      projectId: "project-older",
      kind: "semantic",
      content: "Older unreviewed project memory.",
      source: "agent_flush"
    });
    env.store.db.prepare("update memory_entries set created_at = ? where id = ?")
      .run("2026-01-02T00:00:00.000Z", newer.id);
    env.store.db.prepare("update memory_entries set created_at = ? where id = ?")
      .run("2026-01-01T00:00:00.000Z", older.id);
    const model = createMockLLM([
      { text: "No useful maintenance this run." },
      { text: "No useful maintenance this run." }
    ]);
    const dreamer = new MemoryDreamer({
      db: env.store.db,
      memory,
      agentStore: env.agentStore,
      model,
      provider: "openai",
      maxSteps: 1
    });
    const job = new MemoryDreamJob({ db: env.store.db, dreamer });

    const result = await job.tick("idle", { force: true });

    expect("partitions" in result ? result.partitions?.[0]?.projectId : null).toBe("project-older");
  } finally {
    env.cleanup();
  }
});

test("memory dream routes list runs, show actions, and force a manual run", async () => {
  const env = freshStoresEnv("md-memory-dream-routes-");
  try {
    const projectId = env.projects.insert({
      name: "Dream Project",
      workingDir: "/tmp/dream-project",
      isGit: false,
      gitRemote: null,
      tmuxSessionName: "md-dream-project",
      ownership: "app"
    });
    env.store.db.prepare(`
      insert into memory_dream_runs (
        id, trigger, status, provider, model, phase, project_id, candidate_count,
        applied_count, metadata_json, started_at, finished_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "drm-route",
      "idle",
      "succeeded",
      "codex",
      "gpt-5.5",
      "project",
      projectId,
      3,
      1,
      JSON.stringify({ actionCount: 2, rejectedCount: 1, failedCount: 0, finishReason: "finished" }),
      "2026-05-20T00:00:00.000Z",
      "2026-05-20T00:01:00.000Z"
    );
    env.store.db.prepare(`
      insert into memory_dream_actions (
        id, run_id, action_type, status, memory_id, reason, confidence,
        before_json, after_json, created_at, applied_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "dma-route",
      "drm-route",
      "keep",
      "applied",
      "mem-route",
      "Reviewed and kept.",
      0.7,
      JSON.stringify({ id: "mem-route", content: "before" }),
      JSON.stringify({ id: "mem-route", content: "after" }),
      "2026-05-20T00:00:30.000Z",
      "2026-05-20T00:00:30.000Z"
    );

    let manualCall: { trigger: string; force?: boolean } | null = null;
    const app = new Hono();
    memoryModule.mountRoutes?.(app, {
      deps: {
        store: env.store,
        memoryDreamJob: () => ({
          tick: async (trigger: string, options?: { force?: boolean }) => {
            manualCall = { trigger, force: options?.force };
            return {
              runId: "drm-manual",
              trigger,
              processed: true,
              candidateCount: 0,
              actionCount: 0,
              appliedCount: 0,
              rejectedCount: 0,
              failedCount: 0
            };
          }
        })
      } as any,
      upgradeWebSocket: null as any
    });

    const listRes = await app.request("/api/memory/dream/runs?limit=5");
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as {
      runs: Array<{
        id: string;
        phase: string;
        projectId: string | null;
        projectName: string | null;
        actionCount: number;
        rejectedCount: number;
        actionCounts: { keep: number; update: number; merge: number; archive: number; rescope: number };
      }>;
    };
    expect(listBody.runs[0]).toMatchObject({
      id: "drm-route",
      phase: "project",
      projectId,
      projectName: "Dream Project",
      actionCount: 2,
      rejectedCount: 1,
      actionCounts: { keep: 1, update: 0, merge: 0, archive: 0, rescope: 0 }
    });

    const detailRes = await app.request("/api/memory/dream/runs/drm-route");
    expect(detailRes.status).toBe(200);
    const detailBody = await detailRes.json() as { actions: Array<{ id: string; before: { content: string } }> };
    expect(detailBody.actions[0]?.id).toBe("dma-route");
    expect(detailBody.actions[0]?.before.content).toBe("before");

    const manualRes = await app.request("/api/memory/dream/runs", { method: "POST" });
    expect(manualRes.status).toBe(200);
    expect(manualCall).toEqual({ trigger: "manual", force: true });
    const manualBody = await manualRes.json() as { ok: true; result: { runId: string } };
    expect(manualBody.result.runId).toBe("drm-manual");
  } finally {
    env.cleanup();
  }
});
