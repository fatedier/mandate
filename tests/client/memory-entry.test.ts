import { describe, expect, test } from "bun:test";
import type { MemoryEntryDto } from "../../src/shared/api-contracts.js";
import {
  entryLocation,
  entryReason,
  usageSummary
} from "../../src/client/routes/memory/memory-entry.js";

let seq = 0;
function entry(over: Partial<MemoryEntryDto> = {}): MemoryEntryDto {
  return {
    id: `mem_${++seq}`,
    scope: "global",
    projectId: null,
    featureId: null,
    kind: "semantic",
    status: "available",
    content: "something",
    strength: 1,
    confidence: 0.9,
    cues: [],
    source: "manual",
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
    lastRecalledAt: null,
    recallCount: 0,
    lastUsedAt: null,
    useCount: 0,
    feedback: {},
    metadata: null,
    ...over
  };
}

describe("entryReason", () => {
  test("reads the extractor's own sentence, and tolerates its absence", () => {
    expect(entryReason(entry({ metadata: { extractionReason: "  stable preference  " } }))).toBe(
      "stable preference"
    );
    expect(entryReason(entry({ metadata: null }))).toBe("");
    expect(entryReason(entry({ metadata: { extractionReason: 42 } }))).toBe("");
  });
});

describe("usageSummary", () => {
  const e = (over: Partial<MemoryEntryDto>) => entry(over);

  test("a used memory reports its use count, not its recalls", () => {
    expect(usageSummary(e({ useCount: 405, recallCount: 211 }), "all")).toEqual({
      text: "used 405×",
      attention: false
    });
  });

  test("recalled-but-never-used is flagged, and keeps its count under its own filter", () => {
    // The count is the whole point and varies from 1 to 300 — it is not the
    // constant the filter guarantees.
    expect(usageSummary(e({ useCount: 0, recallCount: 234 }), "idle")).toEqual({
      text: "234 recalls, never used",
      attention: true
    });
  });

  test("under the never-recalled filter the phrase is dropped as pure repetition", () => {
    expect(usageSummary(e({ useCount: 0, recallCount: 0 }), "untouched")).toBeNull();
  });

  test("but it is kept when the filter does not already guarantee it", () => {
    expect(usageSummary(e({ useCount: 0, recallCount: 0 }), "all")).toEqual({
      text: "never recalled",
      attention: false
    });
  });
});

describe("entryLocation", () => {
  test("joins project and feature names, without repeating the kind", () => {
    expect(
      entryLocation(
        entry({
          kind: "procedural",
          metadata: { sourceMetadata: { projectName: "console", featureName: "uamc-sync" } }
        })
      )
    ).toBe("console / uamc-sync");
  });

  test("falls back to the id rather than claiming a scope you cannot act on", () => {
    expect(entryLocation(entry({ scope: "feature", featureId: "feat_oFYSMaVJVIg" }))).toBe(
      "feat_oFYSMaVJVIg"
    );
  });

  test("resolves a project name the entry never recorded, from the stats map", () => {
    // Only some memories carry projectName in their metadata; the stats
    // endpoint knows every project, so a bare UUID never has to be shown.
    const uuid = "ebf44b48-f36d-4fa4-878f-2313e4134a3e";
    const resolve = (id: string) => (id === uuid ? "frp" : undefined);
    expect(entryLocation(entry({ scope: "project", projectId: uuid }), resolve)).toBe("frp");
  });

  test("the entry's own name wins over the resolver", () => {
    expect(
      entryLocation(
        entry({
          projectId: "p1",
          metadata: { sourceMetadata: { projectName: "recorded" } }
        }),
        () => "resolved"
      )
    ).toBe("recorded");
  });

  test("an unresolvable UUID is shortened rather than crowding out the content", () => {
    const uuid = "568c6a05-0d45-43d2-86fe-ff71c6fe164c";
    expect(entryLocation(entry({ scope: "project", projectId: uuid }))).toBe("568c6a05");
  });

  test("user and global scopes name themselves", () => {
    expect(entryLocation(entry({ scope: "global" }))).toBe("global");
  });
});
