import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadSkillsFromDir } from "../src/server/modules/skills/skill-loader.js";
import { parseSkillFrontmatter } from "../src/server/modules/skills/skill-frontmatter.js";
import { pageContract } from "../src/server/modules/page/page-contract.js";
import { tempDir } from "./helpers/temp.js";

function writeSkill(root: string, dirName: string, content: string): void {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf8");
}

test("loadSkillsFromDir: missing root returns empty array, no throw", async () => {
  const result = await loadSkillsFromDir("/nonexistent/path/that/does/not/exist");
  expect(result).toEqual([]);
});

test("loadSkillsFromDir: empty root returns empty array", async () => {
  const root = tempDir("mandate-skills-test-");
  const result = await loadSkillsFromDir(root);
  expect(result).toEqual([]);
});

test("loadSkillsFromDir: subdir without SKILL.md is skipped", async () => {
  const root = tempDir("mandate-skills-test-");
  fs.mkdirSync(path.join(root, "broken"), { recursive: true });
  fs.writeFileSync(path.join(root, "broken", "README.md"), "no skill here", "utf8");
  const result = await loadSkillsFromDir(root);
  expect(result).toEqual([]);
});

test("loadSkillsFromDir: parses one valid skill into an entry", async () => {
  const root = tempDir("mandate-skills-test-");
  writeSkill(
    root,
    "house-style",
    `---
name: house-style
description: routes catalogue
---

body content`
  );
  const result = await loadSkillsFromDir(root);
  expect(result.length).toBe(1);
  expect(result[0]!.name).toBe("house-style");
  expect(result[0]!.description).toBe("routes catalogue");
  expect(result[0]!.sourcePath).toBe(path.join(root, "house-style", "SKILL.md"));
});

test("loadSkillsFromDir: invalid frontmatter is skipped", async () => {
  const root = tempDir("mandate-skills-test-");
  writeSkill(
    root,
    "broken",
    `---
description: missing name
---

body`
  );
  writeSkill(
    root,
    "good",
    `---
name: good
description: ok
---

body`
  );
  const result = await loadSkillsFromDir(root);
  expect(result.length).toBe(1);
  expect(result[0]!.name).toBe("good");
});

test("loadSkillsFromDir: name mismatched with directory name still loads, uses frontmatter name", async () => {
  const root = tempDir("mandate-skills-test-");
  writeSkill(
    root,
    "different-dir",
    `---
name: actual-name
description: ok
---

body`
  );
  const result = await loadSkillsFromDir(root);
  expect(result.length).toBe(1);
  expect(result[0]!.name).toBe("actual-name");
});

test("loadSkillsFromDir: bodyLoader returns the body content, lazily", async () => {
  const root = tempDir("mandate-skills-test-");
  writeSkill(
    root,
    "lazy",
    `---
name: lazy
description: ok
---

original body`
  );
  const result = await loadSkillsFromDir(root);
  // Mutate the file after scan; loadBody must re-read it.
  fs.writeFileSync(
    path.join(root, "lazy", "SKILL.md"),
    `---
name: lazy
description: ok
---

mutated body`,
    "utf8"
  );
  const body = await result[0]!.loadBody();
  expect(body).toMatch(/mutated body/);
});

test("loadSkillsFromDir: file under nested subdirectory is ignored", async () => {
  const root = tempDir("mandate-skills-test-");
  fs.mkdirSync(path.join(root, "outer", "inner"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "outer", "inner", "SKILL.md"),
    `---
name: nested
description: should be ignored
---

body`,
    "utf8"
  );
  const result = await loadSkillsFromDir(root);
  expect(result).toEqual([]);
});

test("loadSkillsFromDir: resolveReference returns the disk path for an existing file", async () => {
  const root = tempDir("mandate-skills-test-");
  writeSkill(
    root,
    "with-refs",
    `---
name: with-refs
description: ok
---

body`
  );
  const refsDir = path.join(root, "with-refs", "references");
  fs.mkdirSync(refsDir);
  fs.writeFileSync(path.join(refsDir, "advanced.md"), "ref body", "utf8");

  const [skill] = await loadSkillsFromDir(root);
  expect(skill!.resolveReference("advanced.md")).toBe(path.join(refsDir, "advanced.md"));
});

test("loadSkillsFromDir: resolveReference rejects path traversal", async () => {
  const root = tempDir("mandate-skills-test-");
  writeSkill(
    root,
    "with-refs",
    `---
name: with-refs
description: ok
---

body`
  );
  fs.mkdirSync(path.join(root, "with-refs", "references"));

  // A sibling file outside references/ — must not be reachable
  fs.writeFileSync(path.join(root, "with-refs", "secret.md"), "no peeking", "utf8");

  const [skill] = await loadSkillsFromDir(root);
  expect(skill!.resolveReference("../secret.md")).toBe(null);
  expect(skill!.resolveReference("/etc/passwd")).toBe(null);
});

