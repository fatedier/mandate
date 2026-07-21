import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readFileTool } from "../src/server/modules/agent/tools/read-file.js";

function ctx(workingDir: string) {
  return {
    threadId: "t", wakeId: "w",
    scope: {
      kind: "worker" as const,
      feature: { id: "f", workingDir } as any,
      project: { workingDir } as any
    }
  } as any;
}

test("readFileTool: returns contents for file inside scope", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "rf-"));
  fs.writeFileSync(path.join(wd, "hello.txt"), "hi there");
  const r = await readFileTool.handler({ path: path.join(wd, "hello.txt") }, ctx(wd));
  expect(r).toBe("     1\thi there");
  fs.rmSync(wd, { recursive: true, force: true });
});

test("readFileTool: rejects path outside scope", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "rf-"));
  await expect(readFileTool.handler({ path: "/etc/passwd" }, ctx(wd)))
    .rejects.toThrow(/outside.*scope/i);
  fs.rmSync(wd, { recursive: true, force: true });
});

test("readFileTool: returns error for missing file", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "rf-"));
  const r = await readFileTool.handler({ path: path.join(wd, "nope.txt") }, ctx(wd));
  expect(r).toBe("File does not exist.");
  fs.rmSync(wd, { recursive: true, force: true });
});

test("readFileTool: reads a line range with offset and limit", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "rf-"));
  fs.writeFileSync(path.join(wd, "lines.txt"), "one\ntwo\nthree\nfour");
  const r = await readFileTool.handler(
    { path: path.join(wd, "lines.txt"), offset: 2, limit: 2 },
    ctx(wd)
  );
  expect(r).toBe("     2\ttwo\n     3\tthree");
  fs.rmSync(wd, { recursive: true, force: true });
});

test("readFileTool: rejects relative paths", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "rf-"));
  await expect(readFileTool.handler({ path: "hello.txt" }, ctx(wd)))
    .rejects.toThrow(/absolute/i);
  fs.rmSync(wd, { recursive: true, force: true });
});
