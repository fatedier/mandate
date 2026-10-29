import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { editFileTool } from "../src/server/modules/agent/tools/edit-file.js";
import { readFileTool } from "../src/server/modules/agent/tools/read-file.js";
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

test("editFileTool: rejects when oldString not found", async () => {
  const wd = tempDir("ef-");
  const f = path.join(wd, "x.txt");
  fs.writeFileSync(f, "hello");
  const context = ctx(wd);
  await readFileTool.handler({ path: f }, context);
  await expect(editFileTool.handler({ path: f, oldString: "missing", newString: "x" }, context))
    .rejects.toThrow(/not found/i);
});

test("editFileTool: rejects when oldString matches multiple times", async () => {
  const wd = tempDir("ef-");
  const f = path.join(wd, "x.txt");
  fs.writeFileSync(f, "a a a");
  const context = ctx(wd);
  await readFileTool.handler({ path: f }, context);
  await expect(editFileTool.handler({ path: f, oldString: "a", newString: "b" }, context))
    .rejects.toThrow(/not unique/i);
});

test("editFileTool: supports replaceAll", async () => {
  const wd = tempDir("ef-");
  const f = path.join(wd, "x.txt");
  fs.writeFileSync(f, "a a a");
  const context = ctx(wd);
  await readFileTool.handler({ path: f }, context);
  const r = await editFileTool.handler(
    { path: f, oldString: "a", newString: "b", replaceAll: true },
    context
  );
  // Three places on one line: one line changed.
  expect(r).toBe(`Updated ${f} (3 replacements, +1 -1 lines).`);
  expect(fs.readFileSync(f, "utf8")).toBe("b b b");
});

test("editFileTool: requires read first", async () => {
  const wd = tempDir("ef-");
  const f = path.join(wd, "x.txt");
  fs.writeFileSync(f, "before");
  await expect(editFileTool.handler({ path: f, oldString: "before", newString: "after" }, ctx(wd)))
    .rejects.toThrow(/read must be called/i);
});

test("editFileTool: writes atomically (no leftover tmp file on success)", async () => {
  const wd = tempDir("ef-");
  const f = path.join(wd, "x.txt");
  fs.writeFileSync(f, "before");
  const context = ctx(wd);
  await readFileTool.handler({ path: f }, context);
  await editFileTool.handler({ path: f, oldString: "before", newString: "after" }, context);
  expect(fs.readFileSync(f, "utf8")).toBe("after");
  const leftover = fs.readdirSync(wd).filter((n) => n.includes("tmp") || n.endsWith("~"));
  expect(leftover.length).toBe(0);
});

test("editFileTool: counts the lines it changed in the file, not in its own old and new text", async () => {
  const wd = tempDir("ef-");
  const context = ctx(wd);
  const cases: Array<[string, string, string, string, string]> = [
    // Joining two lines: the fragment alone ("\n" -> "") reads as one line removed.
    ["a\nb", "\n", "", "ab", "+1 -2"],
    // Splitting one.
    ["ab\n", "a", "a\n", "a\nb\n", "+2 -1"],
    // Whole lines dropped from the top of the fragment.
    ["x\n  \"userKey\": 1,\n  \"clientID\": 2,\ny\n", "  \"userKey\": 1,\n  \"clientID\": 2,", "  \"clientID\": 2,", "x\n  \"clientID\": 2,\ny\n", "+0 -1"],
    // Every place, each on its own line.
    ["a\nb\na\n", "a", "c", "c\nb\nc\n", "+2 -2"]
  ];
  for (const [index, [before, oldString, newString, after, counts]] of cases.entries()) {
    const f = path.join(wd, `case-${index}.txt`);
    fs.writeFileSync(f, before);
    await readFileTool.handler({ path: f }, context);
    const places = before.split(oldString).length - 1;
    const r = await editFileTool.handler({ path: f, oldString, newString, replaceAll: places > 1 }, context);
    expect(fs.readFileSync(f, "utf8")).toBe(after);
    expect(r).toBe(`Updated ${f} (${places} replacement${places === 1 ? "" : "s"}, ${counts} lines).`);
  }
});

test("editFileTool: writes the new text as it is, however many $ patterns it holds", async () => {
  const wd = tempDir("ef-");
  const f = path.join(wd, "x.html");
  fs.writeFileSync(f, "<td>go test -run X</td>\n<td>after</td>\n");
  const context = ctx(wd);
  await readFileTool.handler({ path: f }, context);
  const newString = "go test -run '^$' && echo $& $` $$";
  await editFileTool.handler({ path: f, oldString: "go test -run X", newString }, context);
  expect(fs.readFileSync(f, "utf8")).toBe(`<td>${newString}</td>\n<td>after</td>\n`);
});
