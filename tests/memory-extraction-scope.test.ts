import { describe, expect, test } from "bun:test";
import {
  extractFeatureArchiveMemories,
  resolveMemoryPlacement
} from "../src/server/modules/memory/extraction.js";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { MemoryManager } from "../src/server/modules/memory/manager.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { freshStoresEnv } from "./helpers/fixtures.js";

const inFeature = { scope: "feature", projectId: "p1", featureId: "f1" } as const;
const inProject = { scope: "project", projectId: "p1", featureId: null } as const;
const inGlobal = { scope: "global", projectId: null, featureId: null } as const;

/**
 * Scope used to be assigned mechanically from wherever the extraction ran, so
 * work inside a feature stamped every memory `feature`. On a real store that
 * produced 46 feature-scoped memories — issue verdicts, migration outcomes,
 * dependency decisions — recalled 503 times and used zero, because a feature
 * is a one-off task nobody re-enters. The model chooses now; this pins what
 * the system does with that choice.
 */
describe("resolveMemoryPlacement", () => {
  test("a project-level finding learned inside a feature is stored on the project", () => {
    expect(resolveMemoryPlacement(inFeature, "project")).toEqual({
      scope: "project",
      projectId: "p1",
      featureId: null
    });
  });

  test("broadening drops the narrower id, or the memory stays invisible", () => {
    // Keeping featureId would filter a project-scoped memory straight back out
    // of every other feature's prompt — the exact bug being fixed.
    expect(resolveMemoryPlacement(inFeature, "project").featureId).toBeNull();
    expect(resolveMemoryPlacement(inFeature, "user")).toEqual({
      scope: "user",
      projectId: null,
      featureId: null
    });
  });

  test("a genuinely feature-local memory still lands on the feature", () => {
    expect(resolveMemoryPlacement(inFeature, "feature")).toEqual({
      scope: "feature",
      projectId: "p1",
      featureId: "f1"
    });
  });

  test("no choice means the old behaviour, so a silent model changes nothing", () => {
    expect(resolveMemoryPlacement(inFeature, undefined)).toEqual({
      scope: "feature",
      projectId: "p1",
      featureId: "f1"
    });
    expect(resolveMemoryPlacement(inGlobal, undefined)).toEqual({
      scope: "global",
      projectId: null,
      featureId: null
    });
  });

  test("a scope the context cannot reach falls back rather than inventing an id", () => {
    // No feature was involved, so "feature" has no id to attach to.
    expect(resolveMemoryPlacement(inProject, "feature")).toEqual({
      scope: "project",
      projectId: "p1",
      featureId: null
    });
    // No project either.
    expect(resolveMemoryPlacement(inGlobal, "project")).toEqual({
      scope: "global",
      projectId: null,
      featureId: null
    });
  });

  test("user scope is always reachable — a preference belongs to nobody's project", () => {
    expect(resolveMemoryPlacement(inGlobal, "user").scope).toBe("user");
    expect(resolveMemoryPlacement(inProject, "user").scope).toBe("user");
    expect(resolveMemoryPlacement(inFeature, "user").scope).toBe("user");
  });

  test("placement never widens past what produced it", () => {
    // A feature extraction can reach feature/project/user and nothing else;
    // it must never name a project it was not running in.
    for (const chosen of ["feature", "project", "user"] as const) {
      const placed = resolveMemoryPlacement(inFeature, chosen);
      expect(placed.projectId === null || placed.projectId === "p1").toBe(true);
      expect(placed.featureId === null || placed.featureId === "f1").toBe(true);
    }
  });
});

/**
 * The unit tests above pin the placement rule; this one pins that extraction
 * actually applies it. Without it, someone could drop the `scope` field from
 * the candidate on its way to `remember()` and every test above would still
 * pass.
 */
test("extraction stores a memory where the model said it applies", async () => {
  const env = freshStoresEnv("md-extract-scope-");
  try {
    const provider = new LocalMemoryProvider(env.store.db);
    const memory = new MemoryManager(provider);
    const model = createMockLLM([{
      text: JSON.stringify({
        memories: [{
          kind: "semantic",
          scope: "project",
          content: "frp Issue #5418 could not be reproduced on v0.69.1, v0.70.0, or dev.",
          reason: "a verdict about the project, learned while working in one feature"
        }]
      })
    }]);

    await extractFeatureArchiveMemories({
      memory,
      source: {
        scope: "feature",
        projectId: "project-1",
        featureId: "feature-1",
        threadId: "thread-1",
        messageIds: ["m1"],
        content: "Feature archive transcript investigating frp issue 5418.",
        metadata: { sourceKind: "featureArchive" }
      } as never,
      model,
      provider: "openai"
    });

    // Visible from anywhere in the project — including other features, which
    // is the whole point.
    const found = await memory.search(
      { query: "5418", status: "available", maxResults: 5 },
      { projectId: "project-1", featureId: "some-other-feature" }
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.entry.scope).toBe("project");
    expect(found[0]?.entry.featureId).toBeNull();
  } finally {
    env.cleanup();
  }
});
