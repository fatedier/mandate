import { buildSplitRows, type DiffHunk, type DiffLine } from "@/lib/diff-parse";

function sideClasses(line: DiffLine | null): string {
  if (line === null) return "bg-surface-2";
  if (line.kind === "add") return "bg-diff-add-bg text-diff-add-fg";
  if (line.kind === "del") return "bg-diff-del-bg text-diff-del-fg";
  return "text-foreground";
}

function Side({ line, no, divider }: { line: DiffLine | null; no: number | null; divider?: boolean }) {
  const classes = sideClasses(line);
  return (
    <>
      <td
        className={`w-10 pr-2 text-right text-faint select-none align-top ${
          divider ? "border-l border-border-soft " : ""
        }${classes}`}
      >
        {no ?? ""}
      </td>
      <td className={`w-[calc(50%-2.5rem)] whitespace-pre-wrap break-all px-2 align-top ${classes}`}>
        {line?.text ?? ""}
      </td>
    </>
  );
}

/** Unified row: one gutter, then a sign column, then the code. The sign is not
 *  redundant with the background colour — it is the only cue a colour-blind
 *  reader gets. It stays `select-none` on purpose: copying a range out of the
 *  diff should yield clean code, not lines prefixed with +/-. */
function UnifiedLine({ line }: { line: DiffLine }) {
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
  return (
    <div data-slot="diff-line" className={`flex ${sideClasses(line)}`}>
      {/* `w-10`, matching the split path — do not tighten to `w-9`. At
          `text-xs` (13px) a monospace digit is 7.83px, so a 4-digit line
          number needs 31.3px; `w-10` (40px) less `pr-2` (8px) leaves 32px,
          `w-9` would leave 28px. Because the number is `text-right`, the
          overflow goes left of x=0, where horizontal scrolling cannot reach
          it — a file past line 999 would silently shear its leading digit. */}
      <span className="w-10 shrink-0 pr-2 text-right text-faint select-none">
        {line.newNo ?? line.oldNo ?? ""}
      </span>
      <span className="w-3 shrink-0 select-none">{sign}</span>
      <span className="pr-3">{line.text}</span>
    </div>
  );
}

export function DiffHunkView({ hunks, unified = false }: { hunks: DiffHunk[]; unified?: boolean }) {
  if (unified) {
    return (
      <div className="overflow-x-auto font-mono text-xs leading-5">
        {/* `min-w-max` is the whole point: it lets the content be wider than the
            scroller, which is what makes `overflow-x-auto` reachable. The split
            view below is `w-full table-fixed` inside the same wrapper, so it can
            never overflow — that is why it wraps one character at a time on a
            phone. Block children stretch to this width, so a short added line
            still paints its background across the full scrolled row. */}
        <div className="min-w-max whitespace-pre">
          {hunks.map((hunk, hi) => (
            <div key={hi}>
              <div className="px-2 py-0.5 text-faint bg-surface-2 select-none">{hunk.header}</div>
              {hunk.lines.map((line, li) => (
                <UnifiedLine key={li} line={line} />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto font-mono text-xs leading-5">
      {hunks.map((hunk, hi) => (
        <div key={hi}>
          <div className="px-2 py-0.5 text-faint bg-surface-2 select-none">{hunk.header}</div>
          <table className="w-full table-fixed border-collapse">
            <tbody>
              {buildSplitRows(hunk.lines).map((row, ri) => (
                <tr key={ri}>
                  <Side line={row.left} no={row.left?.oldNo ?? null} />
                  <Side line={row.right} no={row.right?.newNo ?? null} divider />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
