import { describe, expect, test } from "bun:test";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { MemoryManager } from "../src/server/modules/memory/manager.js";
import { extractNewChatMemories } from "../src/server/modules/memory/extraction.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { freshStoresEnv } from "./helpers/fixtures.js";

async function seeded() {
  const env = freshStoresEnv("md-recall-");
  const provider = new LocalMemoryProvider(env.store.db);
  const entry = await provider.remember({
    scope: "global",
    kind: "semantic",
    content: "frp Issue #5418 could not be reproduced on v0.69.1 or v0.70.0.",
    source: "manual"
  });
  return { env, provider, id: entry.id };
}

const recallCountOf = async (provider: LocalMemoryProvider, id: string) =>
  (await provider.get(id))?.recallCount ?? -1;

/**
 * `recallCount` drives the dream's `recalled_without_use` signal, so what
 * increments it decides what maintenance goes after. It has to mean "an agent
 * asked for this memory", not "some code touched the table".
 */
describe("what counts as a recall", () => {
  test("an ordinary search records one", async () => {
    const { env, provider, id } = await seeded();
    try {
      await provider.search({ query: "5418", maxResults: 5 });
      expect(await recallCountOf(provider, id)).toBe(1);
    } finally {
      env.cleanup();
    }
  });

  test("a lookup that opts out records none", async () => {
    const { env, provider, id } = await seeded();
    try {
      await provider.search({ query: "5418", maxResults: 5, recordRecall: false });
      expect(await recallCountOf(provider, id)).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  test("opting out leaves lastRecalledAt alone too", async () => {
    // The dream's cooldown reads lastRecalledAt to decide whether a memory has
    // been touched since its last review; a dedup lookup must not thaw it.
    const { env, provider, id } = await seeded();
    try {
      await provider.search({ query: "5418", maxResults: 5, recordRecall: false });
      expect((await provider.get(id))?.lastRecalledAt).toBeNull();
    } finally {
      env.cleanup();
    }
  });

  test("the default is still to record, so no caller silently stops counting", async () => {
    const { env, provider, id } = await seeded();
    try {
      await provider.search({ query: "5418", maxResults: 5 });
      await provider.search({ query: "5418", maxResults: 5 });
      expect(await recallCountOf(provider, id)).toBe(2);
    } finally {
      env.cleanup();
    }
  });

  test("a search that matches nothing records nothing", async () => {
    const { env, provider, id } = await seeded();
    try {
      await provider.search({ query: "nothing here resembles this", maxResults: 5 });
      expect(await recallCountOf(provider, id)).toBe(0);
    } finally {
      env.cleanup();
    }
  });
});

/**
 * The dedup lookup is the reason this opt-out exists. Every extraction searches
 * stored memories to see whether it is about to write a duplicate, and that
 * search was crediting a recall to whichever memories most resembled the text
 * being written — which is evidence that the topic is active, the opposite of
 * evidence that the memory is dead weight. It fed straight into the dream's
 * `recalled_without_use` score.
 */
test("extraction's dedup check does not credit a recall to what it compares against", async () => {
  const env = freshStoresEnv("md-recall-extract-");
  try {
    const provider = new LocalMemoryProvider(env.store.db);
    const memory = new MemoryManager(provider);
    const existing = await provider.remember({
      scope: "project",
      projectId: "project-1",
      kind: "procedural",
      content: "Before starting a new chat, preserve durable lessons from the conversation.",
      source: "manual"
    });
    expect((await provider.get(existing.id))?.recallCount).toBe(0);

    const model = createMockLLM([{
      text: JSON.stringify({
        memories: [{
          kind: "procedural",
          content: "Before starting a new chat, preserve durable lessons from the conversation.",
          strength: 0.8,
          confidence: 0.9,
          durability: 0.9,
          reason: "duplicate of what is already stored"
        }]
      })
    }]);

    await extractNewChatMemories({
      memory,
      source: {
        scope: "project",
        projectId: "project-1",
        threadId: "thread-1",
        messageIds: ["m1"],
        content: "New chat archive transcript about preserving durable lessons.",
        metadata: { sourceKind: "newChatArchive" }
      } as never,
      model,
      provider: "openai"
    });

    // The extraction ran and compared against it; that comparison is not a recall.
    expect((await provider.get(existing.id))?.recallCount).toBe(0);
    expect((await provider.get(existing.id))?.lastRecalledAt).toBeNull();
  } finally {
    env.cleanup();
  }
});
