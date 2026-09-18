import { expect, test } from "bun:test";
import { createMockLLM } from "./helpers/mock-llm.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { MemoryManager } from "../src/server/modules/memory/manager.js";
import {
  extractFeatureArchiveMemories,
  extractNewChatMemories,
  extractSummaryMemories,
  type MemoryExtractionSource
} from "../src/server/modules/memory/extraction.js";

test("extractNewChatMemories: promotes durable lessons directly to available memory", async () => {
  const env = freshStoresEnv("md-memory-new-chat-extract-");
  try {
    const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
    const source: MemoryExtractionSource = {
      scope: "project",
      projectId: "project-1",
      threadId: "thread-new-chat",
      messageIds: ["message-new-chat-1"],
      content: "New chat archive transcript. User prefers new chat creation to preserve durable lessons before switching conversations.",
      metadata: { sourceKind: "newChatArchive" }
    };
    const model = createMockLLM([{
      text: JSON.stringify({
        memories: [{
          kind: "procedural",
          content: "Before starting a new chat, preserve durable lessons from the conversation.",
          strength: 0.8,
          confidence: 0.9,
          durability: 0.9,
          reason: "new-chat-specific lesson"
        }]
      })
    }]);

    const result = await extractNewChatMemories({
      memory,
      source,
      model,
      provider: "openai"
    });

    expect(result).toEqual({ processed: true, created: 1, merged: 0, rejected: 0 });
    expect(model.callsMade).toBe(1);
    expect(model.streamCalls).toHaveLength(1);
    expect(model.generateCalls).toHaveLength(0);

    const active = await memory.search({
      query: "preserve durable lessons",
      status: "available",
      maxResults: 5
    }, {
      projectId: "project-1",
      threadId: "thread-new-chat"
    });
    expect(active.map((result) => result.entry.content))
      .toContain("Before starting a new chat, preserve durable lessons from the conversation.");
    expect(active[0]?.entry.metadata?.extractionKind).toBe("new_chat");
    expect(active[0]?.entry.sourceThreadId).toBe("thread-new-chat");
    expect(active[0]?.entry.sourceMessageId).toBe("message-new-chat-1");
    expect(active[0]?.entry.metadata?.sourceMessageIds).toEqual(["message-new-chat-1"]);
  } finally {
    env.cleanup();
  }
});

test("extractNewChatMemories: creates no memory when nothing is worth remembering", async () => {
  const env = freshStoresEnv("md-memory-new-chat-extract-empty-");
  try {
    const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
    const source: MemoryExtractionSource = {
      scope: "global",
      threadId: "thread-new-chat",
      content: "New chat archive transcript. Assistant said it would check a temporary CI state.",
      metadata: { sourceKind: "newChatArchive" }
    };
    const model = createMockLLM([{ text: "{\"memories\":[]}" }]);

    const result = await extractNewChatMemories({
      memory,
      source,
      model,
      provider: "openai"
    });

    expect(result).toEqual({ processed: true, created: 0, merged: 0, rejected: 0 });
    expect(model.streamCalls).toHaveLength(1);
    expect(model.generateCalls).toHaveLength(0);
    expect((await memory.search({ query: "temporary CI state", maxResults: 5 })).length).toBe(0);
  } finally {
    env.cleanup();
  }
});

test("extractFeatureArchiveMemories: promotes durable feature-close lessons", async () => {
  const env = freshStoresEnv("md-memory-feature-archive-extract-");
  try {
    const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
    const source: MemoryExtractionSource = {
      scope: "feature",
      projectId: "project-1",
      featureId: "feature-1",
      threadId: "thread-feature-archive",
      messageIds: ["message-feature-archive-1"],
      content: "Feature archive transcript. User decided this project should keep fake-clock tests separate from true e2e tests.",
      metadata: { sourceKind: "featureArchive" }
    };
    const model = createMockLLM([{
      text: JSON.stringify({
        memories: [{
          kind: "preference",
          content: "For this project, keep fake-clock tests separate from true e2e tests.",
          reason: "explicit user preference before feature archive"
        }]
      })
    }]);

    const result = await extractFeatureArchiveMemories({
      memory,
      source,
      model,
      provider: "openai"
    });

    expect(result).toEqual({ processed: true, created: 1, merged: 0, rejected: 0 });
    expect(model.callsMade).toBe(1);
    expect(model.streamCalls).toHaveLength(1);
    expect(model.generateCalls).toHaveLength(0);

    const active = await memory.search({
      query: "fake-clock tests separate true e2e",
      status: "available",
      maxResults: 5
    }, {
      projectId: "project-1",
      featureId: "feature-1",
      threadId: "thread-feature-archive"
    });
    expect(active[0]?.entry.content).toBe("For this project, keep fake-clock tests separate from true e2e tests.");
    expect(active[0]?.entry.metadata?.extractionKind).toBe("feature_archive");
    expect(active[0]?.entry.metadata?.sourceMetadata).toEqual({ sourceKind: "featureArchive" });
  } finally {
    env.cleanup();
  }
});

