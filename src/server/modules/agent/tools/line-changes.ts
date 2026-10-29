import { fileLines, lineChangesBetween, type LineChanges } from "../../../../shared/line-diff.js";

/** Above this many line pairs in the part of a file that changed — 2,000
 *  changed lines against 2,000 — counting takes too long (lineChangesBetween),
 *  and the tool reports no line counts. */
const MAX_DIFF_CELLS = 4_000_000;

/** The lines a write or an edit changed in a file, from its text before to
 *  the text it wrote; null when that is too large to count. Counted against
 *  the text as UTF-8 writes it: it has no lone surrogate, and the file gets
 *  U+FFFD in its place. */
export function fileLineChanges(before: string, written: string): LineChanges | null {
  const asWritten = Buffer.from(written, "utf8").toString("utf8");
  return lineChangesBetween(fileLines(before), fileLines(asWritten), MAX_DIFF_CELLS);
}

/** `, +A -D lines` for a tool's result, or nothing when not counted. */
export function lineChangesClause(changes: LineChanges | null): string {
  return changes ? `, +${changes.added} -${changes.removed} lines` : "";
}
