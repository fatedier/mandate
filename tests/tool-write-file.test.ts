import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildReadFileTool, markFileRead, readFileTool } from "../src/server/modules/agent/tools/read-file.js";
import { buildEditFileTool } from "../src/server/modules/agent/tools/edit-file.js";
import { buildWriteFileTool, writeFileTool } from "../src/server/modules/agent/tools/write-file.js";
import type { TextFileSystem } from "../src/server/platform/fs/text-file-system.js";
import { tempDir } from "./helpers/temp.js";
import { toolContext } from "./helpers/typed.js";

function ctx(wd: string) {
  return toolContext({ threadId: "t", wakeId: "w",
           scope: {
             kind: "worker",
             feature: { workingDir: wd },
             project: { workingDir: wd }
           } });
}

test("writeFileTool: can overwrite a file it created", async () => {
  const wd = tempDir("wf-");
  const target = path.join(wd, "new.txt");
  const context = ctx(wd);
  await writeFileTool.handler({ path: target, content: "hello" }, context);
  const r = await writeFileTool.handler({ path: target, content: "updated" }, context);
  expect(r).toBe(`Overwrote ${target} (7 bytes, +1 -1 lines).`);
  expect(fs.readFileSync(target, "utf8")).toBe("updated");
});

test("writeFileTool: requires read before overwriting", async () => {
  const wd = tempDir("wf-");
  const target = path.join(wd, "exists.txt");
  fs.writeFileSync(target, "old");
  await expect(writeFileTool.handler({ path: target, content: "new" }, ctx(wd)))
    .rejects.toThrow(/read must be called/i);
  expect(fs.readFileSync(target, "utf8")).toBe("old");
});

test("writeFileTool: overwrites after read", async () => {
  const wd = tempDir("wf-");
  const target = path.join(wd, "exists.txt");
  fs.writeFileSync(target, "old");
  const context = ctx(wd);
  await readFileTool.handler({ path: target }, context);
  const r = await writeFileTool.handler({ path: target, content: "new" }, context);
  expect(r).toBe(`Overwrote ${target} (3 bytes, +1 -1 lines).`);
  expect(fs.readFileSync(target, "utf8")).toBe("new");
});

test("writeFileTool: rejects path outside scope", async () => {
  const wd = tempDir("wf-");
  await expect(writeFileTool.handler({
    path: path.join(path.parse(os.tmpdir()).root, "__mandate_disallowed__", "outside.txt"),
    content: "x"
  }, ctx(wd))).rejects.toThrow(/scope/i);
});

test("writeFileTool: says how many lines a new file has, a final newline ending the last one", async () => {
  const wd = tempDir("wf-");
  const context = ctx(wd);
  const lines = path.join(wd, "lines.md");
  expect(await writeFileTool.handler({ path: lines, content: "# Notes\n\nFirst.\n" }, context))
    .toBe(`Created ${lines} (16 bytes, 3 lines).`);
  const empty = path.join(wd, "empty.txt");
  expect(await writeFileTool.handler({ path: empty, content: "" }, context))
    .toBe(`Created ${empty} (0 bytes, 0 lines).`);
  const one = path.join(wd, "one.txt");
  expect(await writeFileTool.handler({ path: one, content: "x" }, context))
    .toBe(`Created ${one} (1 byte, 1 line).`);
});

test("writeFileTool: an overwrite says the lines it added and removed, against the file it replaced", async () => {
  const wd = tempDir("wf-");
  const target = path.join(wd, "design.md");
  fs.writeFileSync(target, "# Design\n\nWrites go straight out.\nOne per call.\n\n## Tests\n");
  const context = ctx(wd);
  await readFileTool.handler({ path: target }, context);
  const content = "# Design\n\nWrites are batched.\nFlushed at 64KB.\nOr every 50ms.\n\n## Tests\n";
  expect(await writeFileTool.handler({ path: target, content }, context))
    .toBe(`Overwrote ${target} (${Buffer.byteLength(content)} bytes, +3 -2 lines).`);
  // The same text again changes nothing.
  expect(await writeFileTool.handler({ path: target, content }, context))
    .toBe(`Overwrote ${target} (${Buffer.byteLength(content)} bytes, +0 -0 lines).`);
});

