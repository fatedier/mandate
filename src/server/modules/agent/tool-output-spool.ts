import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { toolOutputDir, type ResourceOwner } from "../../platform/fs/resources.js";
import { errorText } from "../../../shared/error-text.js";
import { isToolImageResultContent, MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS } from "./wake-message-adapter.js";

/** How much of a result too long to give inline (over
 *  MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS) the model is shown before the path to
 *  the whole. */
const PREVIEW_CHARS = 2_000;

/**
 * Whether a result's text is too long to hand the agent inline, and will be
 * swapped for a preview plus a file path below. Exported so a tool that needs
 * to know what its caller will actually receive asks this module instead of
 * keeping its own copy of the limit.
 */
export function exceedsInlineToolResultLimits(content: string): boolean {
  return content.length > MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS;
}

/** The text the model is sent for a result (wake-message-adapter.ts): a
 *  string as it is, anything else as its JSON; null for an image, which goes
 *  to the model as an image, and for nothing. */
function modelTextOf(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (result === undefined || isToolImageResultContent(result)) return null;
  return JSON.stringify(result) ?? null;
}

/** Cut once, at the call: a result too long for the model is saved whole to
 *  the thread's tool-output folder and replaced by its first characters and
 *  the path, so nothing is lost and no rebuild cuts it again. */
export function maybeSpoolToolResult(input: {
  result: unknown;
  toolName: string;
  toolCallId: string;
  threadId: string;
  wakeId: string;
  owner?: ResourceOwner;
}): unknown {
  const modelText = modelTextOf(input.result);
  if (modelText === null || !exceedsInlineToolResultLimits(modelText)) return input.result;
  // An object is saved indented, so its file reads in pages of lines.
  const content = typeof input.result === "string" ? modelText : JSON.stringify(input.result, null, 2);
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
    const message = errorText(err);
    return [
      "<persisted-output>",
      `Output too large (${formatByteSize(byteLength)}, ${lineCount} lines), and saving the full output failed: ${message}`,
      "",
      `Preview (first ${PREVIEW_CHARS.toLocaleString("en-US")} characters):`,
      content.slice(0, PREVIEW_CHARS),
      "</persisted-output>"
    ].join("\n");
  }
}

/**
 * One way to cut a message body: each place keeps its own
 * length; the whole of a longer text is saved to the reader's tool-output
 * folder, and one line before what is kept says how much it is and where the
 * rest is (every level can read or search that file). A text read again
 * names the same file. Unwritten, the line keeps only its first sentence.
 */
export function cutKeepingWhole(text: string, max: number, at: { threadId: string; owner?: ResourceOwner }): string {
  if (text.length <= max) return text;
  // Never end inside a character written as two code units.
  const end = isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
  const said = `the first ${end.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters`;
  let where: string | null = null;
  try {
    where = writeWhole(text, at);
  } catch {
    // Said without the file: the cut itself is what matters to the reader.
  }
  // The line first: nothing that cuts the text later (a line cap, a preview)
  // drops it.
  return `[Cut: ${said}.${where ? ` The whole text: ${where}` : ""}]\n\n${text.slice(0, end)}`;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Named by what it holds, so the same text cut again is one file, its time
 *  set to that use. It gets that name only once written whole: a write that
 *  fails part way leaves nothing a later cut would take for the whole. */
function writeWhole(text: string, at: { threadId: string; owner?: ResourceOwner }): string {
  const dir = toolOutputDir({ owner: at.owner ?? { kind: "global" }, threadId: at.threadId });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, `cut-${createHash("sha256").update(text).digest("hex").slice(0, 32)}.txt`);
  if (fs.existsSync(filePath)) {
    // Named again: fresh from now for retention (30 days from its last use).
    const now = new Date();
    try {
      fs.utimesSync(filePath, now, now);
    } catch {
      // Still the whole: only its clock stays where it was.
    }
    return filePath;
  }
  const partial = `${filePath}.${randomUUID()}.partial`;
  try {
    fs.writeFileSync(partial, text, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(partial, filePath);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err;
  }
  return filePath;
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
    `Preview (first ${PREVIEW_CHARS.toLocaleString("en-US")} characters):`,
    input.content.slice(0, PREVIEW_CHARS),
    "</persisted-output>"
  ].join("\n");
}

function formatByteSize(size: number): string {
  if (size < 1024) return `${size}B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)}MB`;
  return `${(mb / 1024).toFixed(1)}GB`;
}
