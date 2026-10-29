import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { readFileTool } from "../src/server/modules/agent/tools/read-file.js";
import { MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS } from "../src/server/modules/agent/wake-message-adapter.js";
import { tempDir } from "./helpers/temp.js";
import { toolContext } from "./helpers/typed.js";

function ctx(workingDir: string) {
  return toolContext({
    threadId: "t", wakeId: "w",
    scope: {
      kind: "worker",
      feature: { workingDir },
      project: { workingDir }
    }
  });
}

test("readFileTool: returns contents for file inside scope", async () => {
  const wd = tempDir("rf-");
  fs.writeFileSync(path.join(wd, "hello.txt"), "hi there");
  const r = await readFileTool.handler({ path: path.join(wd, "hello.txt") }, ctx(wd));
  expect(r).toBe("     1\thi there");
});

test("readFileTool: rejects path outside scope", async () => {
  const wd = tempDir("rf-");
  await expect(readFileTool.handler({ path: "/etc/passwd" }, ctx(wd)))
    .rejects.toThrow(/outside.*scope/i);
});

test("readFileTool: returns error for missing file", async () => {
  const wd = tempDir("rf-");
  const r = await readFileTool.handler({ path: path.join(wd, "nope.txt") }, ctx(wd));
  expect(r).toBe("File does not exist.");
});

test("readFileTool: reads a line range with offset and limit", async () => {
  const wd = tempDir("rf-");
  fs.writeFileSync(path.join(wd, "lines.txt"), "one\ntwo\nthree\nfour");
  const r = await readFileTool.handler(
    { path: path.join(wd, "lines.txt"), offset: 2, limit: 2 },
    ctx(wd)
  );
  expect(r).toBe("     2\ttwo\n     3\tthree");
});

test("readFileTool: rejects relative paths", async () => {
  const wd = tempDir("rf-");
  await expect(readFileTool.handler({ path: "hello.txt" }, ctx(wd)))
    .rejects.toThrow(/absolute/i);
});

// A read must never itself be swapped for a preview and a file (reading that
// file would be the same read again): one call returns at most what the
// model is given inline. A whole-file read past it is its first page, with a
// PARTIAL view line first; a read that names its range and still goes past
// it is refused.
test("readFileTool: a whole-file read past the inline limit is its first page, marked partial; a named range past it is refused", async () => {
  const wd = tempDir("rf-");
  const file = path.join(wd, "big.txt");
  const lines = Array.from({ length: 400 }, (_, i) => `${i} ${"r".repeat(90)}`);
  fs.writeFileSync(file, lines.join("\n"));
  const page = await readFileTool.handler({ path: file }, ctx(wd)) as string;
  expect(page.length).toBeLessThanOrEqual(MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS);
  const [notice, ...shown] = page.split("\n");
  expect(notice).toBe(`[PARTIAL view: lines 1–${shown.length} of 400. Read more with offset and limit.]`);
  expect(shown.length).toBeGreaterThan(250);
  expect(shown.at(-1)).toBe(`${String(shown.length).padStart(6, " ")}\t${lines[shown.length - 1]}`);
  await expect(readFileTool.handler({ path: file, offset: 1, limit: 400 }, ctx(wd)))
    .rejects.toThrow("file content exceeds maximum allowed size (30,000 characters); use offset and limit to read specific sections of the file");
  const part = await readFileTool.handler({ path: file, offset: 1, limit: 200 }, ctx(wd)) as string;
  expect(part.split("\n")).toHaveLength(200);
  expect(part.startsWith("[PARTIAL")).toBe(false);
});

test("readFileTool: a whole-file read cut at its default line count says so too", async () => {
  const wd = tempDir("rf-");
  const file = path.join(wd, "many.txt");
  fs.writeFileSync(file, Array.from({ length: 2500 }, (_, i) => `l${i}`).join("\n"));
  const page = (await readFileTool.handler({ path: file }, ctx(wd)) as string).split("\n");
  expect(page[0]).toBe("[PARTIAL view: lines 1–2,000 of 2,500. Read more with offset and limit.]");
  expect(page).toHaveLength(2001);
});
