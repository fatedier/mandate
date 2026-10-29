import { describe, expect, test } from "bun:test";
import { briefRejection, similarMemoryMap, dreamActionRejection, partitionContains, userStatedAt, type DreamActionInput, type MemoryDreamPartition } from "../src/server/modules/memory/dream-rules.js";
import type { MemoryEntry } from "../src/server/modules/memory/types.js";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

function memory(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "mem_a", scope: "project", projectId: "proj_1", featureId: null, type: "knowledge",
    source: "agent", userQuote: null, content: "Builds go through the staging pipeline.", status: "available",
    sourceThreadId: null, sourceMessageId: null, createdAt: daysAgo(30), updatedAt: daysAgo(30), metadata: null,
    ...over
  };
}

// What the dream is told may be a duplicate. Of the pairs the dream's
// model merges, few have words alike enough to be
// flagged; the embeddings see many of the others at the 0.70 line.
describe("possible duplicates", () => {
  // Unit vectors in the plane: the cosine against (1, 0) is the first number.
  const at = (cosine: number) => Float64Array.from([cosine, Math.sqrt(1 - cosine * cosine)]);
  const flaggedWith = (entries: MemoryEntry[], vectors: ReadonlyMap<string, Float64Array> | null) =>
    similarMemoryMap(entries, vectors).get("mem_a")?.map((entry) => entry.id) ?? [];
  const english = memory({ id: "mem_a", content: "Keep a second terminal open during long builds." });
  const chinese = memory({ id: "mem_b", content: "开始长时间构建前，另外保留一个独立的终端窗口。" });

  test("a close embedding marks two memories whose words share little", () => {
    expect(flaggedWith([english, chinese], new Map([["mem_a", at(1)], ["mem_b", at(0.72)]]))).toEqual(["mem_b"]);
  });

  test("below the line, or with no embedding, the words alone decide", () => {
    expect(flaggedWith([english, chinese], new Map([["mem_a", at(1)], ["mem_b", at(0.68)]]))).toEqual([]);
    expect(flaggedWith([english, chinese], new Map([["mem_a", at(1)]]))).toEqual([]);
    expect(flaggedWith([english, chinese], null)).toEqual([]);
    const reworded = memory({ id: "mem_b", content: "Keep a second terminal open during long build runs." });
    expect(flaggedWith([english, reworded], null)).toEqual(["mem_b"]);
  });

  test("memories of any type are compared, but only within one scope and project", () => {
    const vectors = new Map([["mem_a", at(1)], ["mem_b", at(0.9)]]);
    expect(flaggedWith([english, { ...chinese, type: "preference" }], vectors)).toEqual(["mem_b"]);
    expect(flaggedWith([english, { ...chinese, projectId: "proj_2" }], vectors)).toEqual([]);
    expect(flaggedWith([english, { ...chinese, scope: "user", projectId: null }], vectors)).toEqual([]);
  });
});

describe("what the dream may do", () => {
  const PROJECT: MemoryDreamPartition = { kind: "project", projectId: "proj_1" };
  const ctx = (entry: MemoryEntry | null, target: MemoryEntry | null = null) =>
    ({ entry, target, partition: PROJECT, activeProjectIds: new Set(["proj_1", "proj_2"]), isRecord: () => false });
  const act = (fields: Partial<DreamActionInput>): DreamActionInput => ({ type: "archive", memoryId: "mem_a", reason: "r", ...fields });
  const said = memory({ id: "mem_a", source: "user", userQuote: "always back up", createdAt: daysAgo(10), updatedAt: daysAgo(10) });
  const newerSaid = memory({ id: "mem_b", source: "user", userQuote: "no backup now", createdAt: daysAgo(1), updatedAt: daysAgo(1) });
  const olderSaid = memory({ id: "mem_b", source: "user", userQuote: "older", createdAt: daysAgo(20), updatedAt: daysAgo(20) });
  const agent = memory({ id: "mem_c", source: "agent" });

  test("only entries of this partition, and never task records", () => {
    expect(dreamActionRejection(act({}), ctx(memory({ projectId: "proj_2" })))).toBe("memory is not an available entry of this partition");
    expect(dreamActionRejection(act({}), ctx(memory({ status: "archived" })))).toBe("memory is not an available entry of this partition");
    // A task record is no memory: an action naming one is refused as history.
    const records = new Set(["mem_rec"]);
    const withRecords = (entry: MemoryEntry | null, target: MemoryEntry | null = null) => ({ ...ctx(entry, target), isRecord: (id: string) => records.has(id) });
    expect(dreamActionRejection(act({ type: "update", memoryId: "mem_rec", content: "x" }), withRecords(null))).toBe("task records are history and cannot be changed");
    expect(dreamActionRejection(act({ type: "merge", targetMemoryId: "mem_rec" }), withRecords(memory(), null))).toBe("task records are history and cannot be changed");
    expect(partitionContains(memory({ scope: "user", projectId: null }), { kind: "user" })).toBe(true);
  });

  // Which of the user's statements holds is the prompt's to say, not a code
  // rule.
  test("a memory the user stated may be merged, rewritten, archived or split like any other", () => {
    expect(dreamActionRejection(act({ type: "archive" }), ctx(said))).toBe("");
    expect(dreamActionRejection(act({ type: "update", content: "x" }), ctx(said))).toBe("");
    expect(dreamActionRejection(act({ type: "split", parts: ["a", "b"] }), ctx(said))).toBe("");
    expect(dreamActionRejection(act({ type: "merge", targetMemoryId: "mem_b" }), ctx(said, olderSaid))).toBe("");
    expect(dreamActionRejection(act({ type: "merge", targetMemoryId: "mem_c" }), ctx(said, agent))).toBe("");
    expect(dreamActionRejection(act({ memoryId: "mem_c", type: "merge", targetMemoryId: "mem_b", content: "new words" }), ctx(agent, newerSaid))).toBe("");
  });

  test("a statement's age, shown to the model, is when the user said it, not when it was last touched", () => {
    expect(userStatedAt(memory({ createdAt: daysAgo(30), updatedAt: daysAgo(0) }))).toBe(daysAgo(30));
    expect(userStatedAt(memory({ createdAt: daysAgo(30), updatedAt: daysAgo(0), metadata: { statedAt: daysAgo(5) } }))).toBe(daysAgo(5));
  });

  test("moves go to the user's memories or an active project, never where the memory already is", () => {
    expect(dreamActionRejection(act({ memoryId: "mem_c", type: "move", scope: "project", projectId: "proj_9" }), ctx(agent))).toBe("move needs an active projectId");
    expect(dreamActionRejection(act({ memoryId: "mem_c", type: "move", scope: "project", projectId: "proj_1" }), ctx(agent))).toBe("the memory is already there");
    expect(dreamActionRejection(act({ memoryId: "mem_c", type: "move", scope: "project", projectId: "proj_2" }), ctx(agent))).toBe("");
  });

  test("a brief over its limit is refused with the numbers", () => {
    const estimate = (text: string) => text.length;
    expect(briefRejection("x".repeat(2000), PROJECT, estimate)).toBe("");
    expect(briefRejection("x".repeat(2001), PROJECT, estimate)).toBe("2001 tokens, the limit is 2000: shorten it");
    expect(briefRejection("x".repeat(3000), { kind: "user" }, estimate)).toBe("");
    expect(briefRejection("x".repeat(3001), { kind: "user" }, estimate)).toBe("3001 tokens, the limit is 3000: shorten it");
    expect(briefRejection("  ", PROJECT, estimate)).toBe("the brief is empty");
  });
});
