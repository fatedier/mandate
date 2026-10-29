import * as fs from "node:fs";

/** The end of a command's output as the model reads it. */
export interface OutputTail {
  text: string;
  shownLines: number;
  totalLines: number;
  bytes: number;
}

interface TailLimits {
  tailMaxLines: number;
  tailMaxBytes: number;
}

/** The end of an output: its last tailMaxBytes, from the first whole line in
 *  them (a line longer than all of them is its end as it is), the last
 *  tailMaxLines of those lines, without the final newline. Invalid UTF-8
 *  reads as U+FFFD. `cut`: the window starts inside a line. */
function tailText(window: Buffer, cut: boolean, limits: TailLimits): { text: string; shownLines: number } {
  let bytes = window;
  if (cut) {
    const firstNewline = bytes.indexOf(10);
    if (firstNewline !== -1 && firstNewline < bytes.length - 1) bytes = bytes.subarray(firstNewline + 1);
  }
  if (bytes.length === 0) return { text: "", shownLines: 0 };
  let text = bytes.toString("utf8");
  if (text.endsWith("\n")) text = text.slice(0, -1);
  const kept = text.split("\n").slice(-limits.tailMaxLines);
  return { text: kept.join("\n"), shownLines: kept.length };
}

/** The end of output held in memory (a command's output so far). */
export function tailOfOutput(output: Buffer, limits: TailLimits): { text: string; shownLines: number } {
  const start = Math.max(0, output.length - limits.tailMaxBytes);
  return tailText(output.subarray(start), start > 0 && output[start - 1] !== 10, limits);
}

/** The end of an output file. `totalLines` when the caller counted them;
 *  else counted here, once, from the file. Null when there is no file. */
export function readOutputTail(file: string | null, limits: TailLimits, totalLines: number | null): OutputTail | null {
  if (!file) return null;
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - limits.tailMaxBytes);
    // One byte before, to tell whether the read begins a line.
    const from = Math.max(0, start - 1);
    const buf = Buffer.alloc(size - from);
    // A short read reads on; a file that ends sooner gives what it has.
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    const read = buf.subarray(0, got);
    const tail = tailText(start > 0 ? read.subarray(1) : read, start > 0 && read[0] !== 10, limits);
    return { ...tail, totalLines: totalLines ?? countLines(fd, size), bytes: size };
  } catch {
    // An output that cannot be read ends nothing: whoever asked goes on without it.
    return null;
  } finally {
    try { fs.closeSync(fd); } catch { /* the read is done */ }
  }
}

/** Newlines in the file, and one more for an unfinished last line. */
function countLines(fd: number, size: number): number {
  const buf = Buffer.alloc(64 * 1024);
  let lines = 0;
  let last = 10;
  for (let at = 0; at < size;) {
    const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - at), at);
    if (n <= 0) break;
    for (let i = buf.indexOf(10); i !== -1 && i < n; i = buf.indexOf(10, i + 1)) lines++;
    last = buf[n - 1]!;
    at += n;
  }
  return lines + (size > 0 && last !== 10 ? 1 : 0);
}