class FakeFileSystem implements TextFileSystem {
  files = new Map<string, string>();
  dirs = new Set<string>();
  unreadable = new Set<string>();
  exists(filePath: string) { return this.files.has(filePath); }
  readText(filePath: string) {
    if (this.unreadable.has(filePath)) throw new Error("EACCES");
    const text = this.files.get(filePath);
    if (text === undefined) throw new Error("ENOENT");
    return text;
  }
  writeText(filePath: string, contents: string) { this.files.set(filePath, contents); }
  mkdirp(dirPath: string) { this.dirs.add(dirPath); }
  atomicWriteText(filePath: string, contents: string) { this.files.set(filePath, contents); }
  removeFile(filePath: string) { this.files.delete(filePath); }
}

test("agent file tools can use an injected text file system", async () => {
  const fileSystem = new FakeFileSystem();
  const workingDir = "/tmp/mandate-tool-fs";
  const target = path.join(workingDir, "notes.txt");

  const writeTool = buildWriteFileTool({ fileSystem });
  const readTool = buildReadFileTool({ fileSystem });
  const editTool = buildEditFileTool({ fileSystem });

  const context = ctx(workingDir);
  expect(await writeTool.handler({ path: target, content: "alpha beta" }, context))
    .toBe(`Created ${target} (10 bytes, 1 line).`);
  expect(fileSystem.dirs.has(workingDir)).toBe(true);
  expect(await readTool.handler({ path: target }, context))
    .toBe("     1\talpha beta");
  expect(await editTool.handler({ path: target, oldString: "beta", newString: "gamma" }, context))
    .toBe(`Updated ${target} (1 replacement, +1 -1 lines).`);
  expect(fileSystem.files.get(target)).toBe("alpha gamma");
});

test("writeFileTool: an overwrite it cannot count still writes, and says so without line counts", async () => {
  const fileSystem = new FakeFileSystem();
  const tool = buildWriteFileTool({ fileSystem });
  const context = ctx("/tmp/wf-fake");
  const unreadable = "/tmp/wf-fake/locked.txt";
  fileSystem.files.set(unreadable, "old");
  fileSystem.unreadable.add(unreadable);
  markFileRead("t", unreadable);
  expect(await tool.handler({ path: unreadable, content: "new" }, context)).toBe(`Overwrote ${unreadable} (3 bytes).`);
  expect(fileSystem.files.get(unreadable)).toBe("new");
  // Every line different, on both sides past 2,000: too large to align, so no
  // counts rather than every line removed and added.
  const large = "/tmp/wf-fake/large.txt";
  fileSystem.files.set(large, Array.from({ length: 2001 }, (_, i) => `old ${i}`).join("\n"));
  markFileRead("t", large);
  const content = Array.from({ length: 2001 }, (_, i) => `new ${i}`).join("\n");
  expect(await tool.handler({ path: large, content }, context)).toBe(`Overwrote ${large} (${Buffer.byteLength(content)} bytes).`);
  expect(fileSystem.files.get(large)).toBe(content);
  // Just under that, it counts.
  const edge = "/tmp/wf-fake/edge.txt";
  fileSystem.files.set(edge, Array.from({ length: 2000 }, (_, i) => `old ${i}`).join("\n"));
  markFileRead("t", edge);
  const edgeContent = Array.from({ length: 2000 }, (_, i) => `new ${i}`).join("\n");
  expect(await tool.handler({ path: edge, content: edgeContent }, context))
    .toBe(`Overwrote ${edge} (${Buffer.byteLength(edgeContent)} bytes, +2000 -2000 lines).`);
});

test("writeFileTool: counts against the text as written — a lone surrogate is written as U+FFFD", async () => {
  const fileSystem = new FakeFileSystem();
  const tool = buildWriteFileTool({ fileSystem });
  const target = "/tmp/wf-fake/surrogate.txt";
  fileSystem.files.set(target, "a\n\uFFFD\n");
  markFileRead("t", target);
  expect(await tool.handler({ path: target, content: "a\n\uD800\n" }, ctx("/tmp/wf-fake")))
    .toBe(`Overwrote ${target} (6 bytes, +0 -0 lines).`);
});

test("writeFileTool: a long file overwritten with a line or nothing is counted in one small table", async () => {
  const fileSystem = new FakeFileSystem();
  const tool = buildWriteFileTool({ fileSystem });
  const target = "/tmp/wf-fake/generated.txt";
  const long = Array.from({ length: 1_000_000 }, (_, i) => `line ${i}`).join("\n");
  for (const [content, expected] of [["", "+0 -1000000"], ["only\n", "+1 -1000000"]] as const) {
    fileSystem.files.set(target, long);
    markFileRead("t", target);
    expect(await tool.handler({ path: target, content }, ctx("/tmp/wf-fake")))
      .toBe(`Overwrote ${target} (${Buffer.byteLength(content)} bytes, ${expected} lines).`);
  }
});
