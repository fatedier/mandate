import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { toolOutputDir, type ResourceOwner } from "../../platform/fs/resources.js";

const MAX_INLINE_BYTES = 64 * 1024;
const MAX_INLINE_LINES = 2000;
const PREVIEW_BYTES = 4 * 1024;

/**
 * Whether a string result is too big to hand the agent inline, and will be
 * swapped for a preview plus a file path below. Exported so a tool that needs
 * to know what its caller will actually receive asks this module instead of
 * keeping its own copy of the thresholds.
 */
export function exceedsInlineToolResultLimits(content: string): boolean {
  return Buffer.byteLength(content, "utf8") > MAX_INLINE_BYTES
    || content.split("\n").length > MAX_INLINE_LINES;
}

export function maybeSpoolToolResult(input: {
  result: unknown;
  toolName: string;
  toolCallId: string;
  threadId: string;
  wakeId: string;
  owner?: ResourceOwner;
}): unknown {
  if (typeof input.result !== "string") return input.result;
  const content = input.result;
  if (!exceedsInlineToolResultLimits(content)) return content;
  const byteLength = Buffer.byteLength(content, "utf8");
  const lineCount = content.split("\n").length;

  try {
    const outputPath = writeToolOutput({ ...input, result: content });
    return formatPersistedOutput({
      byteLength,
      lineCount,
      outputPath,
      content
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [
      "<persisted-output>",
      `Output too large (${formatByteSize(byteLength)}, ${lineCount} lines), and saving the full output failed: ${message}`,
      "",
      `Preview (first ${formatByteSize(PREVIEW_BYTES)}):`,
      previewText(content),
      "</persisted-output>"
    ].join("\n");
  }
}

function writeToolOutput(input: {
  result: string;
  toolName: string;
  threadId: string;
  owner?: ResourceOwner;
}): string {
  const dir = toolOutputDir({
    owner: input.owner ?? { kind: "global" },
    threadId: input.threadId
  });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, `${randomUUID()}.txt`);
  fs.writeFileSync(filePath, input.result, { encoding: "utf8", mode: 0o600 });
  return filePath;
}

function formatPersistedOutput(input: {
  byteLength: number;
  lineCount: number;
  outputPath: string;
  content: string;
}): string {
  return [
    "<persisted-output>",
    `Output too large (${formatByteSize(input.byteLength)}, ${input.lineCount} lines). Full output saved to:`,
    input.outputPath,
    "",
    "Use read with this path plus offset/limit to inspect more.",
    "",
    `Preview (first ${formatByteSize(PREVIEW_BYTES)}):`,
    previewText(input.content),
    "</persisted-output>"
  ].join("\n");
}

function previewText(content: string): string {
  if (Buffer.byteLength(content, "utf8") <= PREVIEW_BYTES) return content;
  return Buffer.from(content, "utf8").subarray(0, PREVIEW_BYTES).toString("utf8");
}

function formatByteSize(size: number): string {
  if (size < 1024) return `${size}B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)}MB`;
  return `${(mb / 1024).toFixed(1)}GB`;
}
