import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import { assertWriteInScope, type AgentScope } from "../tool-scope.js";
import { hasThreadReadFile, markFileRead } from "./read-file.js";
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
    approval: "never",
    handler: async ({ path: p, content }, ctx) => {
      const abs = resolveScopedAbsolutePath(p, ctx.scope);
      if (isDirectory(abs, fileSystem)) throw new Error("path is a directory");
      if (fileSystem.exists(abs) && !hasThreadReadFile(ctx.threadId, abs)) {
        throw new Error(`read must be called before overwriting existing file: ${abs}`);
      }
      fileSystem.mkdirp(path.dirname(abs));
      fileSystem.writeText(abs, content);
      markFileRead(ctx.threadId, abs);
      return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${abs}.`;
    }
  };
}

export const writeFileTool = buildWriteFileTool();

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
