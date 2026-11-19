import * as fs from "node:fs";
import * as path from "node:path";
import { TEXT_PART_BYTES, type FileDto, type FileKind, type FilePart } from "../../../shared/api/files.js";

const BY_EXTENSION: Record<string, FileKind> = {
  ".md": "markdown", ".markdown": "markdown",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".svg": "image",
  ".html": "html", ".htm": "html",
  ".pdf": "pdf"
};
const HEAD_BYTES = 8 * 1024;
const NEWLINE = 0x0a;
const CHUNK = 1024 * 1024;

/** A file's kind: by its extension, else text when its first bytes hold no
 *  NUL and read as UTF-8 (a character cut at the end is not a fault). */
export function fileKindOf(name: string, head: Uint8Array): FileKind {
  const known = BY_EXTENSION[path.extname(name).toLowerCase()];
  if (known) return known;
  if (head.includes(0)) return "other";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
    return "text";
  } catch {
    return "other";
  }
}

/** What the page is sent for a file: its facts, and for a text kind its text,
 *  or a part of it when it is large: the start; the end; or, for a line in
 *  neither, the part around it. Parts are cut at line ends. */
export function readFileDto(input: { requested: string; real: string; stat: fs.Stats }, opts: { part?: "start" | "end"; line?: number } = {}): FileDto {
  const { requested, real, stat } = input;
  const fd = fs.openSync(real, "r");
  try {
    const head = readAt(fd, 0, Math.min(HEAD_BYTES, stat.size));
    const kind = fileKindOf(requested, head);
    const dto: FileDto = {
      path: requested, name: path.basename(requested), folder: path.dirname(requested),
      size: stat.size, modifiedAt: stat.mtime.toISOString(), kind
    };
    if (kind !== "markdown" && kind !== "html" && kind !== "text") return dto;
    if (stat.size <= TEXT_PART_BYTES) return { ...dto, text: decode(readAt(fd, 0, stat.size)) };
    const window = pickWindow(fd, stat.size, opts);
    return { ...dto, text: decode(window.bytes), part: window.part, firstLine: window.firstLine };
  } finally {
    fs.closeSync(fd);
  }
}

interface Window { part: FilePart; bytes: Uint8Array; firstLine: number }

/** The parts of a large text. Lines are counted once at most, and only up to
 *  where they are needed: the reads block the server while they run. */
function pickWindow(fd: number, size: number, opts: { part?: "start" | "end"; line?: number }): Window {
  const start = (): Window => ({ part: "start", bytes: cutToLastNewline(readAt(fd, 0, TEXT_PART_BYTES)), firstLine: 1 });
  // The last part, from its first line start.
  const endFrom = (): { from: number; bytes: Uint8Array } => {
    const from = size - TEXT_PART_BYTES;
    const raw = readAt(fd, from, TEXT_PART_BYTES);
    const skip = raw.indexOf(NEWLINE) + 1;
    return { from: from + skip, bytes: raw.subarray(skip) };
  };
  if (opts.part === "end") {
    const last = endFrom();
    return { part: "end", bytes: last.bytes, firstLine: 1 + countNewlines(fd, 0, last.from) };
  }
  if (opts.part === "start" || opts.line === undefined || !(opts.line >= 1)) return start();
  const line = opts.line;
  const first = start();
  const lineAt = offsetOfLine(fd, size, line);
  if (lineAt === null || lineAt < first.bytes.length) return first;
  // A window starting before the line: its first line's number counted back
  // from the line's, over the bytes between.
  const numbered = (from: number) => line - countNewlines(fd, from, lineAt);
  const last = endFrom();
  if (lineAt >= last.from) return { part: "end", bytes: last.bytes, firstLine: numbered(last.from) };
  // Around: half a part before the line, from the line start after it.
  const from = Math.max(0, lineAt - TEXT_PART_BYTES / 2);
  const raw = readAt(fd, from, TEXT_PART_BYTES);
  const skip = from === 0 ? 0 : raw.indexOf(NEWLINE) + 1;
  return { part: "around", bytes: cutToLastNewline(raw.subarray(skip)), firstLine: numbered(from + skip) };
}

/** The byte offset where a line (from 1) starts; null past the last line. */
function offsetOfLine(fd: number, size: number, line: number): number | null {
  if (line === 1) return 0;
  let seen = 0;
  const buffer = Buffer.allocUnsafe(CHUNK);
  for (let at = 0; at < size;) {
    const read = fs.readSync(fd, buffer, 0, Math.min(CHUNK, size - at), at);
    if (read <= 0) break;
    const chunk = buffer.subarray(0, read);
    for (let i = chunk.indexOf(NEWLINE); i !== -1; i = chunk.indexOf(NEWLINE, i + 1)) {
      seen += 1;
      if (seen === line - 1) return at + i + 1 < size ? at + i + 1 : null;
    }
    at += read;
  }
  return null;
}

/** The newlines in [from, to). */
function countNewlines(fd: number, from: number, to: number): number {
  let count = 0;
  const buffer = Buffer.allocUnsafe(CHUNK);
  for (let at = from; at < to;) {
    const read = fs.readSync(fd, buffer, 0, Math.min(CHUNK, to - at), at);
    if (read <= 0) break;
    const chunk = buffer.subarray(0, read);
    for (let i = chunk.indexOf(NEWLINE); i !== -1; i = chunk.indexOf(NEWLINE, i + 1)) count += 1;
    at += read;
  }
  return count;
}

function cutToLastNewline(bytes: Uint8Array): Uint8Array {
  const last = bytes.lastIndexOf(NEWLINE);
  return last === -1 ? bytes : bytes.subarray(0, last + 1);
}

function readAt(fd: number, position: number, length: number): Uint8Array {
  const buffer = Buffer.alloc(Math.max(0, length));
  const read = fs.readSync(fd, buffer, 0, buffer.length, position);
  return buffer.subarray(0, read);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}
