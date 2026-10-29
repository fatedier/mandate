import { expect, test } from "bun:test";
import { parseSkillFrontmatter, type SkillScope } from "../src/server/modules/skills/skill-frontmatter.js";

/** A SKILL.md whose frontmatter holds these lines, and a one-line body. */
function skillSource(...frontmatter: string[]): string {
  return ["---", ...frontmatter, "---", "", "body"].join("\n");
}

test("parseSkillFrontmatter: valid SKILL.md returns parsed shape", () => {
  const source = `---
name: house-style
description: Catalog of pages.
scope: [manager]
---

# Body

Content here.`;
  const result = parseSkillFrontmatter(source);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.name).toBe("house-style");
  expect(result.value.description).toBe("Catalog of pages.");
  expect(result.value.scope).toEqual(["manager"]);
  expect(result.value.body).toMatch(/# Body\s+Content here\./);
});

// Frontmatter that is refused, and what the error names.
const refused: { name: string; frontmatter: string[]; error: RegExp }[] = [
  {
    name: "parseSkillFrontmatter: missing name returns error",
    frontmatter: ["description: foo"],
    error: /name/
  },
  {
    name: "parseSkillFrontmatter: missing description returns error",
    frontmatter: ["name: foo"],
    error: /description/
  },
  {
    name: "parseSkillFrontmatter: invalid scope value returns error",
    frontmatter: ["name: foo", "description: bar", "scope: [admin]"],
    error: /scope/
  },
  {
    name: "parseSkillFrontmatter: the old overview/feature scope names are refused",
    frontmatter: ["name: foo", "description: bar", "scope: [overview, feature]"],
    error: /invalid value 'overview'/
  },
  {
    name: "parseSkillFrontmatter: malformed YAML returns error",
    frontmatter: ["name: foo", "  bad: indent", "description"],
    error: /failed to parse frontmatter/
  }
];

test.each(refused)("$name", ({ frontmatter, error }) => {
  const result = parseSkillFrontmatter(skillSource(...frontmatter));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatch(error);
});

// The default's order is not part of the rule, so it is compared sorted.
test("parseSkillFrontmatter: omitted scope defaults to every agent type, Your agent's too", () => {
  const result = parseSkillFrontmatter(skillSource("name: foo", "description: bar"));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.scope.sort()).toEqual(["global", "manager", "worker"]);
});

// A scope that is written is read as written, a single string as a
// one-item array.
const scopes: { name: string; scope: string; expected: SkillScope[] }[] = [
  {
    name: "parseSkillFrontmatter: scope global is Your agent's, and only its",
    scope: "[global]",
    expected: ["global"]
  },
  {
    name: "parseSkillFrontmatter: scope as a single string is normalised to an array",
    scope: "manager",
    expected: ["manager"]
  },
];

test.each(scopes)("$name", ({ scope, expected }) => {
  const result = parseSkillFrontmatter(skillSource("name: foo", "description: bar", `scope: ${scope}`));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.scope).toEqual(expected);
});

test("parseSkillFrontmatter: body line count is reported", () => {
  const source = `---
name: foo
description: bar
---

line one
line two
line three`;
  const result = parseSkillFrontmatter(source);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.bodyLineCount).toBe(4);
});