test("loadSkillsFromDir: resolveReference returns null when references/ doesn't exist", async () => {
  const root = tempDir("mandate-skills-test-");
  writeSkill(
    root,
    "no-refs",
    `---
name: no-refs
description: ok
---

body`
  );
  const [skill] = await loadSkillsFromDir(root);
  expect(skill!.resolveReference("anything.md")).toBe(null);
});

test("loadSkillsFromDir: built-in tmux-pane skill is worker-scoped", async () => {
  const root = path.resolve(import.meta.dirname, "../src/server/modules/skills/builtins");
  const result = await loadSkillsFromDir(root);
  const skill = result.find((entry) => entry.name === "tmux-pane");
  expect(skill).toBeTruthy();
  expect(skill!.scope).toEqual(["worker"]);
  expect(skill!.description).toMatch(/terminal panes/);

  const body = await skill!.loadBody();
  expect(body).toMatch(/send_keys/);
  expect(body).toMatch(/Mandate owns the lifecycle of feature panes/);
  expect(body).toMatch(/Do not use raw `tmux` commands to\s+create, identify, resize, or destroy/);
  expect(body).toMatch(/target the exact\s+pane\/window\/session explicitly/);
  expect(body).toMatch(/Working With Interactive Agents/);
  // A new task reuses a pane whose agent has finished (exit, start again);
  // a finished agent's pane is closed.
  const flat = body.replace(/\s+/g, " ");
  expect(flat).toContain("A new task for an agent goes to a pane where that agent has finished: exit it there (`C-c`, again if it asks, or `C-d`) and start it again, unless the task follows on from what it just did.");
  expect(flat).toContain("Open another agent pane only when every one holds work still running or still needed.");
  expect(flat).toContain("take what you need from its pane, then close it with `kill_pane`.");
  expect(body).toMatch(/args": \["-l", "your instruction with spaces"\]/);
  expect(body).toMatch(/args": \["Enter"\]/);
  expect(body).toMatch(/only type text without submitting/);
  expect(body).toMatch(/runs through `bash` by default/);
  expect(body).not.toMatch(/Do not use `bash` as the normal way/);
});

test("loadSkillsFromDir: built-in canvas-artifact skill is visible to manager and worker", async () => {
  const root = path.resolve(import.meta.dirname, "../src/server/modules/skills/builtins");
  const result = await loadSkillsFromDir(root);
  const skill = result.find((entry) => entry.name === "canvas-artifact");
  expect(skill).toBeTruthy();
  expect(skill!.scope).toEqual(["manager", "worker"]);
  expect(skill!.description).toMatch(/How to design a Mandate report/);

  const body = await skill!.loadBody();
  expect(body).toMatch(/## Rules for every report/);
  expect(body).toMatch(/Draw charts to scale/);
  expect(body).toMatch(/canvas_outline/);
  expect(body).not.toMatch(/## Page contract/);
});

test("loadSkillsFromDir: built-in canvas-design skill is visible to manager and worker, with its references", async () => {
  const root = path.resolve(import.meta.dirname, "../src/server/modules/skills/builtins");
  const result = await loadSkillsFromDir(root);
  const skill = result.find((entry) => entry.name === "canvas-design");
  expect(skill).toBeTruthy();
  expect(skill!.scope).toEqual(["manager", "worker"]);
  expect(skill!.description).toMatch(/How to make a Mandate design canvas/);
  expect(await skill!.loadBody()).toMatch(/## The files: exact shapes/);
  expect(skill!.resolveReference("craft.md")).toBeTruthy();
  expect(skill!.resolveReference("questions.md")).toBeTruthy();
});

test("loadSkillsFromDir: built-in agent-page skill is Your agent's, and its body is the page contract", async () => {
  const root = path.resolve(import.meta.dirname, "../src/server/modules/skills/builtins");
  const result = await loadSkillsFromDir(root);
  const skill = result.find((entry) => entry.name === "agent-page");
  expect(skill).toBeTruthy();
  expect(skill!.scope).toEqual(["global"]);
  expect(skill!.description).toBe("The rules of your page beside the conversation. Read before you edit the page yourself.");
  const body = await skill!.loadBody();
  expect(body.trim()).toBe(pageContract());
  // The file is the frontmatter and that body, nothing else.
  const raw = fs.readFileSync(path.join(root, "agent-page", "SKILL.md"), "utf8");
  const parsed = parseSkillFrontmatter(raw);
  expect(parsed.ok && parsed.value.body.trim()).toBe(pageContract());
  expect(pageContract().startsWith("# The page\n\nThe page is index.html in the page folder")).toBe(true);
  expect(pageContract().endsWith("a page subagent when it finishes, Your agent when its turn ends.")).toBe(true);
});
