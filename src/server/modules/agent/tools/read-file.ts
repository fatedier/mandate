import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import { assertReadInScope, type AgentScope } from "../tool-scope.js";
import {
  nodeTextFileSystem,
  type TextFileSystem
} from "../../../platform/fs/text-file-system.js";

const DEFAULT_MAX_LINES = 2000;
const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_READ_BYTES = 50 * 1024;
const SNIFF_BYTES = 4096;

const params = z.object({
  path: z.string(),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(MAX_LINES).optional()
});

type Result = string;

const readFilesByThread = new Map<string, Set<string>>();

export function markFileRead(threadId: string, filePath: string): void {
  const key = path.resolve(filePath);
  let files = readFilesByThread.get(threadId);
  if (!files) {
    files = new Set();
    readFilesByThread.set(threadId, files);
  }
  files.add(key);
}

export function hasThreadReadFile(threadId: string, filePath: string): boolean {
  return readFilesByThread.get(threadId)?.has(path.resolve(filePath)) ?? false;
}

export function buildReadFileTool(
  deps: { fileSystem?: TextFileSystem } = {}
): ToolDefinition<z.infer<typeof params>, Result> {
  const fileSystem = deps.fileSystem ?? nodeTextFileSystem;
  return {
    name: "read",
    description:
      "Read a UTF-8 file inside the current scope. The path must be absolute. " +
      "Returns text in cat -n style with 1-based line numbers. " +
      "By default, reads up to 2000 lines from the start. Use optional 1-based offset " +
      "and line limit for long files. Lines longer than 2000 characters are truncated. " +
      "PDFs and binary files are rejected.",
    parameters: params,
    approval: "never",
    handler: async ({ path: p, offset, limit }, ctx) => {
      const abs = resolveScopedAbsolutePath(p, ctx.scope, "read");
      const contents = readTextTarget(abs, fileSystem);
      if (contents === null) return "File does not exist.";
      markFileRead(ctx.threadId, abs);
      if (contents.length === 0) {
        return "<system-reminder>Warning: the file exists but is empty.</system-reminder>";
      }
      return formatReadLines(contents, offset, limit);
    }
  };
}

export const readFileTool = buildReadFileTool();

function resolveScopedAbsolutePath(
  targetPath: string,
  scope: AgentScope,
  action: string
): string {
  if (!path.isAbsolute(targetPath)) throw new Error(`path must be absolute for ${action}: ${targetPath}`);
  return assertReadInScope(targetPath, scope);
}

function readTextTarget(filePath: string, fileSystem: TextFileSystem): string | null {
  if (fileSystem === nodeTextFileSystem) return readNodeTextTarget(filePath);
  try {
    return fileSystem.readText(filePath);
  } catch (err) {
    const message = (err as Error).message;
    if (/enoent|no such file/i.test(message)) return null;
    throw err;
  }
}

function readNodeTextTarget(filePath: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`failed to stat file: ${(err as Error).message}`);
  }
  if (stat.isDirectory()) throw new Error("path is a directory");

  const header = readHeader(filePath);
  if (isPdf(header)) throw new Error("file appears to be a PDF, read supports text files only");
  if (isLikelyBinary(filePath, header)) {
    throw new Error("file appears to be a binary file, read supports text files only");
  }
  return fs.readFileSync(filePath, "utf8");
}

function readHeader(filePath: string): Buffer {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const read = fs.readSync(fd, buffer, 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function isPdf(header: Buffer): boolean {
  return header.subarray(0, 4).toString("ascii") === "%PDF";
}

function isLikelyBinary(filePath: string, header: Buffer): boolean {
  if (hasBinaryExtension(filePath)) return true;
  return header.includes(0);
}

function hasBinaryExtension(filePath: string): boolean {
  switch (path.extname(filePath).toLowerCase()) {
    case ".zip":
    case ".tar":
    case ".gz":
    case ".exe":
    case ".dll":
    case ".so":
    case ".class":
    case ".jar":
    case ".war":
    case ".7z":
    case ".doc":
    case ".docx":
    case ".xls":
    case ".xlsx":
    case ".ppt":
    case ".pptx":
    case ".bin":
    case ".dat":
    case ".obj":
    case ".o":
    case ".a":
    case ".lib":
    case ".wasm":
    case ".pyc":
    case ".pyo":
      return true;
    default:
      return false;
  }
}

function formatReadLines(contents: string, offset: number | undefined, limit: number | undefined): string {
  const start = Math.max((offset ?? 1) - 1, 0);
  const lineLimit = limit ?? DEFAULT_MAX_LINES;
  const lines = contents.split("\n");
  const end = Math.min(start + lineLimit, lines.length);
  const selected: string[] = [];
  let bytes = 0;

  for (let index = start; index < end; index++) {
    const rawLine = lines[index] ?? "";
    const line = rawLine.length > MAX_LINE_CHARS ? rawLine.slice(0, MAX_LINE_CHARS) : rawLine;
    const numbered = `${String(index + 1).padStart(6, " ")}\t${line}`;
    const nextBytes = Buffer.byteLength(numbered, "utf8") + (selected.length > 0 ? 1 : 0);
    if (bytes + nextBytes > MAX_READ_BYTES) {
      throw new Error(
        `file content exceeds maximum allowed size (${MAX_READ_BYTES} bytes); ` +
        "use offset and limit to read specific sections of the file"
      );
    }
    selected.push(numbered);
    bytes += nextBytes;
  }

  return selected.join("\n");
}
