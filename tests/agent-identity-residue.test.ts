import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { API_ROUTES } from "../src/shared/api/routes.js";

// Guards the 2026-08-17 identity rename (overview agent -> manager,
// feature agent -> worker): old identity values must not reappear in the
// identity positions. Entity/page usages ("Overview" page tabs, the
// feature entity, legacy-compat readers) are legitimate and deliberately
// not covered by a blanket grep.
describe("agent identity residue", () => {
  // Would fail if someone re-adds the old route paths or renames the new
  // ones back in src/shared/api/routes.ts.
  test("route table has no old agent identity paths", () => {
    const paths = Object.values(API_ROUTES).join("\n");
    expect(paths).not.toContain("/api/agents/overview");
    expect(paths).not.toContain("/api/agents/features/");
    expect(paths).toContain("/api/agents/manager");
    expect(paths).toContain("/api/agents/workers/");
  });

  // Would fail if a prompt file is restored under its pre-rename name in
  // src/server/modules/agent/prompts/.
  test("prompts directory carries no old identity file names", () => {
    const files = readdirSync("src/server/modules/agent/prompts");
    expect(files.some((f) => f.startsWith("overview") || f.startsWith("feature-agent"))).toBe(false);
  });

  // Would fail if the tool-scope discriminated union grows an old kind back.
  test("tool-scope union has no old kinds", () => {
    const src = readFileSync("src/server/modules/agent/tool-scope.ts", "utf8");
    expect(src).not.toMatch(/kind:\s*"(overview|feature)"/);
  });

  // Would fail if the validator starts admitting arbitrary scopes, or if
  // the legacy normaliser (overview -> manager) is dropped.
  test("skill validator only accepts new scopes (legacy handled by normalizer)", async () => {
    const { parseSkillFrontmatter } = await import("../src/server/modules/skills/skill-frontmatter.js");
    const bad = parseSkillFrontmatter("---\nname: a\ndescription: b\nscope: [banana]\n---\nx");
    expect(bad.ok).toBe(false);
    const legacy = parseSkillFrontmatter("---\nname: a\ndescription: b\nscope: [overview]\n---\nx");
    expect(legacy.ok && legacy.value.scope).toEqual(["manager"]);
  });
});
