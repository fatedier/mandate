import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { ToolImageResultContent } from "../../../../shared/agent-message-types.js";
import type { ToolDefinition } from "../tool-registry.js";
import { assertReadInScope, primaryWorkspaceRoot, readScopeRoots, type AgentScope } from "../tool-scope.js";

const params = z.object({
  path: z.string()
});

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SNIFF_BYTES = 16;

type ViewImageResult = ToolImageResultContent;

export function buildViewImageTool(input: {
  supportsImages?: (ctx: { threadId: string; scope: AgentScope }) => boolean;
  supportsToolResultImages?: (ctx: { threadId: string; scope: AgentScope }) => boolean;
} = {}): ToolDefinition<z.infer<typeof params>, ViewImageResult> {
  return {
    name: "view_image",
    description:
      "Inspect an image file inside the current workspace. " +
      "Pass a relative path from the current workspace or an absolute path inside the allowed scope. " +
      "Supports PNG, JPEG, WebP, and GIF up to 5MB.",
    parameters: params,
    approval: "never",
    handler: async ({ path: requestedPath }, ctx) => {
      if (input.supportsImages && !input.supportsImages({ threadId: ctx.threadId, scope: ctx.scope })) {
        throw new Error("current agent model does not support image input");
      }
      if (
        input.supportsToolResultImages &&
        !input.supportsToolResultImages({ threadId: ctx.threadId, scope: ctx.scope })
      ) {
        throw new Error("current agent model path does not support image file viewing");
      }

      const resolved = resolveImagePath(requestedPath, ctx.scope);
      const stat = statFile(resolved.realPath);
      if (stat.isDirectory()) throw new Error("path is a directory");
      if (stat.size <= 0) throw new Error("image file is empty");
      if (stat.size > MAX_IMAGE_BYTES) {
        throw new Error(`image exceeds ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB limit`);
      }

      const header = readHeader(resolved.realPath);
      const mediaType = detectImageMediaType(header);
      if (!mediaType) {
        throw new Error("unsupported image type: expected PNG, JPEG, WebP, or GIF");
      }

      const bytes = fs.readFileSync(resolved.realPath);
      return {
        type: "view_image_result",
        message: `Viewed image: ${resolved.displayPath}`,
        image: {
          type: "image",
          id: `img-${ctx.threadId}-${ctx.wakeId}-${hashPath(resolved.realPath)}`,
          name: path.basename(resolved.realPath),
          displayPath: resolved.displayPath,
          mediaType,
          data: bytes.toString("base64"),
          sizeBytes: bytes.length
        }
      };
    }
  };
}

function resolveImagePath(requestedPath: string, scope: AgentScope): {
  requestedPath: string;
  absolutePath: string;
  realPath: string;
  displayPath: string;
} {
  const trimmed = requestedPath.trim();
  if (!trimmed) throw new Error("path is required");

  const base = primaryWorkspaceRoot(scope);
  const requestedAbsolute = path.isAbsolute(trimmed);
  const absolutePath = requestedAbsolute
    ? path.resolve(trimmed)
    : path.resolve(base, trimmed);
  assertImageReadInScope(absolutePath, scope);

  let realPath: string;
  try {
    realPath = fs.realpathSync(absolutePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`image file does not exist: ${safeDisplayPath(absolutePath, scope)}`);
    }
    throw new Error(`failed to resolve image path: ${(err as Error).message}`);
  }
  assertRealPathInCanonicalScope(realPath, requestedAbsolute
    ? canonicalReadRoots(scope)
    : canonicalWorkspaceRoots(scope));

  return {
    requestedPath: trimmed,
    absolutePath,
    realPath,
    displayPath: safeDisplayPath(realPath, scope)
  };
}

function assertImageReadInScope(targetPath: string, scope: AgentScope): string {
  try {
    return assertReadInScope(targetPath, scope);
  } catch {
    throw new Error("image path is outside the current workspace scope");
  }
}

function assertRealPathInCanonicalScope(realPath: string, canonicalRoots: string[]): string {
  if (isInsideAny(path.resolve(realPath), canonicalRoots)) return realPath;
  throw new Error("image path is outside the current workspace scope");
}

function canonicalReadRoots(scope: AgentScope): string[] {
  const roots = readScopeRoots(scope);
  const canonical: string[] = [];
  for (const root of roots) {
    const resolved = path.resolve(root);
    canonical.push(resolved);
    try {
      canonical.push(fs.realpathSync(resolved));
    } catch {
      // Missing roots are still represented by their lexical path for the initial scope check.
    }
  }
  return uniqueRoots(canonical);
}

function canonicalWorkspaceRoots(scope: AgentScope): string[] {
  const roots = displayRoots(scope);
  const canonical: string[] = [];
  for (const root of roots) {
    const resolved = path.resolve(root);
    canonical.push(resolved);
    try {
      canonical.push(fs.realpathSync(resolved));
    } catch {
      // Missing roots are still represented by their lexical path for the initial scope check.
    }
  }
  return uniqueRoots(canonical);
}

function isInsideAny(abs: string, roots: string[]): boolean {
  for (const root of roots) {
    const r = path.resolve(root);
    if (abs === r || abs.startsWith(r + path.sep)) return true;
  }
  return false;
}

function statFile(filePath: string): fs.Stats {
  try {
    return fs.statSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`image file does not exist: ${path.basename(filePath)}`);
    }
    throw new Error(`failed to stat image file: ${(err as Error).message}`);
  }
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

function detectImageMediaType(header: Buffer): string | null {
  if (
    header.length >= 8 &&
    header[0] === 0x89 &&
    header.subarray(1, 4).toString("ascii") === "PNG" &&
    header[4] === 0x0d &&
    header[5] === 0x0a &&
    header[6] === 0x1a &&
    header[7] === 0x0a
  ) {
    return "image/png";
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "image/jpeg";
  }
  const gif = header.subarray(0, 6).toString("ascii");
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  if (
    header.length >= 12 &&
    header.subarray(0, 4).toString("ascii") === "RIFF" &&
    header.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function safeDisplayPath(filePath: string, scope: AgentScope): string {
  const roots = displayRoots(scope);
  const abs = path.resolve(filePath);
  for (const root of roots) {
    const rel = path.relative(root, abs);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
    if (rel === "") return ".";
  }
  return path.basename(abs);
}

function displayRoots(scope: AgentScope): string[] {
  if (scope.kind === "worker") {
    return uniqueRoots([
      scope.feature.workingDir || "",
      scope.project.workingDir
    ].filter(Boolean));
  }
  return uniqueRoots([scope.managerDir, ...scope.projectWorkingDirs]);
}

function uniqueRoots(roots: string[]): string[] {
  return Array.from(new Set(roots.map((root) => path.resolve(root))));
}

function hashPath(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

export const VIEW_IMAGE_MAX_IMAGE_BYTES = MAX_IMAGE_BYTES;
