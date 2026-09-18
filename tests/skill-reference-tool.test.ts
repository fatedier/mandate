import { expect, test } from "bun:test";
import { SkillRegistry } from "../src/server/modules/skills/skill-registry.js";
import { buildSkillReferenceTool } from "../src/server/modules/skills/skill-reference-tool.js";
import type { SkillEntry } from "../src/server/modules/skills/skill-loader.js";
import type { ToolContext } from "../src/server/modules/agent/tool-registry.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function entry(over: Partial<SkillEntry>): SkillEntry {
  return {
    name: "x",
    description: "desc",
    scope: ["manager", "worker"],
    sourcePath: "/fake/SKILL.md",
    loadBody: async () => "body",
    resolveReference: () => null,
    ...over
  };
}

const fakeCtx: ToolContext = {
  threadId: "t", wakeId: "w",
  scope: { kind: "manager", managerDir: "/tmp", projectWorkingDirs: [] }
};

test("read_skill_reference: unknown skill returns error", async () => {
  const r = new SkillRegistry();
  const def = buildSkillReferenceTool(r, "manager");
  const result = await def.handler({ skill: "nope", path: "x.md" }, fakeCtx) as { error: string };
  expect(result.error).toMatch(/Unknown skill: nope/);
});

test("read_skill_reference: out-of-scope skill returns error", async () => {
  const r = new SkillRegistry([[entry({ name: "feat-only", scope: ["worker"] })]]);
  const def = buildSkillReferenceTool(r, "manager");
  const result = await def.handler({ skill: "feat-only", path: "x.md" }, fakeCtx) as { error: string };
  expect(result.error).toMatch(/Unknown skill: feat-only/);
});

test("read_skill_reference: missing reference returns error", async () => {
  const r = new SkillRegistry([[entry({
    name: "with-refs",
    scope: ["manager"],
    resolveReference: () => null
  })]]);
  const def = buildSkillReferenceTool(r, "manager");
  const result = await def.handler({ skill: "with-refs", path: "missing.md" }, fakeCtx) as { error: string };
  expect(result.error).toMatch(/Reference not found/);
});

test("read_skill_reference: returns content for an existing reference", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-ref-test-"));
  const refPath = path.join(tmp, "advanced.md");
  fs.writeFileSync(refPath, "# Advanced\n\nLong-form notes.", "utf8");

  const r = new SkillRegistry([[entry({
    name: "with-refs",
    scope: ["manager"],
    resolveReference: (rel) => (rel === "advanced.md" ? refPath : null)
  })]]);
  const def = buildSkillReferenceTool(r, "manager");
  const result = await def.handler({ skill: "with-refs", path: "advanced.md" }, fakeCtx);
  expect(result).toBe("# Advanced\n\nLong-form notes.");
});

test("read_skill_reference: rejects oversized references", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-ref-big-"));
  const refPath = path.join(tmp, "huge.md");
  fs.writeFileSync(refPath, "x".repeat(300 * 1024), "utf8");   // 300KB > 256KB cap

  const r = new SkillRegistry([[entry({
    name: "huge-ref",
    scope: ["manager"],
    resolveReference: (rel) => (rel === "huge.md" ? refPath : null)
  })]]);
  const def = buildSkillReferenceTool(r, "manager");
  const result = await def.handler({ skill: "huge-ref", path: "huge.md" }, fakeCtx) as { error: string };
  expect(result.error).toMatch(/too large/);
});
