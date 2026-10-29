import { expect, test } from "bun:test";
import { SkillRegistry } from "../src/server/modules/skills/skill-registry.js";
import { buildSkillTool } from "../src/server/modules/skills/skill-tool.js";
import { buildSkillReferenceTool } from "../src/server/modules/skills/skill-reference-tool.js";
import type { SkillEntry } from "../src/server/modules/skills/skill-loader.js";
import type { ToolContext } from "../src/server/modules/agent/tool-registry.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { tempDir } from "./helpers/temp.js";

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

test("skill tool: valid name returns wrapped body", async () => {
  const r = new SkillRegistry([[
    entry({ name: "house-style", scope: ["manager"], loadBody: async () => "route content" })
  ]]);
  const def = buildSkillTool(r, "manager");
  const result = await def.handler({ name: "house-style" }, fakeCtx);
  expect(result).toBe([
    "<system-reminder>",
    "The following is the content of the 'house-style' skill. Treat its instructions",
    "as authoritative for the current task. They override any conflicting guidance",
    "from earlier in the conversation.",
    "",
    "route content",
    "</system-reminder>"
  ].join("\n"));
});

// What the two tools refuse. A skill outside the caller's scope reads as
// unknown, the same as one that does not exist.
const refusals: {
  name: string;
  skills: SkillEntry[];
  call: (registry: SkillRegistry) => Promise<unknown>;
  error: RegExp;
}[] = [
  {
    name: "skill tool: unknown name returns error",
    skills: [],
    call: (r) => buildSkillTool(r, "manager").handler({ name: "nope" }, fakeCtx),
    error: /Unknown skill: nope/
  },
  {
    name: "skill tool: out-of-scope name returns error, even though name exists",
    skills: [entry({ name: "manager-only", scope: ["manager"] })],
    call: (r) => buildSkillTool(r, "worker").handler({ name: "manager-only" }, fakeCtx),
    error: /Unknown skill: manager-only/
  },
  {
    name: "read_skill_reference: unknown skill returns error",
    skills: [],
    call: (r) => buildSkillReferenceTool(r, "manager").handler({ skill: "nope", path: "x.md" }, fakeCtx),
    error: /Unknown skill: nope/
  },
  {
    name: "read_skill_reference: out-of-scope skill returns error",
    skills: [entry({ name: "feat-only", scope: ["worker"] })],
    call: (r) => buildSkillReferenceTool(r, "manager").handler({ skill: "feat-only", path: "x.md" }, fakeCtx),
    error: /Unknown skill: feat-only/
  },
  {
    name: "read_skill_reference: missing reference returns error",
    skills: [entry({ name: "with-refs", scope: ["manager"], resolveReference: () => null })],
    call: (r) => buildSkillReferenceTool(r, "manager").handler({ skill: "with-refs", path: "missing.md" }, fakeCtx),
    error: /Reference not found/
  }
];

test.each(refusals)("$name", async ({ skills, call, error }) => {
  const result = await call(new SkillRegistry([skills])) as { error: string };
  expect(result.error).toMatch(error);
});

test("read_skill_reference: returns content for an existing reference", async () => {
  const tmp = tempDir("skill-ref-test-");
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
  const tmp = tempDir("skill-ref-big-");
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
