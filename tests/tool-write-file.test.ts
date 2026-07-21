import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readFileTool } from "../src/server/modules/agent/tools/read-file.js";
import { writeFileTool } from "../src/server/modules/agent/tools/write-file.js";

function ctx(wd: string) {
  return { threadId: "t", wakeId: "w",
           scope: {
             kind: "worker" as const,
             feature: { id: "f", workingDir: wd } as any,
             project: { workingDir: wd } as any
           } } as any;
}

test("writeFileTool: creates new file", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "wf-"));
  const target = path.join(wd, "new.txt");
  const r = await writeFileTool.handler({ path: target, content: "hello" }, ctx(wd));
  expect(r).toBe(`Wrote 5 bytes to ${target}.`);
  expect(fs.readFileSync(target, "utf8")).toBe("hello");
  fs.rmSync(wd, { recursive: true, force: true });
});

test("writeFileTool: can overwrite a file it created", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "wf-"));
  const target = path.join(wd, "new.txt");
  const context = ctx(wd);
  await writeFileTool.handler({ path: target, content: "hello" }, context);
  const r = await writeFileTool.handler({ path: target, content: "updated" }, context);
  expect(r).toBe(`Wrote 7 bytes to ${target}.`);
  expect(fs.readFileSync(target, "utf8")).toBe("updated");
  fs.rmSync(wd, { recursive: true, force: true });
});

test("writeFileTool: requires read before overwriting", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "wf-"));
  const target = path.join(wd, "exists.txt");
  fs.writeFileSync(target, "old");
  await expect(writeFileTool.handler({ path: target, content: "new" }, ctx(wd)))
    .rejects.toThrow(/read must be called/i);
  expect(fs.readFileSync(target, "utf8")).toBe("old");
  fs.rmSync(wd, { recursive: true, force: true });
});

test("writeFileTool: overwrites after read", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "wf-"));
  const target = path.join(wd, "exists.txt");
  fs.writeFileSync(target, "old");
  const context = ctx(wd);
  await readFileTool.handler({ path: target }, context);
  const r = await writeFileTool.handler({ path: target, content: "new" }, context);
  expect(r).toBe(`Wrote 3 bytes to ${target}.`);
  expect(fs.readFileSync(target, "utf8")).toBe("new");
  fs.rmSync(wd, { recursive: true, force: true });
});

test("writeFileTool: rejects path outside scope", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "wf-"));
  await expect(writeFileTool.handler({
    path: path.join(path.parse(os.tmpdir()).root, "__mandate_disallowed__", "outside.txt"),
    content: "x"
  }, ctx(wd))).rejects.toThrow(/scope/i);
  fs.rmSync(wd, { recursive: true, force: true });
});
