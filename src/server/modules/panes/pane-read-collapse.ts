export interface PaneCollapseResult {
  text: string;
  collapsedLines: number;
  hasNew: boolean;
}

/** Non-blank, right-trimmed lines. The unit of "have I already shown this?". */
export function paneLineSet(text: string): Set<string> {
  return new Set(
    text
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
  );
}

/**
 * Drop the leading run of lines the caller was already shown, keeping the rest
 * verbatim so the agent always sees a contiguous, current tail of the pane.
 * A redraw breaks the run immediately and degrades to returning everything.
 */
export function collapseSeenPrefix(
  current: string,
  seen: Set<string> | null,
  opts: { paneId: string }
): PaneCollapseResult {
  if (!seen || seen.size === 0) {
    return { text: current, collapsedLines: 0, hasNew: true };
  }

  // Match on the trimmed form, but emit the raw one: trailing whitespace must
  // not defeat a match, and must not be edited out of the tail we hand back.
  const rawLines = current.split("\n");
  const trimmedLines = rawLines.map((line) => line.trimEnd());
  let cut = 0;
  let collapsed = 0;
  for (const [i, line] of trimmedLines.entries()) {
    if (line.length === 0) {
      // Blank lines ride along with the run without being counted, including the
      // blanks that sit between the last seen line and the first new one. Those
      // trailing blanks are cut from the output but are not in `collapsedLines`,
      // so the returned text is not the input minus exactly `collapsedLines`
      // lines: don't use the marker's count to index back into the capture.
      cut = i + 1;
      continue;
    }
    if (!seen.has(line)) break;
    collapsed++;
    cut = i + 1;
  }

  if (collapsed === 0) {
    return { text: current, collapsedLines: 0, hasNew: true };
  }

  if (!trimmedLines.slice(cut).some((line) => line.length > 0)) {
    return {
      text: `no new output in ${opts.paneId} since your last read (${lineCount(collapsed)} unchanged)`,
      collapsedLines: collapsed,
      hasNew: false
    };
  }

  return {
    text: [
      `… ${lineCount(collapsed)} unchanged since your last read of this pane`,
      ...rawLines.slice(cut)
    ].join("\n"),
    collapsedLines: collapsed,
    hasNew: true
  };
}

function lineCount(n: number): string {
  return n === 1 ? "1 line" : `${n} lines`;
}