test("extractSummaryMemories: promotes durable summary facts without source staging", async () => {
  const env = freshStoresEnv("md-memory-summary-extract-");
  try {
    const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
    const source: MemoryExtractionSource = {
      scope: "feature",
      projectId: "project-1",
      featureId: "feature-1",
      threadId: "thread-summary",
      messageIds: ["summary-message"],
      summaryMessageId: "summary-message",
      content: "Compressed conversation summary:\nUser decided that new chat memory extraction should read existing agent messages directly.",
      metadata: { sourceKind: "compressionSummary" }
    };
    const model = createMockLLM([{
      text: JSON.stringify({
        memories: [{
          kind: "semantic",
          content: "New chat memory extraction should run directly from existing agent messages.",
          strength: 0.85,
          confidence: 0.9,
          durability: 0.9,
          reason: "durable design decision from summary"
        }]
      })
    }]);

    const result = await extractSummaryMemories({
      memory,
      source,
      model,
      provider: "openai"
    });

    expect(result).toEqual({ processed: true, created: 1, merged: 0, rejected: 0 });
    expect(model.callsMade).toBe(1);
    expect(model.streamCalls).toHaveLength(1);
    expect(model.generateCalls).toHaveLength(0);

    const active = await memory.search({
      query: "extraction directly existing agent messages",
      status: "available",
      maxResults: 5
    }, {
      projectId: "project-1",
      featureId: "feature-1",
      threadId: "thread-summary"
    });
    expect(active[0]?.entry.content).toBe("New chat memory extraction should run directly from existing agent messages.");
    expect(active[0]?.entry.metadata?.extractionKind).toBe("summary");
    expect(active[0]?.entry.metadata?.sourceSummaryMessageId).toBe("summary-message");
  } finally {
    env.cleanup();
  }
});

test("extractSummaryMemories: caps over-produced memories instead of making memory cheap", async () => {
  const env = freshStoresEnv("md-memory-summary-cap-");
  try {
    const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
    const source: MemoryExtractionSource = {
      scope: "project",
      projectId: "project-1",
      threadId: "thread-summary-cap",
      messageIds: ["summary-message"],
      summaryMessageId: "summary-message",
      content: "Compressed summary with many possible lessons; only the strongest durable memories should survive.",
      metadata: { sourceKind: "compressionSummary" }
    };
    const model = createMockLLM([{
      text: JSON.stringify({
        memories: Array.from({ length: 6 }, (_, index) => ({
          kind: "procedural",
          content: `Durable project lesson ${index + 1} should be remembered only if it is among the strongest.`,
          strength: 0.9 - index * 0.01,
          confidence: 0.9 - index * 0.01,
          durability: 0.9 - index * 0.01,
          reason: "over-produced summary extraction candidate"
        }))
      })
    }]);

    const result = await extractSummaryMemories({
      memory,
      source,
      model,
      provider: "openai"
    });

    expect(result.created + result.merged).toBeLessThanOrEqual(1);
    expect(model.streamCalls).toHaveLength(1);
    expect(model.generateCalls).toHaveLength(0);
    const active = await memory.search({
      query: "Durable project lesson",
      status: "available",
      maxResults: 10
    }, {
      projectId: "project-1",
      threadId: "thread-summary-cap"
    });
    expect(active).toHaveLength(1);
  } finally {
    env.cleanup();
  }
});
