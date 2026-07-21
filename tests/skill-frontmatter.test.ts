import { expect, test } from "bun:test";
import { parseSkillFrontmatter } from "../src/server/modules/skills/skill-frontmatter.js";

test("parseSkillFrontmatter: valid SKILL.md returns parsed shape", () => {
  const source = `---
name: ui-routes
description: Catalog of pages.
scope: [manager]
---

# Body

Content here.`;
  const result = parseSkillFrontmatter(source);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.name).toBe("ui-routes");
  expect(result.value.description).toBe("Catalog of pages.");
  expect(result.value.scope).toEqual(["manager"]);
  expect(result.value.body).toMatch(/# Body\s+Content here\./);
});

test("parseSkillFrontmatter: missing name returns error", () => {
  const source = `---
description: foo
---

body`;
  const result = parseSkillFrontmatter(source);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatch(/name/);
});

test("parseSkillFrontmatter: missing description returns error", () => {
  const source = `---
name: foo
---

body`;
  const result = parseSkillFrontmatter(source);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatch(/description/);
});

test("parseSkillFrontmatter: omitted scope defaults to both agent types", () => {
  const source = `---
name: foo
description: bar
---

body`;
  const result = parseSkillFrontmatter(source);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.scope.sort()).toEqual(["manager", "worker"]);
});

test("parseSkillFrontmatter: scope as a single string is normalised to an array", () => {
  const source = `---
name: foo
description: bar
scope: manager
---

body`;
  const result = parseSkillFrontmatter(source);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.scope).toEqual(["manager"]);
});

test("parseSkillFrontmatter: invalid scope value returns error", () => {
  const source = `---
name: foo
description: bar
scope: [admin]
---

body`;
  const result = parseSkillFrontmatter(source);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatch(/scope/);
});

test("parseSkillFrontmatter: malformed YAML returns error", () => {
  const source = `---
name: foo
  bad: indent
description
---

body`;
  const result = parseSkillFrontmatter(source);
  expect(result.ok).toBe(false);
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

test("parseSkillFrontmatter: legacy overview/feature scopes normalize to manager/worker", () => {
  const source = `---
name: a
description: b
scope: [overview, feature]
---

body`;
  const result = parseSkillFrontmatter(source);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.scope).toEqual(["manager", "worker"]);
});

test("parseSkillFrontmatter: legacy scope as a single string normalizes", () => {
  const source = `---
name: a
description: b
scope: feature
---

body`;
  const result = parseSkillFrontmatter(source);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.scope).toEqual(["worker"]);
});
