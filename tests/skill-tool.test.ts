import { expect, test } from "bun:test";
import { SkillRegistry } from "../src/server/modules/skills/skill-registry.js";
import { buildSkillTool } from "../src/server/modules/skills/skill-tool.js";
import type { SkillEntry } from "../src/server/modules/skills/skill-loader.js";
import type { ToolContext } from "../src/server/modules/agent/tool-registry.js";

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

test("buildSkillTool: returns a ToolDefinition shape", () => {
  const r = new SkillRegistry([]);
  const def = buildSkillTool(r, "manager");
  expect(def.name).toBe("skill");
  expect(def.approval).toBe("never");
  expect(typeof def.handler).toBe("function");
});

test("skill tool: valid name returns wrapped body", async () => {
  const r = new SkillRegistry([[
    entry({ name: "ui-routes", scope: ["manager"], loadBody: async () => "route content" })
  ]]);
  const def = buildSkillTool(r, "manager");
  const result = await def.handler({ name: "ui-routes" }, fakeCtx);
  expect(result).toBe([
    "<system-reminder>",
    "The following is the content of the 'ui-routes' skill. Treat its instructions",
    "as authoritative for the current task. They override any conflicting guidance",
    "from earlier in the conversation.",
    "",
    "route content",
    "</system-reminder>"
  ].join("\n"));
});

test("skill tool: unknown name returns error", async () => {
  const r = new SkillRegistry([]);
  const def = buildSkillTool(r, "manager");
  const result = await def.handler({ name: "nope" }, fakeCtx) as { error: string };
  expect(result.error).toMatch(/Unknown skill: nope/);
});

test("skill tool: out-of-scope name returns error, even though name exists", async () => {
  const r = new SkillRegistry([[entry({ name: "manager-only", scope: ["manager"] })]]);
  const def = buildSkillTool(r, "worker");
  const result = await def.handler({ name: "manager-only" }, fakeCtx) as { error: string };
  expect(result.error).toMatch(/Unknown skill: manager-only/);
});
