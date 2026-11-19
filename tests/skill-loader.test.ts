import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSkillsFromDir } from "../src/server/modules/skills/skill-loader.js";
import { bootstrapSkills, resolveSkillsDirs } from "../src/server/runtime/skills-bootstrap.js";
import { parseSkillFrontmatter } from "../src/server/modules/skills/skill-frontmatter.js";
import { pageContract } from "../src/server/modules/page/page-contract.js";
import { tempDir } from "./helpers/temp.js";
import { onCleanup } from "./helpers/cleanup.js";

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
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  onCleanup(() => warn.mockRestore());
  const result = await loadSkillsFromDir(root);
  expect(result).toStrictEqual([]);
  // A folder that is not a skill is common: skipped without a word.
  expect(warn).not.toHaveBeenCalled();
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
  expect(body).toMatch(/Mandate owns the lifecycle of worker panes/);
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

test("loadSkillsFromDir: built-in canvas-artifact skill is visible to manager, worker and the personal agent", async () => {
  const root = path.resolve(import.meta.dirname, "../src/server/modules/skills/builtins");
  const result = await loadSkillsFromDir(root);
  const skill = result.find((entry) => entry.name === "canvas-artifact");
  expect(skill).toBeTruthy();
  expect(skill!.scope).toEqual(["manager", "worker", "personal"]);
  expect(skill!.description).toMatch(/How to design a Mandate report/);

  const body = await skill!.loadBody();
  expect(body).toMatch(/## Rules for every report/);
  expect(body).toMatch(/Draw charts to scale/);
  expect(body).toMatch(/the `canvas` tool's outline/);
  expect(body).not.toMatch(/## Page contract/);
});

test("loadSkillsFromDir: built-in canvas-design skill is visible to manager, worker and the personal agent, with its references", async () => {
  const root = path.resolve(import.meta.dirname, "../src/server/modules/skills/builtins");
  const result = await loadSkillsFromDir(root);
  const skill = result.find((entry) => entry.name === "canvas-design");
  expect(skill).toBeTruthy();
  expect(skill!.scope).toEqual(["manager", "worker", "personal"]);
  expect(skill!.description).toMatch(/How to make a Mandate design canvas/);
  expect(await skill!.loadBody()).toMatch(/## The files: exact shapes/);
  expect(skill!.resolveReference("craft.md")).toBeTruthy();
  expect(skill!.resolveReference("questions.md")).toBeTruthy();
});

test("loadSkillsFromDir: built-in agent-page skill is the personal agent's, and its body is the page contract", async () => {
  const root = path.resolve(import.meta.dirname, "../src/server/modules/skills/builtins");
  const result = await loadSkillsFromDir(root);
  const skill = result.find((entry) => entry.name === "agent-page");
  expect(skill).toBeTruthy();
  expect(skill!.scope).toEqual(["personal"]);
  expect(skill!.description).toBe("The rules of your page beside the conversation. Read before you edit the page yourself.");
  const body = await skill!.loadBody();
  expect(body.trim()).toBe(pageContract());
  // The file is the frontmatter and that body, nothing else.
  const raw = fs.readFileSync(path.join(root, "agent-page", "SKILL.md"), "utf8");
  const parsed = parseSkillFrontmatter(raw);
  expect(parsed.ok && parsed.value.body.trim()).toBe(pageContract());
  expect(pageContract().startsWith("# The page\n\nThe page is the site/ folder in the page folder")).toBe(true);
  expect(pageContract().endsWith("needs an index.html; files whose names begin with a dot are left out.")).toBe(true);
});

test("resolveSkillsDirs: config's extra folders are read as given, a relative one inside the data dir", () => {
  const dataDir = tempDir("mandate-skills-data-");
  const dirs = resolveSkillsDirs({ builtinSkillsDir: "/opt/builtins", dataDir, extraDirs: ["/srv/team-skills", "more-skills"] });
  expect(dirs).toEqual({
    builtinSkillsDir: "/opt/builtins",
    userSkillsDir: path.join(dataDir, "skills"),
    extraSkillsDirs: ["/srv/team-skills", path.join(dataDir, "more-skills")]
  });
});

test("resolveSkillsDirs: a folder written from the home directory (~/) is read there, as the data dir is", () => {
  const dirs = resolveSkillsDirs({ builtinSkillsDir: "/opt/builtins", dataDir: "/srv/data", extraDirs: ["~/team-skills"] });
  expect(dirs.extraSkillsDirs).toEqual([path.join(os.homedir(), "team-skills")]);
});

test("bootstrapSkills: a skill is the user's only inside the data dir's skills folder, not one that starts the same", async () => {
  const data = tempDir("mandate-skills-source-");
  const builtins = path.join(data, "builtins");
  fs.mkdirSync(builtins);
  writeSkill(path.join(data, "skills"), "mine", "---\nname: mine\ndescription: the user's own\n---\nbody\n");
  writeSkill(path.join(data, "skills-team"), "shared", "---\nname: shared\ndescription: a team folder\n---\nbody\n");
  const { list } = await bootstrapSkills(resolveSkillsDirs({ builtinSkillsDir: builtins, dataDir: data, extraDirs: ["skills-team"] }));
  expect(Object.fromEntries(list().filter((s) => s.name === "mine" || s.name === "shared").map((s) => [s.name, s.source]))).toEqual({ mine: "user", shared: "extra" });
});
