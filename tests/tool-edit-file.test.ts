import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { editFileTool } from "../src/server/modules/agent/tools/edit-file.js";
import { readFileTool } from "../src/server/modules/agent/tools/read-file.js";

function ctx(wd: string) {
  return { threadId: "t", wakeId: "w",
           scope: {
             kind: "worker" as const,
             feature: { id: "f", workingDir: wd } as any,
             project: { workingDir: wd } as any
           } } as any;
}

test("editFileTool: replaces unique match", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "ef-"));
  const f = path.join(wd, "x.txt");
  fs.writeFileSync(f, "alpha beta gamma");
  const context = ctx(wd);
  await readFileTool.handler({ path: f }, context);
  const r = await editFileTool.handler({ path: f, oldString: "beta", newString: "BETA" }, context);
  expect(r).toBe(`Updated ${f} (1 replacement).`);
  expect(fs.readFileSync(f, "utf8")).toBe("alpha BETA gamma");
  fs.rmSync(wd, { recursive: true, force: true });
});

test("editFileTool: rejects when oldString not found", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "ef-"));
  const f = path.join(wd, "x.txt");
  fs.writeFileSync(f, "hello");
  const context = ctx(wd);
  await readFileTool.handler({ path: f }, context);
  await expect(editFileTool.handler({ path: f, oldString: "missing", newString: "x" }, context))
    .rejects.toThrow(/not found/i);
  fs.rmSync(wd, { recursive: true, force: true });
});

test("editFileTool: rejects when oldString matches multiple times", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "ef-"));
  const f = path.join(wd, "x.txt");
  fs.writeFileSync(f, "a a a");
  const context = ctx(wd);
  await readFileTool.handler({ path: f }, context);
  await expect(editFileTool.handler({ path: f, oldString: "a", newString: "b" }, context))
    .rejects.toThrow(/not unique/i);
  fs.rmSync(wd, { recursive: true, force: true });
});

test("editFileTool: supports replaceAll", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "ef-"));
  const f = path.join(wd, "x.txt");
  fs.writeFileSync(f, "a a a");
  const context = ctx(wd);
  await readFileTool.handler({ path: f }, context);
  const r = await editFileTool.handler(
    { path: f, oldString: "a", newString: "b", replaceAll: true },
    context
  );
  expect(r).toBe(`Updated ${f} (3 replacements).`);
  expect(fs.readFileSync(f, "utf8")).toBe("b b b");
  fs.rmSync(wd, { recursive: true, force: true });
});

test("editFileTool: requires read first", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "ef-"));
  const f = path.join(wd, "x.txt");
  fs.writeFileSync(f, "before");
  await expect(editFileTool.handler({ path: f, oldString: "before", newString: "after" }, ctx(wd)))
    .rejects.toThrow(/read must be called/i);
  fs.rmSync(wd, { recursive: true, force: true });
});

test("editFileTool: writes atomically (no leftover tmp file on success)", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "ef-"));
  const f = path.join(wd, "x.txt");
  fs.writeFileSync(f, "before");
  const context = ctx(wd);
  await readFileTool.handler({ path: f }, context);
  await editFileTool.handler({ path: f, oldString: "before", newString: "after" }, context);
  expect(fs.readFileSync(f, "utf8")).toBe("after");
  const leftover = fs.readdirSync(wd).filter((n) => n.includes("tmp") || n.endsWith("~"));
  expect(leftover.length).toBe(0);
  fs.rmSync(wd, { recursive: true, force: true });
});
