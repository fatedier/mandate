export interface DiffLine {
  kind: "add" | "del" | "context";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

// Pairs deletion runs with the addition run that follows them, so a changed
// line renders as old|new on one row; leftovers keep the other side empty.
export function buildSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];

  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      rows.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    }
    dels = [];
    adds = [];
  };

  for (const line of lines) {
    if (line.kind === "del") dels.push(line);
    else if (line.kind === "add") adds.push(line);
    else {
      flush();
      rows.push({ left: line, right: line });
    }
  }
  flush();
  return rows;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedDiff(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of patch.split("\n")) {
    const m = HUNK_RE.exec(raw);
    if (m) {
      current = { header: raw, lines: [] };
      hunks.push(current);
      oldNo = Number.parseInt(m[1] ?? "1", 10);
      newNo = Number.parseInt(m[2] ?? "1", 10);
      continue;
    }
    if (!current) continue; // file headers, index lines, binary notices
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("+")) {
      current.lines.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ });
    } else if (raw.startsWith("-")) {
      current.lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null });
    } else if (raw.startsWith(" ") || raw === "") {
      // empty strings are split artifacts (trailing newline), not context
      // rows — git emits empty context lines as a single space
      if (raw === "") continue;
      current.lines.push({ kind: "context", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return hunks;
}
