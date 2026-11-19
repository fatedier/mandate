import { describe, expect, test } from "bun:test";
import { arePossibleDuplicates, briefBytes, briefRejection, dreamActionRejection, partitionContains, userStatedAt, type DreamActionInput, type MemoryDreamPartition } from "../src/server/modules/memory/dream-rules.js";
import type { MemoryEntry } from "../src/server/modules/memory/types.js";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

function memory(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "mem_a", scope: "project", projectId: "proj_1", workerId: null, type: "knowledge",
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
  const flaggedWith = ([a, b]: [MemoryEntry, MemoryEntry], vectors: ReadonlyMap<string, Float64Array> | null) =>
    arePossibleDuplicates(a, b, vectors) ? [b.id] : [];
  const english = memory({ id: "mem_a", content: "Keep a second terminal open during long builds." });
  const paraphrase = memory({ id: "mem_b", content: "Before a lengthy compile, set aside one more shell window." });

  test("a close embedding marks two memories whose words share little", () => {
    expect(flaggedWith([english, paraphrase], new Map([["mem_a", at(1)], ["mem_b", at(0.72)]]))).toEqual(["mem_b"]);
  });

  test("below the line, or with no embedding, the words alone decide", () => {
    expect(flaggedWith([english, paraphrase], new Map([["mem_a", at(1)], ["mem_b", at(0.68)]]))).toStrictEqual([]);
    expect(flaggedWith([english, paraphrase], new Map([["mem_a", at(1)]]))).toStrictEqual([]);
    expect(flaggedWith([english, paraphrase], null)).toStrictEqual([]);
    const reworded = memory({ id: "mem_b", content: "Keep a second terminal open during long build runs." });
    expect(flaggedWith([english, reworded], null)).toEqual(["mem_b"]);
  });

  test("memories of any type are compared, but only within one scope and project", () => {
    const vectors = new Map([["mem_a", at(1)], ["mem_b", at(0.9)]]);
    expect(flaggedWith([english, { ...paraphrase, type: "preference" }], vectors)).toEqual(["mem_b"]);
    expect(flaggedWith([english, { ...paraphrase, projectId: "proj_2" }], vectors)).toStrictEqual([]);
    expect(flaggedWith([english, { ...paraphrase, scope: "user", projectId: null }], vectors)).toStrictEqual([]);
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

  test("a brief is measured in UTF-8 bytes, refused only a tenth past its limit, and told how much to cut", () => {
    // A project's limit is 6000 bytes, refused above 6600; the user's 9000, above 9900.
    expect(briefRejection("x".repeat(6600), PROJECT)).toBe("");
    expect(briefRejection("x".repeat(6601), PROJECT)).toBe("6601 bytes, the limit is 6000: cut about 10% of it (to about 6000 bytes) and write it again.");
    // A CJK character is three bytes.
    expect(briefRejection("记".repeat(2200), PROJECT)).toBe("");
    expect(briefRejection("记".repeat(2400), PROJECT)).toBe("7200 bytes, the limit is 6000: cut about 17% of it (to about 6000 bytes) and write it again.");
    expect(briefRejection("x".repeat(9900), { kind: "user" })).toBe("");
    expect(briefRejection("x".repeat(9901), { kind: "user" })).toBe("9901 bytes, the limit is 9000: cut about 10% of it (to about 9000 bytes) and write it again.");
    // However long, the cut leaves something: never "about 100%".
    expect(briefRejection("x".repeat(600_001), PROJECT)).toBe("600001 bytes, the limit is 6000: cut about 99% of it (to about 6000 bytes) and write it again.");
    // Measured as it is kept: without the space around it.
    expect(briefRejection(`  ${"x".repeat(6600)}\n\n`, PROJECT)).toBe("");
    expect(briefRejection("  ", PROJECT)).toBe("the brief is empty");
  });

  test("a brief's size is its UTF-8 bytes as it is kept", () => {
    expect(briefBytes(" a记 \n")).toBe(4);
  });
});
