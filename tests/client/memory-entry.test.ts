import { describe, expect, test } from "bun:test";
import type { MemoryEntryDto } from "../../src/shared/api-contracts.js";
import {
  entryFacets,
  entryLocation,
  entryReason,
  previewText
} from "../../src/client/routes/memory/memory-entry.js";

let seq = 0;
function entry(over: Partial<MemoryEntryDto> = {}): MemoryEntryDto {
  return {
    id: `mem_${++seq}`,
    scope: "user",
    projectId: null,
    featureId: null,
    type: "knowledge",
    status: "available",
    content: "something",
    source: "agent",
    userQuote: null,
    sourceThreadId: null,
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
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

describe("entryLocation", () => {
  test("joins project and feature names, without repeating the type", () => {
    expect(
      entryLocation(
        entry({
          type: "preference",
          scope: "project",
          projectId: "p1",
          featureId: "feat_1",
          metadata: { sourceMetadata: { projectName: "console", featureName: "token-sync" } }
        })
      )
    ).toBe("console / token-sync");
  });

  test("falls back to the id rather than claiming a scope you cannot act on", () => {
    expect(entryLocation(entry({ scope: "project", featureId: "feat_Lm8nOp2qRs6" }))).toBe(
      "feat_Lm8nOp2qRs6"
    );
  });

  test("resolves a project name the entry never recorded, from the stats map", () => {
    // Only some memories carry projectName in their metadata; the stats
    // endpoint knows every project, so a bare UUID never has to be shown.
    const uuid = "3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f";
    const resolve = (id: string) => (id === uuid ? "project-1" : undefined);
    expect(entryLocation(entry({ scope: "project", projectId: uuid }), resolve)).toBe("project-1");
  });

  // The recorded names say where it was extracted; the dream can move it since.
  test("where it lives now wins over the names recorded where it was extracted", () => {
    const moved = entry({ scope: "project", projectId: "p_project4", metadata: { sourceMetadata: { projectName: "project-1", featureName: "research" } } });
    expect(entryLocation(moved, (id) => (id === "p_project4" ? "project-4" : undefined))).toBe("project-4");
    const stayed = entry({ scope: "project", projectId: "p_project1", featureId: "feat_1", metadata: { sourceMetadata: { projectName: "project-1", featureName: "research" } } });
    expect(entryLocation(stayed, (id) => (id === "p_project1" ? "project-1" : undefined))).toBe("project-1 / research");
    // Moved into a new project of the same name: the recorded worker is the old project's.
    const sameName = entry({ scope: "project", projectId: "p_project12", featureId: null, metadata: { sourceMetadata: { projectName: "project-1", featureName: "old-release-worker" } } });
    expect(entryLocation(sameName, (id) => (id === "p_project12" ? "project-1" : undefined))).toBe("project-1");
    const mine = entry({ scope: "user", metadata: { sourceMetadata: { projectName: "project-1", featureName: "research" } } });
    expect(entryLocation(mine)).toBe("yours");
  });

  test("an unresolvable UUID is shortened rather than crowding out the content", () => {
    const uuid = "6f7a8b9c-0d1e-4f2a-9b3c-5d6e7f8a9b0c";
    expect(entryLocation(entry({ scope: "project", projectId: uuid }))).toBe("6f7a8b9c");
  });

  test("the user's own memories read as theirs", () => {
    expect(entryLocation(entry({ scope: "user" }))).toBe("yours");
  });
});

describe("entryFacets", () => {
  // A memory whose extraction recorded no names still has its project's id;
  // the page's project list turns that into the name the reader knows.
  test("names the project through the resolver, never printing its id", () => {
    const names = new Map([["proj_Ab3dEf6hIj9", "project-1"], ["proj_other", "project-3"]]);
    const resolve = (id: string) => names.get(id);
    expect(entryFacets(entry({ scope: "project", projectId: "proj_Ab3dEf6hIj9" }), resolve)).toBe("knowledge · project-1");
    expect(entryFacets(entry({ scope: "project", projectId: "proj_other", type: "preference" }), resolve)).toBe("preference · project-3");
    // An archived feature whose name was never recorded: its project stands in.
    expect(entryFacets(entry({ scope: "project", projectId: "proj_Ab3dEf6hIj9", featureId: "feat_gone" }), resolve)).toBe("knowledge · project-1");
  });
});

// Memory's two-line previews show a memory's text with any word too long to
// read there (a hash, a path) shortened in the middle, so the sentence around
// it still shows. The memory itself is never changed.
describe("previewText", () => {
  const HASH = "3f9c1a2b7d4e5f60718293a4b5c6d7e8f9012345abcdef0123456789abcdef01";

  test("a word over 28 characters shows its first and last 12, joined by an ellipsis", () => {
    expect(previewText(`${HASH} is the v3.22.0 release commit.`)).toBe("3f9c1a2b7d4e…6789abcdef01 is the v3.22.0 release commit.");
    expect(previewText("PID. /Users/user/.mandate/run/workers/zoom-worker/tmux-server-default.sock was stale."))
      .toBe("PID. /Users/user/…default.sock was stale.");
  });

  test("words up to 28 characters, and the spacing between words, are left as they are", () => {
    const word28 = "a".repeat(28);
    expect(previewText(`keep ${word28}\nand  this`)).toBe(`keep ${word28}\nand  this`);
    expect(previewText(`${"a".repeat(29)}`)).toBe(`${"a".repeat(12)}…${"a".repeat(12)}`);
  });

  test("characters are counted and kept whole as a person sees them", () => {
    // 29 emoji are 58 UTF-16 units: shortened by characters, none cut in half.
    expect(previewText("😀".repeat(29))).toBe(`${"😀".repeat(12)}…${"😀".repeat(12)}`);
    // 28 of them are 56 units but 28 characters: left as they are.
    expect(previewText("😀".repeat(28))).toBe("😀".repeat(28));
  });

  // Chinese, Japanese, Thai and the like have no spaces, so a whole sentence is
  // one "word" here; they break between characters anyway and never run past the
  // edge. Shortening them would cut a sentence in half.
  test("a run of CJK or Thai text is never shortened, however long", () => {
    const zh = "这个仓库的说明文档按章节拆成多个文件并且每个文件的开头都要写清楚它面向的读者和前置条件";
    expect(zh.length).toBeGreaterThan(28);
    expect(previewText(zh)).toBe(zh);
    const th = "ผู้ใช้ต้องการให้รันการทดสอบทั้งหมดก่อนปล่อยเวอร์ชันใหม่ทุกครั้ง";
    expect(previewText(th)).toBe(th);
    // A path glued to Chinese text is left whole too; wrapping handles its width.
    const mixed = "日志在/Users/user/.mandate/logs/workers/zoom-worker/session-1234567890.log里";
    expect(previewText(mixed)).toBe(mixed);
  });

  // A zero-width space separates words without showing a space: words joined by
  // it are separate words, and only a long one among them is shortened.
  test("zero-width spaces separate words", () => {
    const zw = "Always​run​the​complete​test​suite​before​release.";
    expect(previewText(zw)).toBe(zw);
    expect(previewText(`see​${HASH}​now`)).toBe("see​3f9c1a2b7d4e…6789abcdef01​now");
  });
});
