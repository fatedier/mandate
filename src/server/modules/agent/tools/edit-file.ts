import * as path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import { assertWriteInScope, type AgentScope } from "../tool-scope.js";
import { hasThreadReadFile } from "./read-file.js";
import {
  nodeTextFileSystem,
  type TextFileSystem
} from "../../../platform/fs/text-file-system.js";

const params = z.object({
  path: z.string(),
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().optional()
});
type Result = string;

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { count++; i += needle.length; }
  return count;
}

export function buildEditFileTool(
  deps: { fileSystem?: TextFileSystem } = {}
): ToolDefinition<z.infer<typeof params>, Result> {
  const fileSystem = deps.fileSystem ?? nodeTextFileSystem;
  return {
    name: "edit",
    description:
      "Perform exact string replacements in a UTF-8 file inside the current scope. " +
      "The path must be absolute. You must call read on that exact path before editing. " +
      "Do not include read line-number prefixes in oldString or newString. " +
      "By default, oldString must be unique; use replaceAll for file-wide replacement.",
    parameters: params,
    approval: "never",
    handler: async ({ path: p, oldString, newString, replaceAll }, ctx) => {
      const abs = resolveScopedAbsolutePath(p, ctx.scope);
      if (!hasThreadReadFile(ctx.threadId, abs)) {
        throw new Error(`read must be called before editing file: ${abs}`);
      }
      if (oldString.length === 0) throw new Error("oldString is required");
      if (newString === oldString) throw new Error("newString must be different from oldString");

      let original: string;
      try { original = fileSystem.readText(abs); }
      catch (err) { throw new Error((err as Error).message); }

      const matches = countOccurrences(original, oldString);
      if (matches === 0) throw new Error("oldString not found");
      if (!replaceAll && matches > 1) throw new Error("oldString is not unique");

      const updated = replaceAll
        ? original.split(oldString).join(newString)
        : original.replace(oldString, newString);
      try {
        fileSystem.atomicWriteText(abs, updated, ".editfile");
        return `Updated ${abs} (${matches} replacement${matches === 1 ? "" : "s"}).`;
      } catch (err) {
        throw new Error((err as Error).message);
      }
    }
  };
}

export const editFileTool = buildEditFileTool();

function resolveScopedAbsolutePath(
  targetPath: string,
  scope: AgentScope
): string {
  if (!path.isAbsolute(targetPath)) throw new Error(`path must be absolute for edit: ${targetPath}`);
  return assertWriteInScope(targetPath, scope);
}
