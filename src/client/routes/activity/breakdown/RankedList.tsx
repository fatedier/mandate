import stringWidth from "string-width";
import { cn } from "@/lib/utils";
import type { RankedRow } from "../breakdown-model";

/**
 * Groups in order, each a bar against the first: its name, the bar, its
 * figure. A row opens its group's log, as a table row does.
 *
 * Every row shares one name column, as wide as the list's longest name (in
 * the monospace face's columns, a wide character two) and at most half the
 * row, so names show whole where there is room and the bars start at one
 * edge; a name longer than that is cut, whole on hover.
 */
export function RankedList({ rows, tone, onSelect }: {
  rows: RankedRow[];
  tone: "spend" | "fail";
  onSelect: (key: string) => void;
}) {
  const top = rows[0]?.value ?? 0;
  const longest = Math.max(1, ...rows.map((row) => stringWidth(row.label)));
  const columns = `minmax(0, min(${longest}ch, 50%)) minmax(0, 1fr) auto`;
  return (
    <ul className="flex flex-col py-1.5">
      {rows.map((row) => (
        <li key={row.key}>
          <button
            type="button"
            data-ranked-row={row.key}
            title={row.title}
            aria-label={`${row.title}: ${row.display}`}
            onClick={() => onSelect(row.key)}
            // Set in the names' face, so `ch` is one of their columns.
            style={{ gridTemplateColumns: columns }}
            className="grid w-full items-center gap-2 px-3.5 py-1 text-left font-mono text-2xs hover:bg-sel focus-visible:bg-sel focus-visible:outline-none pointer-coarse:min-h-11"
          >
            <span className="truncate text-foreground">{row.label}</span>
            <span aria-hidden className="h-2.5">
              <span
                className={cn("block h-full min-w-0.5 rounded-r-sm", tone === "fail" ? "bg-destructive" : "bg-chart-1")}
                style={{ width: `${top > 0 ? (row.value / top) * 100 : 0}%` }}
              />
            </span>
            <span className="num text-right font-sans text-muted-foreground">{row.display}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
