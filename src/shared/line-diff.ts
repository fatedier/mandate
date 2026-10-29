/** Line diffs, for the server (what a write changed) and the client (an
 *  edit's change, drawn). */

export interface DiffLine {
  kind: " " | "-" | "+";
  text: string;
}

/** What a diff added and removed, in lines. */
export interface LineChanges {
  added: number;
  removed: number;
}

export interface LineDiff {
  lines: DiffLine[];
  /** False when the changed part was too large to align: it is then all its
   *  old lines removed and all its new ones added, which reads back as the
   *  two texts but overstates what changed. */
  aligned: boolean;
}

/** A line diff of two lists of lines: lines both share stay as context, so
 *  only what changed is marked; removals come before additions where a line
 *  was replaced. The lines both lists begin and end with are set aside first
 *  (a longest common subsequence always keeps them), so a small change in a
 *  long file aligns only the part that changed — unless that part is more
 *  than `maxCells` line pairs, which the table below would cost too much to
 *  build for. */
export function diffLines(a: readonly string[], b: readonly string[], maxCells: number): LineDiff {
  const { start, endA, endB } = commonEnds(a, b);
  const n = endA - start;
  const m = endB - start;
  const out: DiffLine[] = a.slice(0, start).map((text) => ({ kind: " " as const, text }));
  const after = a.slice(endA).map((text) => ({ kind: " " as const, text }));
  if (n * m > maxCells) {
    for (const text of a.slice(start, endA)) out.push({ kind: "-", text });
    for (const text of b.slice(start, endB)) out.push({ kind: "+", text });
    return { lines: [...out, ...after], aligned: false };
  }
  // common[i * width + j]: the longest common run of the middle of a from i
  // and of b from j. One flat table, so what it costs is its cells, however
  // long and narrow: a million lines against one is not a million rows.
  const width = m + 1;
  const common = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      common[i * width + j] = a[start + i] === b[start + j]
        ? common[(i + 1) * width + j + 1]! + 1
        : Math.max(common[(i + 1) * width + j]!, common[i * width + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      out.push({ kind: " ", text: a[start + i]! });
      i += 1;
      j += 1;
    } else if (common[(i + 1) * width + j]! >= common[i * width + j + 1]!) {
      out.push({ kind: "-", text: a[start + i]! });
      i += 1;
    } else {
      out.push({ kind: "+", text: b[start + j]! });
      j += 1;
    }
  }
  while (i < n) out.push({ kind: "-", text: a[start + i++]! });
  while (j < m) out.push({ kind: "+", text: b[start + j++]! });
  return { lines: [...out, ...after], aligned: true };
}

/** What a minimal line diff of `a` and `b` adds and removes, without
 *  building it: each side's lines less their longest common subsequence,
 *  whose length needs two rows of the table, not all of it, and no line of
 *  output. So its memory is the shorter side's. Null when the changed middle
 *  is more than `maxCells` line pairs, which bounds the time. */
export function lineChangesBetween(a: readonly string[], b: readonly string[], maxCells: number): LineChanges | null {
  const { start, endA, endB } = commonEnds(a, b);
  const n = endA - start;
  const m = endB - start;
  if (n * m > maxCells) return null;
  // Rows along the longer side, each as long as the shorter: an empty side
  // makes them empty.
  const [long, short, longStart, longLength, shortLength] = n >= m ? [a, b, start, n, m] : [b, a, start, m, n];
  let below = new Uint32Array(shortLength + 1);
  let row = new Uint32Array(shortLength + 1);
  for (let i = longLength - 1; i >= 0; i -= 1) {
    for (let j = shortLength - 1; j >= 0; j -= 1) {
      row[j] = long[longStart + i] === short[start + j] ? below[j + 1]! + 1 : Math.max(below[j]!, row[j + 1]!);
    }
    [below, row] = [row, below];
  }
  const common = below[0]!;
  return { added: m - common, removed: n - common };
}

export function countLineChanges(lines: readonly DiffLine[]): LineChanges {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "+") added += 1;
    else if (line.kind === "-") removed += 1;
  }
  return { added, removed };
}

/** A file's lines, as an editor and `wc -l` count them: a final newline
 *  ends the last line rather than starting another, and an empty file has
 *  none. */
export function fileLines(text: string): string[] {
  if (text === "") return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

/** Where the lines both lists begin and end with stop: the changed middle is
 *  a[start, endA) against b[start, endB). */
function commonEnds(a: readonly string[], b: readonly string[]): { start: number; endA: number; endB: number } {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  return { start, endA, endB };
}
