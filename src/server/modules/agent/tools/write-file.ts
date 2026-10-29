import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import { assertWriteInScope, type AgentScope } from "../tool-scope.js";
import { hasThreadReadFile, markFileRead } from "./read-file.js";
import { fileLines, type LineChanges } from "../../../../shared/line-diff.js";
import { fileLineChanges, lineChangesClause } from "./line-changes.js";
import {
  nodeTextFileSystem,
  type TextFileSystem
} from "../../../platform/fs/text-file-system.js";

const params = z.object({
  path: z.string(),
  content: z.string()
});
type Result = string;

export function buildWriteFileTool(
  deps: { fileSystem?: TextFileSystem } = {}
): ToolDefinition<z.infer<typeof params>, Result> {
  const fileSystem = deps.fileSystem ?? nodeTextFileSystem;
  return {
    name: "write",
    description:
      "Write a UTF-8 file inside the current scope. The path must be absolute. " +
      "This tool overwrites existing files. If the file already exists, you must " +
      "call read on that exact path first. Prefer edit for existing files.",
    parameters: params,
    handler: async ({ path: p, content }, ctx) => {
      const abs = resolveScopedAbsolutePath(p, ctx.scope);
      if (isDirectory(abs, fileSystem)) throw new Error("path is a directory");
      const existed = fileSystem.exists(abs);
      if (existed && !hasThreadReadFile(ctx.threadId, abs)) {
        throw new Error(`read must be called before overwriting existing file: ${abs}`);
      }
      const changes = existed ? changesFrom(abs, content, fileSystem) : null;
      fileSystem.mkdirp(path.dirname(abs));
      fileSystem.writeText(abs, content);
      markFileRead(ctx.threadId, abs);
      return writeSummary(abs, content, existed, changes);
    }
  };
}

export const writeFileTool = buildWriteFileTool();

/** What overwriting a file with `content` changes, in lines; null when the
 *  old text cannot be read, or the change is too large to align. Never
 *  fails the write. */
function changesFrom(filePath: string, content: string, fileSystem: TextFileSystem): LineChanges | null {
  let before: string;
  try {
    before = fileSystem.readText(filePath);
  } catch {
    return null;
  }
  return fileLineChanges(before, content);
}

/** The result text, which the chat also reads (tool-details/parse.ts
 *  writeResult): a new file, `Created <path> (N bytes, M lines).`; an
 *  existing one, `Overwrote <path> (N bytes, +A -D lines).`, without the
 *  lines when they could not be counted. */
export function writeSummary(filePath: string, content: string, existed: boolean, changes: LineChanges | null): string {
  const bytes = plural(Buffer.byteLength(content, "utf8"), "byte");
  if (!existed) return `Created ${filePath} (${bytes}, ${plural(fileLines(content).length, "line")}).`;
  return `Overwrote ${filePath} (${bytes}${lineChangesClause(changes)}).`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function resolveScopedAbsolutePath(
  targetPath: string,
  scope: AgentScope
): string {
  if (!path.isAbsolute(targetPath)) throw new Error(`path must be absolute for write: ${targetPath}`);
  return assertWriteInScope(targetPath, scope);
}

function isDirectory(filePath: string, fileSystem: TextFileSystem): boolean {
  if (fileSystem !== nodeTextFileSystem) return false;
  try {
    return fs.statSync(filePath).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`failed to stat file: ${(err as Error).message}`);
  }
}
