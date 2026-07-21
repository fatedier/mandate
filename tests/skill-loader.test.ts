import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSkillsFromDir } from "../src/server/modules/skills/skill-loader.js";

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mandate-skills-test-"));
}

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
  const root = makeTmpRoot();
  const result = await loadSkillsFromDir(root);
  expect(result).toEqual([]);
});

test("loadSkillsFromDir: subdir without SKILL.md is skipped", async () => {
  const root = makeTmpRoot();
  fs.mkdirSync(path.join(root, "broken"), { recursive: true });
  fs.writeFileSync(path.join(root, "broken", "README.md"), "no skill here", "utf8");
  const result = await loadSkillsFromDir(root);
  expect(result).toEqual([]);
});

test("loadSkillsFromDir: parses one valid skill into an entry", async () => {
  const root = makeTmpRoot();
  writeSkill(
    root,
    "ui-routes",
    `---
name: ui-routes
description: routes catalogue
---

body content`
  );
  const result = await loadSkillsFromDir(root);
  expect(result.length).toBe(1);
  expect(result[0]!.name).toBe("ui-routes");
  expect(result[0]!.description).toBe("routes catalogue");
  expect(result[0]!.sourcePath).toBe(path.join(root, "ui-routes", "SKILL.md"));
});

test("loadSkillsFromDir: invalid frontmatter is skipped", async () => {
  const root = makeTmpRoot();
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
  const root = makeTmpRoot();
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
  const root = makeTmpRoot();
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
  const root = makeTmpRoot();
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
  const root = makeTmpRoot();
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
  const root = makeTmpRoot();
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
  const root = makeTmpRoot();
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
  expect(body).toMatch(/Submitting To Interactive Agents/);
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
  expect(skill!.description).toMatch(/polished Mandate HTML canvases/);

  const body = await skill!.loadBody();
  expect(body).toMatch(/Publish Checklist/);
  expect(body).toMatch(/fake controls/);
  expect(body).toMatch(/min-h-screen/);
  expect(body).toMatch(/bg-background/);
  expect(body).toMatch(/Namespace semantic CSS classes/);
  expect(body).toMatch(/`canvas-patched-result`/);
});
