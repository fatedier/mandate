import { expect, test } from "bun:test";
import path from "node:path";
import { buildEditFileTool } from "../src/server/modules/agent/tools/edit-file.js";
import { buildReadFileTool } from "../src/server/modules/agent/tools/read-file.js";
import { buildWriteFileTool } from "../src/server/modules/agent/tools/write-file.js";
import type { TextFileSystem } from "../src/server/platform/fs/text-file-system.js";

class MemoryTextFileSystem implements TextFileSystem {
  files = new Map<string, string>();
  dirs = new Set<string>();

  exists(filePath: string): boolean {
    return this.files.has(path.resolve(filePath));
  }

  readText(filePath: string): string {
    const abs = path.resolve(filePath);
    const value = this.files.get(abs);
    if (value === undefined) throw new Error(`ENOENT: no such file, open '${abs}'`);
    return value;
  }

  writeText(filePath: string, contents: string): void {
    this.files.set(path.resolve(filePath), contents);
  }

  mkdirp(dirPath: string): void {
    this.dirs.add(path.resolve(dirPath));
  }

  atomicWriteText(filePath: string, contents: string): void {
    this.writeText(filePath, contents);
  }

  removeFile(filePath: string): void {
    this.files.delete(path.resolve(filePath));
  }
}

function ctx(workingDir: string) {
  return {
    threadId: "t",
    wakeId: "w",
    scope: {
      kind: "worker" as const,
      feature: { id: "f", workingDir } as any,
      project: { workingDir } as any
    }
  } as any;
}

test("agent file tools can use an injected text file system", async () => {
  const fileSystem = new MemoryTextFileSystem();
  const workingDir = "/tmp/mandate-tool-fs";
  const target = path.join(workingDir, "notes.txt");

  const writeTool = buildWriteFileTool({ fileSystem });
  const readTool = buildReadFileTool({ fileSystem });
  const editTool = buildEditFileTool({ fileSystem });

  const context = ctx(workingDir);
  expect(await writeTool.handler({ path: target, content: "alpha beta" }, context))
    .toBe(`Wrote 10 bytes to ${target}.`);
  expect(fileSystem.dirs.has(workingDir)).toBe(true);
  expect(await readTool.handler({ path: target }, context))
    .toBe("     1\talpha beta");
  expect(await editTool.handler({ path: target, oldString: "beta", newString: "gamma" }, context))
    .toBe(`Updated ${target} (1 replacement).`);
  expect(fileSystem.files.get(target)).toBe("alpha gamma");
});
